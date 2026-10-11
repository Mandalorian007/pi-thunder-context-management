// Context management for long-running Pi agents, as one Pi extension.
//
// Install it as a Pi package (`pi install git:github.com/Mandalorian007/pi-thunder-context-management`)
// and every `pi` process loads it, subagents included; or `pi -e ./index.ts`
// for one run; or `createContextManager()` in an SDK loader's
// extensionFactories. It needs no runner: every reduction is applied to what
// the model is sent (view.ts), so it works mid-turn, in every mode, and survives
// a restart (its decisions are saved in the session as custom entries).
//
// The rules, from the experiments summarised in README.md:
//   1. Boundary prune. After a task boundary (a successful `git commit`, or a
//      subagent's result) with context over `pruneAt`, everything before the
//      boundary is pruned: old tool output to stubs, and the agent's side of
//      those turns without thinking or long arguments. No model call, nothing
//      asked of the agent, and it rewrites only what is left (a few K).
//   2. Cold prune. When the prompt cache has expired anyway (no call for
//      `coldAfterMs`), prune whatever is prunable: the rewrite is already paid.
//   3. Cap prune. Past `hardCap` mid-task, prune all but the last
//      `keepRecentTokens`.
//   4. Agent compaction as the backstop. What pruning leaves (the agent's
//      reasoning, small calls, reports) grows by a few hundred tokens a call.
//      When it passes `compactFloor` over the fixed prefix, at a boundary or on
//      a cold cache, the agent is asked once to `compact` with its own summary.
//      Past `hardCap` even after pruning, it is told to compact now; after
//      `graceTurns` more turns the harness replaces the history with a
//      mechanical digest instead.
// Prunes are batched (`minPruneTokens`) because each one rewrites the cache
// from the first changed message on.

import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { anchorAt, callIds, cutIndex, digest, render, tokensOf, worthPruning, type Compaction, type Message, type ViewState } from "./view.ts";

export type ContextRules = {
  // Prune at a task boundary once context is over this.
  pruneAt: number;
  // Never above this for long: prune mid-task, then insist on compaction.
  hardCap: number;
  // Ask for a compaction once what pruning leaves is this far over the prefix.
  compactFloor: number;
  // Turns after "compact now" before the harness compacts with a digest.
  graceTurns: number;
  // The provider's prompt-cache lifetime: after this long idle, the next call
  // rewrites everything anyway. 5 minutes for Anthropic's default, 60 for the
  // 1-hour cache.
  coldAfterMs: number;
  // What a cap prune or a forced compaction keeps verbatim at the end.
  keepRecentTokens: number;
  // A warm prune must remove at least this much, or it costs more than it saves.
  minPruneTokens: number;
  // Characters kept at the head of each pruned output or argument.
  headChars: number;
  // Tool-call arguments longer than this are cut to their head when pruned.
  argsOver: number;
  dropThinking: boolean;
  // Tools whose successful result is a task boundary, besides `git commit`.
  boundaryTools: string[];
  // A summary longer than this (characters) is a transcript, and is refused.
  maxSummaryChars: number;
};

export const DEFAULT_RULES: ContextRules = {
  pruneAt: 100_000,
  hardCap: 130_000,
  compactFloor: 40_000,
  graceTurns: 3,
  coldAfterMs: 5 * 60_000,
  keepRecentTokens: 8_000,
  minPruneTokens: 20_000,
  headChars: 200,
  argsOver: 500,
  dropThinking: true,
  boundaryTools: ["subagent"],
  maxSummaryChars: 32_000,
};

export type ContextEvent = Record<string, unknown> & { event: string };

const ENTRY = "context-manager";
type Entry =
  | { kind: "prefix"; tokens: number }
  | { kind: "prune"; reason: string; results: string[]; calls: string[] }
  | ({ kind: "compact" } & Compaction)
  // A nudge is remembered, so a restarted session is not asked twice and keeps
  // counting its grace turns. "clear" is the cap's warning lifted.
  | { kind: "nudge"; level: "firm" | "immediate" | "clear"; turn: number }
  // A prune decided at a turn's end and made at the next call. Kept, so a
  // host that stops after a tool turn and restarts (an SDK host working in
  // slices) still makes it; no reason is the decision made.
  | { kind: "due"; reason?: "boundary" | "cap"; boundary?: string };

