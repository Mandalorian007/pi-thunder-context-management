// What the model is sent, as a pure function of the session's messages and the
// manager's state. Nothing here edits the session: the session file keeps every
// message whole, and the view is rebuilt for each call from the same state, so
// between two changes of state each request extends the last and the cached
// prefix holds.
//
// Two reductions, both applied here:
//   prune    old tool output becomes a stub, and the agent's side of those
//            turns loses its thinking and the body of long arguments
//   compact  everything between the brief and an anchor tool call is replaced
//            by a summary (the agent's own, or the harness's digest)

export type Part = { type: string; id?: string; name?: string; text?: string; thinking?: string; arguments?: Record<string, unknown> };
export type Message = {
  role: string;
  toolCallId?: string;
  toolName?: string;
  content?: string | Part[];
  timestamp?: number;
  customType?: string;
  display?: boolean;
};

export type Compaction = { anchor: string; text: string; by: "agent" | "harness" };

export type ViewState = {
  // Tool results shown as stubs, by tool call id.
  pruned: Set<string>;
  // Tool calls whose assistant turn is shown without thinking or long arguments.
  prunedCalls: Set<string>;
  compaction?: Compaction;
};

export type ViewOptions = { headChars: number; argsOver: number; dropThinking: boolean };

// Characters / 4. It undercounts code by about a third, so callers scale it by
// the provider's real count (see `scale` in index.ts).
export function tokensOf(m: Message): number {
  if (typeof m.content === "string") return m.content.length / 4;
  return (m.content ?? []).reduce(
    (n, p) => n + ((p.text?.length ?? 0) + (p.thinking?.length ?? 0) + (p.arguments ? JSON.stringify(p.arguments).length : 0)) / 4,
    0,
  );
}

export const callIds = (m: Message): string[] =>
  m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "toolCall" && p.id).map((p) => p.id!) : [];

const textOf = (m: Message) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("\n") : (m.content ?? ""));

export function stubResult(m: Message, headChars: number): Message {
  const text = textOf(m);
  const head = text.slice(0, headChars).trimEnd();
  const note = `[Output pruned by the harness to keep context small (was ~${Math.round(text.length / 4)} tokens). Run the call again if you need it.]`;
  return { ...m, content: [{ type: "text", text: head ? `${head}${text.length > headChars ? " …" : ""}\n${note}` : note }] };
}

// The agent's side of a pruned turn. What it wrote is on disk, and the API needs
// thinking only for the turn in progress, which is never before a cut.
export function stubCall(m: Message, o: ViewOptions): Message {
  if (!Array.isArray(m.content)) return m;
  const content = m.content
    .filter((p) => !(o.dropThinking && p.type === "thinking"))
    .map((p) => {
      if (p.type !== "toolCall" || !o.argsOver || !p.arguments || JSON.stringify(p.arguments).length <= o.argsOver) return p;
      const args = Object.fromEntries(
        Object.entries(p.arguments).map(([k, v]) =>
          typeof v === "string" && v.length > o.headChars ? [k, `${v.slice(0, o.headChars)} …[pruned by the harness: was ${v.length} chars]`] : [k, v],
        ),
      );
      return { ...p, arguments: args };
    });
  return { ...m, content };
}

// Worth stubbing: an output shorter than its stub stays as it is.
export const worthPruning = (m: Message, headChars: number) => tokensOf(m) > 2 * tokensOf(stubResult(m, headChars));

function withoutSummary(m: Message, anchor: string): Message {
  if (!Array.isArray(m.content)) return m;
  return { ...m, content: m.content.map((p) => (p.type === "toolCall" && p.id === anchor ? { ...p, arguments: { summary: "(the summary above)" } } : p)) };
}

const anchorIndex = (messages: Message[], anchor: string) => messages.findIndex((m) => callIds(m).includes(anchor));

