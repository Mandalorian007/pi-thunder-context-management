// The view functions on their own: what the model is sent, given the session's
// messages and the manager's decisions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cutIndex, digest, render, tokensOf, type Message } from "../view.ts";

const msg = (role: string, rest: Partial<Message> = {}): Message => ({ role, content: [], ...rest });
const call = (id: string, command: string, extra: object[] = []) =>
  msg("assistant", { content: [...extra, { type: "toolCall", id, name: "bash", arguments: { command } }] as Message["content"] });
const result = (id: string, text: string) => msg("toolResult", { toolCallId: id, content: [{ type: "text", text }] });
const O = { headChars: 20, argsOver: 100, dropThinking: true };

test("view: a compaction keeps the brief, the summary, and the compact call without its summary", () => {
  const messages = [
    msg("user", { content: "the brief" }),
    call("a", "cat big", [{ type: "thinking", thinking: "hmm" }]),
    result("a", "x".repeat(5_000)),
    msg("assistant", { content: [{ type: "toolCall", id: "c", name: "compact", arguments: { summary: "S" } }] }),
    result("c", "Compacted."),
    call("d", "ls"),
  ];
  const out = render(messages, { pruned: new Set(), prunedCalls: new Set(), compaction: { anchor: "c", text: "S", by: "agent" } }, O);
  assert.deepEqual(out.map((m) => m.role), ["user", "custom", "assistant", "toolResult", "assistant"]);
  assert.match(String(out[1].content), /Your summary from before compaction\n\nS/);
  assert.deepEqual((out[2].content as { arguments?: object }[])[0].arguments, { summary: "(the summary above)" });
});

test("view: a pruned turn shows a stub, no thinking, and only the head of long arguments", () => {
  const messages = [msg("user", { content: "b" }), call("a", "y".repeat(500), [{ type: "thinking", thinking: "hmm" }]), result("a", "x".repeat(5_000))];
  const out = render(messages, { pruned: new Set(["a"]), prunedCalls: new Set(["a"]) }, O);
  assert.ok(tokensOf(out[2]) < 100);
  assert.deepEqual((out[1].content as { type: string }[]).map((p) => p.type), ["toolCall"]);
  assert.match(JSON.stringify(out[1].content), /pruned by the harness: was 500 chars/);
});

test("view: a boundary cut falls right after the commit; otherwise one big message is never kept", () => {
  const messages = [msg("user"), call("a", "x"), result("a", "z".repeat(40_000)), call("b", "git commit"), result("b", "ok"), call("c", "ls"), result("c", "f")];
  assert.equal(cutIndex(messages, 8_000, tokensOf, "b"), 5);
  assert.equal(cutIndex(messages, 8_000, tokensOf), 3);
  // The latest turn (its call and unseen result) is never cut into.
  assert.equal(cutIndex(messages.slice(0, 5), 8_000, tokensOf, "b"), 3);
});

test("view: the digest lists commits and files", () => {
  const d = digest([call("a", `cat > src/x.ts <<'EOF'\nx\nEOF`), call("b", `git add -A && git commit -qm "task 1"`), msg("assistant", { content: [{ type: "text", text: "Done with 1." }] })]);
  assert.match(d, /Commits made: "task 1"/);
  assert.match(d, /Files written: src\/x\.ts/);
  assert.match(d, /Done with 1\./);
});