const COMMIT = /\bgit\b[^|;&]*\bcommit\b/;

// What the agent is told about compaction. Pi adds a tool's guidelines only to
// its own default system prompt, so a host that writes its own system prompt
// (an SDK session) should append these itself.
export const COMPACT_GUIDE = [
  "Use compact when you finish a standalone piece of work and what comes next does not need the detail of what you read or ran. Your context becomes the brief, your summary, and what follows; files and command output can always be re-read.",
  "In a compact summary keep: the state of the work (branch, commits, what passes and fails), decisions and why, file paths with line ranges worth re-reading, open threads, and the next steps. Leave out file contents and command output.",
  "The harness also trims old tool output by itself. An output marked as pruned by the harness can be had again by running the call again.",
  "After compacting or pruning, re-read only what the next step needs, not everything you had before.",
  "Don't block in one command for more than about 4 minutes (an until/sleep loop on a background job, say): poll in shorter calls instead, so the prompt cache stays warm.",
];

const nudgeText = {
  firm: (k: number) =>
    `[context: ${k}K tokens] Context is getting large, and most of it is no longer old tool output the harness can trim. This piece of work is done: call \`compact\` with a summary before starting the next one. Keep what the next work needs; files can be re-read.`,
  immediate: (k: number, grace: number) =>
    `[context: ${k}K tokens] Context is at its limit. Finish the step you are on (commit if you have changes), then call \`compact\`. If you don't within ${grace} turns, the harness replaces your history with a mechanical digest.`,
};