export function render(messages: Message[], state: ViewState, o: ViewOptions): Message[] {
  let out = messages;
  const c = state.compaction;
  const at = c ? anchorIndex(messages, c.anchor) : -1;
  if (c && at > 0) {
    // The brief is the first user message, kept verbatim: a brief paraphrased
    // five times stops being the brief.
    const brief = messages.slice(0, at).find((m) => m.role === "user");
    const heading = c.by === "agent" ? "## Your summary from before compaction" : "## Harness digest of the earlier work (you did not compact in time)";
    const summary: Message = { role: "custom", customType: "context-summary", content: `${heading}\n\n${c.text}`, display: false, timestamp: messages[at].timestamp };
    // The compact call itself stays (its result follows it), without the
    // summary it carried, which is now the message above.
    const call = c.by === "agent" ? withoutSummary(messages[at], c.anchor) : messages[at];
    out = [...(brief ? [brief] : []), summary, call, ...messages.slice(at + 1)];
  }
  if (!state.pruned.size && !state.prunedCalls.size) return out;
  return out.map((m) =>
    m.role === "toolResult" && m.toolCallId && state.pruned.has(m.toolCallId)
      ? stubResult(m, o.headChars)
      : callIds(m).some((id) => state.prunedCalls.has(id))
        ? stubCall(m, o)
        : m,
  );
}

// Where a prune or a forced compaction cuts: right after the boundary's tool
// result when there is one (everything up to it is finished work), otherwise
// before the last `keep` tokens, never letting one big message into the kept
// tail (one big old output is what pruning is for). Never past the latest
// assistant turn: the model has not seen its results yet, and the API needs
// that turn's thinking while its tool loop runs.
export function cutIndex(messages: Message[], keep: number, size: (m: Message) => number, boundaryCallId?: string): number {
  let latest = messages.length;
  while (latest > 0 && messages[latest - 1].role !== "assistant") latest -= 1;
  const limit = Math.max(0, latest - 1);
  if (boundaryCallId) {
    const at = messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === boundaryCallId);
    if (at >= 0) return Math.min(at + 1, limit);
  }
  let kept = 0;
  let cut = messages.length;
  while (cut > 0 && kept + size(messages[cut - 1]) <= keep) kept += size(messages[--cut]);
  return Math.min(cut, limit);
}

// A forced compaction's anchor: the first tool call at or after the cut, so the
// kept tail starts on an assistant turn; failing that, the latest one.
export function anchorAt(messages: Message[], cut: number): string | undefined {
  for (let i = Math.max(cut, 1); i < messages.length; i++) {
    const ids = callIds(messages[i]);
    if (ids.length) return ids[0];
  }
  for (let i = messages.length - 1; i > 0; i--) {
    const ids = callIds(messages[i]);
    if (ids.length) return ids[0];
  }
  return undefined;
}

// What the harness writes when the agent did not compact: mechanical, no model
// call. Commits, files touched, what the agent last said.
export function digest(messages: Message[]): string {
  const commits: string[] = [];
  const files = new Set<string>();
  const counts = new Map<string, number>();
  const said: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "text" && p.text?.trim()) said.push(p.text.trim().slice(0, 300));
      if (p.type !== "toolCall") continue;
      counts.set(p.name ?? "?", (counts.get(p.name ?? "?") ?? 0) + 1);
      const a = p.arguments ?? {};
      if (typeof a.path === "string" && (p.name === "write" || p.name === "edit")) files.add(a.path);
      if (typeof a.command === "string") {
        for (const x of a.command.matchAll(/git\b[^|;&]*\bcommit\b[^|;&]*-[a-z]*m\s*["']([^"']+)["']/g)) commits.push(x[1]);
        for (const x of a.command.matchAll(/(?:cat|tee)\s+>{1,2}\s*([\w./-]+)/g)) files.add(x[1]);
      }
    }
  }
  const lines = [
    `Earlier turns (${[...counts].map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}) were removed from your context. Re-read what you need.`,
    commits.length ? `Commits made: ${commits.map((c) => `"${c}"`).join(", ")}.` : "No commits were made.",
    files.size ? `Files written: ${[...files].join(", ")}.` : "",
    said.length ? `What you last said:\n${said.slice(-5).map((s) => `- ${s}`).join("\n")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
