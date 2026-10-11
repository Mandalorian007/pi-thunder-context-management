// The extension in an SDK host that works in slices: it ends a run after a
// tool turn, keeps the session's entries, and carries on later in a fresh
// process from those entries, as ThunderFoundry does in Convex. Pi 1.x only:
// 0.84.4 has no way to restore a session from entries or end a run after a
// turn. Against a scripted model, no model spend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContextManager, type ContextEvent, type ContextRules } from "../index.ts";
import { startFakeModel } from "./fake-model.ts";

const ROOT = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version as string;
const skip = Number(version.split(".")[0]) < 1 ? `Pi ${version} cannot restore a session from entries` : false;

const OFF = 1e9;
// The 1.x hooks this test uses, typed here so it also typechecks against 0.84.4.
type Turn = { toolResults: unknown[] };
type FinishTurn = (turn: Turn, signal?: AbortSignal) => Promise<{ action: "end" | "continue" } | undefined | void>;
type Restorable = { inMemory: (cwd: string, options: undefined, entries?: unknown[]) => unknown };

const RULES: Partial<ContextRules> = { pruneAt: 3_000, hardCap: OFF, compactFloor: OFF, keepRecentTokens: 500, minPruneTokens: 2_000, headChars: 50, coldAfterMs: 60 * 60_000 };

test("a host that stops right after a commit still prunes when it carries on", { skip }, async () => {
  process.env.PI_OFFLINE = "1";
  const pi = await import("@earendil-works/pi-coding-agent");
  const fake = await startFakeModel({ tasks: 6, padding: 6_000, obeyFrom: "never" });
  const work = mkdtempSync(join(tmpdir(), "pi-sdk-"));
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
  const events: ContextEvent[] = [];

  const open = async (entries?: unknown[]) => {
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const model = modelRuntime.getModel("fake", "builder");
    assert.ok(model);
    const settingsManager = pi.SettingsManager.inMemory({});
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: work,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "context", factory: createContextManager({ rules: RULES, log: (e) => events.push(e) }) }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({
      cwd: work,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: (pi.SessionManager as unknown as Restorable).inMemory(work, undefined, entries) as never,
    });
    // In the SDK, extensions hear session_start only from bindExtensions.
    await session.bindExtensions({});
    return session;
  };

  try {
    const first = await open();
    const agent = first.agent as unknown as { finishTurn?: FinishTurn };
    const inner = agent.finishTurn;
    agent.finishTurn = async (turn, signal) => {
      const decision = await inner?.(turn, signal);
      // Stop right after the first commit made with the context past
      // pruneAt, as a slice that runs out of time there would.
      const over = (first.getContextUsage()?.tokens ?? 0) > RULES.pruneAt!;
      return turn.toolResults.length && over ? { action: "end" as const } : (decision ?? undefined);
    };
    await first.prompt('Do six tasks. Commit each as "task N".');
    const entries = [first.sessionManager.getHeader(), ...first.sessionManager.getEntries()];
    first.dispose();
    const before = fake.seen.length;
    assert.ok(!events.some((e) => e.event === "pruned"), "nothing is pruned before the restart");

    const second = await open(entries);
    await (second as unknown as { _runAgentPrompt: (m: unknown[]) => Promise<void> })._runAgentPrompt([]);
    second.dispose();

    assert.ok(fake.seen[before].stubs > 0, `the first call after the restart is pruned: ${JSON.stringify(events)}`);
    assert.equal(events.find((e) => e.event === "pruned")?.reason, "boundary");
  } finally {
    fake.close();
  }
});