export function createContextManager(options: { rules?: Partial<ContextRules>; log?: (e: ContextEvent) => void } = {}): ExtensionFactory {
  const rules = { ...DEFAULT_RULES, ...options.rules };
  const log = options.log ?? (() => {});
  const view = { headChars: rules.headChars, argsOver: rules.argsOver, dropThinking: rules.dropThinking };

  return (pi: ExtensionAPI) => {
    const state: ViewState = { pruned: new Set(), prunedCalls: new Set() };
    let prefix = 0;
    let turn = 0;
    // Real tokens over estimated, from the last call.
    let scale = 1;
    let lastReal = 0;
    // Bumped on every change of state; a call's usage counts only if the call
    // was sent with the current state.
    let version = 0;
    let sentVersion = 0;
    // The boundary seen this turn, and the one a prune is due at.
    let boundaryId: string | undefined;
    let dueBoundary: string | undefined;
    let due: "boundary" | "cap" | undefined;
    let nudged: { firm?: boolean; immediateAt?: number } = {};
    // For /context.
    const stats = { prunes: 0, prunedTokens: 0, compactions: 0, lastTokens: 0 };

    const save = (e: Entry) => {
      pi.appendEntry(ENTRY, e);
      version += 1;
    };
    const apply = (e: Entry) => {
      if (e.kind === "prefix") prefix = e.tokens;
      if (e.kind === "prune") {
        for (const id of e.results) state.pruned.add(id);
        for (const id of e.calls) state.prunedCalls.add(id);
        stats.prunes += 1;
      }
      if (e.kind === "compact") {
        state.compaction = { anchor: e.anchor, text: e.text, by: e.by };
        nudged = {};
        stats.compactions += 1;
      }
      if (e.kind === "due") {
        due = e.reason;
        dueBoundary = e.boundary;
      }
      if (e.kind === "nudge") {
        if (e.level === "firm") nudged.firm = true;
        if (e.level === "immediate") nudged.immediateAt = e.turn;
        if (e.level === "clear") nudged.immediateAt = undefined;
      }
    };

    // A pending prune changes nothing yet, so recording it leaves the state's
    // version alone.
    const remember = (e: Entry) => {
      apply(e);
      pi.appendEntry(ENTRY, e);
    };

    pi.on("session_start", async (_event, ctx) => {
      for (const e of ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: Entry; message?: { role?: string } }[]) {
        if (e.type === "custom" && e.customType === ENTRY && e.data) apply(e.data);
        // Turns are counted from the session, so grace runs on across a restart.
        if (e.type === "message" && e.message?.role === "assistant") turn += 1;
      }
      // The last call's real size, so the first estimate after a restart is
      // scaled like the rest.
      lastReal = ctx.getContextUsage()?.tokens ?? 0;
    });

    pi.registerTool({
      name: "compact",
      label: "Compact",
      description:
        "Replace your context with a summary you write, to keep context small and cheap. From your next step your context is the original brief, your summary, and this call onward.",
      promptSnippet: "Compact your own context with a summary you write",
      promptGuidelines: COMPACT_GUIDE,
      parameters: Type.Object({
        summary: Type.String({ description: "What the next work needs, in your words." }),
      }),
      async execute(toolCallId, params) {
        if (params.summary.length > rules.maxSummaryChars) {
          log({ event: "compact_rejected", chars: params.summary.length });
          return {
            content: [{ type: "text", text: `Summary is ${params.summary.length} characters; keep it under ${rules.maxSummaryChars}. Drop file contents and output, keep pointers.` }],
            details: {},
          };
        }
        const e: Entry = { kind: "compact", anchor: toolCallId, text: params.summary, by: "agent" };
        apply(e);
        save(e);
        log({ event: "compacted", by: "agent", summaryChars: params.summary.length, turn });
        return { content: [{ type: "text", text: "Compacted. Carry on from your summary." }], details: {} };
      },
    });

    pi.registerCommand("context", {
      description: "Show what context management has done in this session, and its rules",
      handler: async (_args, ctx) => {
        const k = (n: number) => `${Math.round(n / 1000)}K`;
        const lines = [
          `context: ${k(stats.lastTokens)} at the last call (fixed prefix ${k(prefix)})`,
          `prunes: ${stats.prunes} (${k(stats.prunedTokens)} removed in this process), compactions: ${stats.compactions}${state.compaction ? ` (latest by the ${state.compaction.by})` : ""}`,
          `rules: prune at ${k(rules.pruneAt)} at a boundary, cold after ${Math.round(rules.coldAfterMs / 60_000)} min, cap ${k(rules.hardCap)}, compact past prefix + ${k(rules.compactFloor)}`,
        ];
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
        else console.log(lines.join("\n"));
      },
    });

    pi.on("tool_result", async (event) => {
      if (event.isError) return;
      const command = (event.input as { command?: string }).command;
      if ((typeof command === "string" && COMMIT.test(command)) || rules.boundaryTools.includes(event.toolName)) boundaryId = event.toolCallId;
    });

    pi.on("turn_end", async (_event, ctx) => {
      turn += 1;
      const tokens = ctx.getContextUsage()?.tokens ?? 0;
      const boundary = boundaryId;
      boundaryId = undefined;
      // Usage from a call sent before the state last changed describes a
      // context that is gone.
      if (sentVersion !== version || !tokens) return;
      lastReal = tokens;
      stats.lastTokens = tokens;
      if (!prefix) {
        const e: Entry = { kind: "prefix", tokens };
        apply(e);
        save(e);
        sentVersion = version;
      }
      if (boundary && tokens > rules.pruneAt) remember({ kind: "due", reason: "boundary", boundary });
      else if (tokens > rules.hardCap) remember({ kind: "due", reason: "cap" });
    });

    pi.on("context", async (event) => {
      const messages = event.messages as unknown as Message[];
      let shown = render(messages, state, view);
      const estimated = shown.reduce((n, m) => n + tokensOf(m), 0);
      if (lastReal && estimated) scale = Math.min(3, Math.max(1, lastReal / estimated));
      lastReal = 0;
      const size = (m: Message) => tokensOf(m) * scale;

      const lastCall = messages.findLast((m) => m.role === "assistant")?.timestamp ?? 0;
      const cold = lastCall > 0 && Date.now() - lastCall > rules.coldAfterMs;
      const reason = due ?? (cold ? "cold" : undefined);
      const boundary = due === "boundary" ? dueBoundary : undefined;
      if (due) remember({ kind: "due" });

      if (reason) {
        // Cut within what is shown, so a compaction's dropped turns are not counted.
        const cut = cutIndex(shown, rules.keepRecentTokens, size, boundary);
        const results = shown
          .slice(0, cut)
          .filter((m) => m.role === "toolResult" && m.toolCallId && !state.pruned.has(m.toolCallId) && worthPruning(m, rules.headChars));
        const gain = results.reduce((n, m) => n + size(m), 0);
        // On a cold cache everything is rewritten anyway, so any gain is a gain.
        if (gain > 0 && gain >= (reason === "cold" ? 1 : rules.minPruneTokens)) {
          const calls = shown.slice(0, cut).flatMap(callIds).filter((id) => !state.prunedCalls.has(id));
          const e: Entry = { kind: "prune", reason, results: results.map((m) => m.toolCallId!), calls };
          apply(e);
          save(e);
          shown = render(messages, state, view);
          stats.prunedTokens += gain;
          log({ event: "pruned", reason, count: results.length, tokensPruned: Math.round(gain), turn });
        } else if (reason !== "cold") {
          log({ event: "prune_skipped", reason, tokensPrunable: Math.round(gain), turn });
        }
      }

      // What is left decides whether the agent is asked to compact.
      // (Scaled by real over estimated, so this includes the system prompt and tools.)
      const left = shown.reduce((n, m) => n + size(m), 0);
      const k = Math.round(left / 1000);
      let nudge: string | undefined;
      if (left > rules.hardCap) {
        if (nudged.immediateAt === undefined) {
          const e: Entry = { kind: "nudge", level: "immediate", turn };
          apply(e);
          save(e);
          nudge = nudgeText.immediate(k, rules.graceTurns);
          log({ event: "nudge", level: "immediate", tokens: Math.round(left), turn });
        } else if (turn - nudged.immediateAt >= rules.graceTurns) {
          const cut = cutIndex(shown, rules.keepRecentTokens, size);
          const anchor = anchorAt(shown, cut);
          if (anchor) {
            const at = shown.findIndex((m) => callIds(m).includes(anchor));
            // A summary the agent wrote earlier is still the best account of what came before it.
            const earlier = state.compaction ? `${state.compaction.text}\n\nSince then:\n` : "";
            const e: Entry = { kind: "compact", anchor, text: earlier + digest(shown.slice(0, at)), by: "harness" };
            apply(e);
            save(e);
            shown = render(messages, state, view);
            log({ event: "compacted", by: "harness", turn });
          }
        }
      } else if (nudged.immediateAt !== undefined) {
        // Back under the cap (a cap prune did it): a later breach is warned afresh.
        const e: Entry = { kind: "nudge", level: "clear", turn };
        apply(e);
        save(e);
      }
      if (left <= rules.hardCap && (reason === "boundary" || reason === "cold") && left > prefix + rules.compactFloor && !nudged.firm) {
        const e: Entry = { kind: "nudge", level: "firm", turn };
        apply(e);
        save(e);
        nudge = nudgeText.firm(k);
        log({ event: "nudge", level: "firm", tokens: Math.round(left), turn });
      }

      sentVersion = version;
      // A nudge rides on this call only and is never saved, so the history (and
      // its cached prefix) is what it would have been without it.
      if (nudge) shown = [...shown, { role: "custom", customType: "context-nudge", content: nudge, display: false, timestamp: Date.now() }];
      return { messages: shown as unknown as typeof event.messages };
    });
  };
}

// Loaded as a file (`pi -e`, or from an extensions directory), the rules come
// from PI_CONTEXT_RULES, a JSON object of overrides, so a coordinator can set
// them for the subagents it spawns through their environment.
function rulesFromEnv(): Partial<ContextRules> {
  const raw = process.env.PI_CONTEXT_RULES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<ContextRules>;
  } catch {
    throw new Error(`PI_CONTEXT_RULES is not JSON: ${raw}`);
  }
}

// PI_CONTEXT_LOG, a file path, gets one JSON line per prune, nudge and compaction.
export default createContextManager({
  rules: rulesFromEnv(),
  log: process.env.PI_CONTEXT_LOG ? (e) => appendFileSync(process.env.PI_CONTEXT_LOG!, JSON.stringify({ t: Date.now(), ...e }) + "\n") : undefined,
});
