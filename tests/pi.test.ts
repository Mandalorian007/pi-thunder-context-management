// The extension end to end: the real `pi` CLI, loading ./index.ts the way an
// installed package or a subagent process does, against a scripted model, in a
// real git repository. No model spend. Thresholds are tiny (rules come from
// PI_CONTEXT_RULES) so a handful of turns crosses them; each task's output is
// about 1.5K tokens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContextRules } from "../index.ts";
import { startFakeModel, type Script } from "./fake-model.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OFF = 1e9;
const BASE: Partial<ContextRules> = { pruneAt: 3_000, hardCap: OFF, compactFloor: OFF, keepRecentTokens: 500, minPruneTokens: 2_000, headChars: 50, coldAfterMs: 60 * 60_000 };
const BRIEF = 'Do six tasks. Commit each as "task N".';

async function session(script: Script, rules: Partial<ContextRules>) {
  const fake = await startFakeModel(script);
  const work = mkdtempSync(join(tmpdir(), "pi-context-"));
  execFileSync("git", ["init", "-q"], { cwd: work });
  const agentDir = join(work, ".agent");
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: fake.url,
          apiKey: "test",
          models: [{ id: "builder", name: "builder", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8_000 }],
        },
      },
    }),
  );
  const log = join(work, "context.jsonl");
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_CONTEXT_RULES: JSON.stringify({ ...BASE, ...rules }),
    PI_CONTEXT_LOG: log,
  };
  // stdin closed: in print mode pi reads a piped stdin as part of the prompt.
  const pi = (args: string[]) =>
    new Promise<string>((done, fail) => {
      const p = spawn(
        join(ROOT, "node_modules/.bin/pi"),
        ["-p", "--session-dir", join(work, "sessions"), "-e", join(ROOT, "index.ts"), "--provider", "fake", "--model", "builder", ...args],
        { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => p.kill(), 60_000);
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) done(out);
        else fail(new Error(`pi exited ${code}: ${out}`));
      });
    });
  const events = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const commits = () => execFileSync("git", ["log", "--format=%s"], { cwd: work, encoding: "utf8" }).trim().split("\n").filter((s) => /^task \d+/.test(s)).length;
  return { pi, seen: fake.seen, events, commits, close: fake.close };
}

// Requests that do not extend the one before: each is a full cache rewrite.
function rewrites(seen: { sent: string[] }[]) {
  let n = 0;
  for (let i = 1; i < seen.length; i++) if (!seen[i - 1].sent.every((m, j) => seen[i].sent[j] === m)) n += 1;
  return n;
}

test("at a boundary over pruneAt, everything before it is pruned, and the prefix holds between prunes", async () => {
  const s = await session({ tasks: 8, padding: 6_000, obeyFrom: "never" }, {});
  try {
    await s.pi([BRIEF]);
    assert.equal(s.commits(), 8);
    const pruned = s.events().filter((e) => e.event === "pruned");
    assert.ok(pruned.length >= 2 && pruned.every((e) => e.reason === "boundary"), JSON.stringify(s.events()));
    assert.ok(s.seen.at(-1)!.stubs >= 6, `stubs on the last call: ${s.seen.at(-1)!.stubs}`);
    assert.ok(Math.max(...s.seen.map((x) => x.chars)) < 8 * 6_000, "context never holds every output");
    assert.equal(rewrites(s.seen), pruned.length, "only a prune may change what was already sent");
  } finally {
    s.close();
  }
});

test("below minPruneTokens a warm prune is skipped", async () => {
  const s = await session({ tasks: 6, padding: 6_000, obeyFrom: "never" }, { minPruneTokens: OFF });
  try {
    await s.pi([BRIEF]);
    assert.ok(s.events().some((e) => e.event === "prune_skipped"));
    assert.ok(!s.events().some((e) => e.event === "pruned"));
  } finally {
    s.close();
  }
});

test("past the floor the agent is asked once to compact, and its summary replaces the history", async () => {
  const s = await session({ tasks: 8, padding: 6_000, obeyFrom: "firm" }, { compactFloor: 200 });
  try {
    await s.pi([BRIEF]);
    assert.equal(s.commits(), 8);
    const events = s.events();
    assert.equal(events.find((e) => e.event === "nudge")?.level, "firm");
    assert.ok(events.some((e) => e.event === "compacted" && e.by === "agent"), JSON.stringify(events));
    const after = s.seen.findIndex((x) => x.sent.some((m) => m.includes("Your summary from before compaction")));
    assert.ok(after > 0);
    // System, brief, summary, the compact call and its result.
    assert.ok(s.seen[after].messages <= 5, String(s.seen[after].messages));
    assert.ok(s.seen[after].sent.some((m) => m.includes("Do six tasks")), "the brief is kept verbatim");
  } finally {
    s.close();
  }
});

test("an agent that ignores 'compact now' past the cap gets the harness's digest", async () => {
  // headChars this large leaves nothing worth pruning, so only compaction can help.
  const s = await session({ tasks: 8, padding: 6_000, obeyFrom: "never" }, { pruneAt: OFF, hardCap: 4_000, headChars: 1e6, graceTurns: 2 });
  try {
    await s.pi([BRIEF]);
    assert.equal(s.commits(), 8);
    const events = s.events();
    assert.equal(events.find((e) => e.event === "nudge")?.level, "immediate");
    assert.ok(events.some((e) => e.event === "compacted" && e.by === "harness"), JSON.stringify(events));
    const digested = s.seen.find((x) => x.sent.some((m) => m.includes("Harness digest")));
    assert.ok(digested?.sent.some((m) => m.includes('\\"task 1\\"')), "the digest names the commits");
  } finally {
    s.close();
  }
});

test("after the cache has gone cold, the next call prunes whatever it can", async () => {
  const s = await session({ tasks: 3, padding: 6_000, obeyFrom: "never" }, { pruneAt: OFF, minPruneTokens: OFF, coldAfterMs: 300 });
  try {
    await s.pi([BRIEF]);
    assert.ok(!s.events().some((e) => e.event === "pruned"));
    await new Promise((r) => setTimeout(r, 600));
    await s.pi(["--continue", "Anything left?"]);
    const pruned = s.events().filter((e) => e.event === "pruned");
    assert.ok(pruned.length === 1 && pruned[0].reason === "cold", JSON.stringify(s.events()));
  } finally {
    s.close();
  }
});

test("a restarted session (--continue) sends the same view it sent before", async () => {
  const s = await session({ tasks: 4, padding: 6_000, obeyFrom: "never" }, {});
  try {
    await s.pi(['Do four tasks. Commit each as "task N".']);
    const before = s.seen.length;
    const stubs = s.seen.at(-1)!.stubs;
    assert.ok(stubs >= 2, `stubs before the restart: ${stubs}`);
    await s.pi(["--continue", "Anything left?"]);
    assert.equal(s.seen[before].stubs, stubs);
  } finally {
    s.close();
  }
});
