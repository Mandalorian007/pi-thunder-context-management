# pi-thunder-context-management

Context management for long-running [Pi](https://pi.dev) agents. A coordinator that runs for days, or a worker that runs for hours, spends most of its money re-reading its own context. This extension keeps that context small:
- It prunes deeply at task boundaries.
- It prunes again whenever the prompt cache has expired anyway.
- It asks the agent to compact only when pruning is no longer enough.

It is one extension, it needs no custom runner, and it works the same in a coordinator and in every subagent process.

In live runs, against Pi with nothing added (Sonnet 5.5, a 10-task chain on a real TypeScript repo, graded by hidden tests):

| pacing | cost against stock Pi | tests |
|---|---|---|
| Tasks back-to-back | **−20%** | 29/30 (the one failure was a staging slip, not lost context) |
| One task per prompt, 6 minutes apart, as a coordinator hands out work | **−74%** | 20/20 |

## Install

```sh
pi install git:github.com/Mandalorian007/pi-thunder-context-management         # every pi process for this user
pi install git:github.com/Mandalorian007/pi-thunder-context-management -l      # this project only (.pi/settings.json)
pi -e git:github.com/Mandalorian007/pi-thunder-context-management              # try it for one run
```

Pin a version with `@v0.1.0`. A user install is loaded by every `pi` process, so subagents spawned as `pi` subprocesses get it too.

A project install (`-l`) is the simplest way to cover containers and CI. Pi installs a package listed in `.pi/settings.json` on startup once the project is trusted.

From the SDK (the package is TypeScript source, as Pi packages are: import it from a TypeScript-aware runtime such as `tsx`, or vendor the two files):

```ts
import { createContextManager } from "pi-thunder-context-management";

const loader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  extensionFactories: [{ name: "context", factory: createContextManager({ rules: { coldAfterMs: 60 * 60_000 }, log: console.log }) }],
});
```

Leave Pi's own auto-compaction at its default (window − 16K). With a 1M window it never fires before these rules do, and it stays as the last resort.

## The rules

| | When | What |
|---|---|---|
| 1 | A task boundary with context over `pruneAt`. A boundary is a successful `git commit`, or a result from a tool in `boundaryTools` | **Boundary prune**: everything before the boundary turns into stubs (details below) |
| 2 | No call for `coldAfterMs` (the cache lifetime) | **Cold prune**: prune whatever can be pruned, however little. The cache has expired, so the next call rewrites everything anyway, and pruning first costs nothing extra |
| 3 | Over `hardCap` in the middle of a task | **Cap prune**: everything but the last `keepRecentTokens` |
| 4 | After a boundary or cold prune, what is left is more than `compactFloor` above the fixed prefix | **Ask the agent once** to `compact` with its own summary |
| 5 | Still over `hardCap` after pruning | **"Compact now"**. After `graceTurns` more turns, the harness replaces the history with a mechanical digest: commits, files written, and the agent's last words. No model call |

A pruned turn looks like this:
- Tool output keeps its first 200 characters, plus a note to run the call again if it is needed.
- The agent's thinking is dropped.
- Tool-call arguments over 500 characters keep only their first 200 characters.

The agent still sees what it did and can redo any part of it.

Prunes are batched. A warm prune must remove at least `minPruneTokens`, because any change to old context makes the provider rewrite its cache from that point on. Between decisions, what is sent is deterministic, so each request extends the previous one and the cached prefix holds.

There is deliberately no gentle "consider compacting" nudge: agents ignored it 4 times in 5.

### The `compact` tool

`compact({ summary })`. From the agent's next step, its context is:
- the original brief, word for word;
- its summary;
- everything from the compact call on.

The run carries on without a restart.

The tool's guidance tells the agent:
- what to keep in a summary (state of the work, decisions, paths worth re-reading, next steps);
- to re-read only what the next step needs;
- not to block in one command for more than about 4 minutes, so a 5-minute cache doesn't expire in the middle of a wait.

### `/context`

Shows the context size at the last call, the fixed prefix, prunes and compactions so far, and the rules in force.

## Configuration

Through the SDK, pass `createContextManager({ rules, log })`. As an installed package, set environment variables:
- `PI_CONTEXT_RULES`: a JSON object of overrides. It passes down to subagent processes automatically.
- `PI_CONTEXT_LOG`: a file path. It gets one JSON line per prune, nudge and compaction.

```sh
PI_CONTEXT_RULES='{"coldAfterMs":3600000}' pi      # on Anthropic's 1-hour cache
```

| rule | default | |
|---|---|---|
| `pruneAt` | 100000 | Boundary prune once context is over this many tokens |
| `hardCap` | 130000 | Prune mid-task above this, then insist on compaction |
| `compactFloor` | 40000 | Ask for a compaction once what pruning leaves is this far above the fixed prefix |
| `graceTurns` | 3 | Turns after "compact now" before the digest |
| `coldAfterMs` | 300000 | The provider's cache lifetime: 5 minutes by default, 60 minutes for Anthropic's 1-hour cache |
| `keepRecentTokens` | 8000 | What a cap prune or a digest keeps verbatim at the end |
| `minPruneTokens` | 20000 | The smallest warm prune worth doing |
| `headChars` | 200 | Characters kept from each pruned output or argument |
| `argsOver` | 500 | Tool-call arguments longer than this are cut when pruned (0 keeps them) |
| `dropThinking` | true | Drop the thinking of pruned turns |
| `boundaryTools` | `["subagent"]` | Tools whose successful result is a task boundary |
| `maxSummaryChars` | 32000 | Longer summaries are refused |

## How it works

Nothing edits the session. The extension uses Pi's `context` hook to build what the model is sent from the session's messages and its own decisions (`view.ts`):
- Pruning swaps in stubs.
- A compaction replaces everything between the brief and the compact call with the summary.

Each decision is saved in the session as a custom entry and replayed on `session_start`. So the extension:
- needs no runner;
- works mid-turn and in every Pi mode (interactive, print, JSON, RPC, SDK);
- sends exactly the same view after a restart.

A cut never reaches into the latest turn. The model has not seen that turn's results yet, and the API needs its thinking while its tool loop is still running.

## Why these rules

The rules come from two sets of experiments:
- **Live runs:** Pi 0.84.4 and Sonnet 5.5, over about $48 of model spend.
- **An offline replay of 203 recorded Claude Code sessions:** 3 coordinators and 200 subagents, 37K API calls, about 844 wall hours. The replay modelled baseline cost to within 0.14% of logged usage.

What they showed:

- **Cache reads of the resident context are most of the bill.** Contexts in the recorded sessions reached a median peak of 342K.
  - Compacting near 100K cost 36–56% of baseline in the replay.
  - Deep pruning (tool output, thinking and long arguments), with compaction as the backstop, cost within about 1 point of that, with 4–7× fewer summaries for the agent to write.
- **Pruning tool output alone is not enough.** Tool output is only 31–52% of what stays in context; thinking (16–18%) and tool-call arguments (14–15%) are most of the rest.
- **What a prune leaves grows by 240–360 tokens a call**, so pruning alone eventually stops working. That is why compaction stays as the backstop.
- **A cold cache is free to prune.**
  - With one task every 6 minutes, stock Pi rewrote about 110K of expired cache at every task: $3.21 against $0.84 with the extension.
  - In the recorded sessions, rewrites after gaps over 5 minutes were 34% of coordinator cost.
- **Batch, don't trickle.** Pruning a little on every call rewrites the cache every call: 83–134% of baseline in the replay.
- **Read-backs are cheap in tokens, not in calls.** After a prune, agents read back 3–14K tokens of the roughly 95K dropped, in targeted reads. The real cost is the 3–14 extra calls. Hence prunes are rare and deep, and the agent is told to re-read only what the next step needs.
- **The fixed prefix matters.** Claude Code's system prompt and tools (32–56K tokens) cost 8–16% of its baseline; Pi's is about 4K.

**Not yet exercised live:**
- the compaction backstop under real pressure (10-task sessions never reached it);
- real subagent trees;
- multi-day sessions.

**Not included:** keep-alive pings during long idle gaps. The replay puts them at 11–21% saving on their own, but they need a provider call outside the agent loop, so they belong in the runner.

## Development

```sh
npm install
npm test          # the view functions, and the real pi CLI against a scripted model (no spend)
npm run typecheck
```

Pi loads `.ts` directly, so there is no build step. `@earendil-works/pi-coding-agent` and `typebox` are peer dependencies; Pi provides both to extensions at runtime.

## License

MIT
