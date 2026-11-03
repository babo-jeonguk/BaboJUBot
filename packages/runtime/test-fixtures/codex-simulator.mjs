// Synthetic behavioral peer; never invokes Codex or a model.
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2),
  out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
if (args.includes("--version")) {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (args.includes("login")) process.exit(0);
const exec = args.includes("exec");
let id = crypto.randomUUID(),
  turn = "turn-one",
  context,
  waiting = false,
  note = "";
const address = args.find((x) => x.startsWith("mcp_servers.organization.url="));
const base = JSON.parse(address.slice(address.indexOf("=") + 1)).replace(
  /\/mcp$/,
  ""
);

async function load() {
  try {
    note = await readFile(
      path.join(process.env.CODEX_HOME, id + ".note"),
      "utf8"
    );
  } catch {
    note = "";
  }
}
async function reply(body) {
  const response = await fetch(base + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.BABOJUBOT_MCP_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      body,
      conversationId: context.context.conversations[0].id,
    }),
  });
  if (!response.ok) throw new Error("synthetic tool rejected");
  if (exec)
    out({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 },
    });
  else {
    out({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: id,
        turnId: turn,
        tokenUsage: {
          total: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
        },
      },
    });
    out({
      method: "turn/completed",
      params: { threadId: id, turn: { id: turn, status: "completed" } },
    });
  }
}
async function begin(text) {
  context = JSON.parse(text);
  const body = context.wakeReasons[0].body ?? "";
  if (body === "실행 유지 연습") return;
  if (body === "끼워 넣기 연습") {
    waiting = true;
    return;
  }
  if (body.startsWith("메모해 주세요: ")) {
    note = body.slice("메모해 주세요: ".length);
    await writeFile(path.join(process.env.CODEX_HOME, id + ".note"), note);
  }
  await reply(body === "세션 메모를 알려 주세요" ? note || "없음" : "완료");
}
if (exec && args.includes("resume")) id = args[args.indexOf("resume") + 1];
if (exec && id === "expired") {
  out({ type: "error", message: "No rollout found for thread id: expired" });
  process.exit(1);
}
await load();
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (exec) {
    out({ type: "thread.started", thread_id: id });
    await begin(line);
    if (context.wakeReasons[0].body === "실행 유지 연습") {
      setInterval(() => {}, 1000);
    }
    break;
  }
  const p = frame.params ?? {};
  if (frame.method === "initialize") out({ id: frame.id, result: {} });
  if (frame.method === "thread/start" || frame.method === "thread/resume") {
    if (p.threadId === "expired") {
      out({
        id: frame.id,
        error: { code: -32600, message: "thread not found: expired" },
      });
      continue;
    }
    if (p.threadId) id = p.threadId;
    await load();
    out({ id: frame.id, result: { thread: { id } } });
  }
  if (frame.method === "turn/start") {
    out({ id: frame.id, result: { turn: { id: turn } } });
    await begin(p.input[0].text);
  }
  if (frame.method === "turn/steer") {
    if (!waiting || p.expectedTurnId !== turn) {
      out({ id: frame.id, error: { code: -32600, message: "no active turn" } });
      continue;
    }
    out({ id: frame.id, result: { turnId: turn } });
    await reply(p.input[0].text);
    waiting = false;
  }
  if (frame.method === "turn/interrupt") {
    out({ id: frame.id, result: {} });
    out({
      method: "turn/completed",
      params: { threadId: id, turn: { id: turn, status: "interrupted" } },
    });
    break;
  }
}
