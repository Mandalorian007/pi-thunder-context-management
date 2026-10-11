// A scripted stand-in for the model, speaking OpenAI's streaming chat
// completions, so the harness can be driven end to end without spending.
//
// It plays a builder working through tasks: each turn runs one bash command
// that prints padding (so context grows) and commits. It calls `compact` when
// the latest user-side message is a context nudge, and only once a nudge has
// reached the `obeyFrom` level, so a test can script an agent that ignores the
// soft nudge, or every nudge. Reported usage is characters / 4 of what it was sent.

import { createServer, type IncomingMessage, type Server } from "node:http";

export type Script = {
  tasks: number;
  padding: number;
  obeyFrom: "soft" | "firm" | "immediate" | "never";
};

export type Seen = { messages: number; chars: number; lastUser: string; stubs: number; sent: string[] };

const LEVELS = ["soft", "firm", "immediate"];

function levelOf(text: string): string | undefined {
  if (!text.startsWith("[context:")) return undefined;
  if (text.includes("at its limit")) return "immediate";
  if (text.includes("getting large")) return "firm";
  return "soft";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  return "";
}

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

export function startFakeModel(script: Script): Promise<{ url: string; seen: Seen[]; close: () => void; server: Server }> {
  const seen: Seen[] = [];
  let committed = 0;
  let call = 0;
  const server = createServer(async (req, res) => {
    const request = await body(req);
    const messages: { role: string; content: unknown }[] = request.messages;
    const chars = JSON.stringify(messages).length;
    const users = messages.filter((m) => m.role === "user");
    const lastUser = textOf(users.at(-1)?.content);
    const last = messages.at(-1);
    // The cache marker moves to the newest message on every call, and a message
    // carrying it is sent as parts rather than a string. Neither is a change to
    // the prefix (OpenRouter sends Anthropic the same thing), so compare text.
    const sent = messages.map((m) => JSON.stringify({ ...m, content: textOf(m.content) }));
    const stubs = sent.filter((m) => m.includes("[Output pruned by the harness")).length;
    seen.push({ messages: messages.length, chars, lastUser: lastUser.slice(0, 80), stubs, sent });
    call += 1;

    let reply: { text?: string; tool?: { name: string; args: unknown } };
    const level = last?.role === "user" ? levelOf(textOf(last.content)) : undefined;
    const obeys = level && script.obeyFrom !== "never" && LEVELS.indexOf(level) >= LEVELS.indexOf(script.obeyFrom);
    const summarising = !Array.isArray(request.tools) || request.tools.length === 0;
    if (summarising) {
      reply = { text: `## Goal\nFinish the tasks.\n\n## Progress\n- [x] Tasks 1-${committed}\n\n## Next Steps\n1. Task ${committed + 1}` };
    } else if (obeys) {
      reply = { tool: { name: "compact", args: { mode: "handoff", summary: `Committed tasks 1-${committed}. Next: task ${committed + 1}.` } } };
    } else if (committed >= script.tasks) {
      reply = { text: "All tasks committed." };
    } else {
      committed += 1;
      reply = {
        tool: {
          name: "bash",
          args: { command: `head -c ${script.padding} /dev/zero | tr '\\0' 'a'; echo; echo ${committed} >> work.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm "task ${committed}"` },
        },
      };
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const base = { id: `fake-${call}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: request.model };
    if (reply.tool) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${call}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    send({ ...base, choices: [], usage: { prompt_tokens: Math.ceil(chars / 4), completion_tokens: 20, total_tokens: Math.ceil(chars / 4) + 20 } });
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, seen, close: () => server.close(), server });
    });
  });
}
