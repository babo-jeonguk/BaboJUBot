// Synthetic behavioral peer, NOT a recording or evidence about a real model.
// Exercises stdin, argv, session persistence, and local tool HTTP through a real child process.
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
let id = argv.includes("--resume") ? option("--resume") : crypto.randomUUID();
if (id === "expired") {
  out({
    type: "result",
    subtype: "error_during_execution",
    errors: ["No conversation found with session ID: expired"],
  });
  process.exit(1);
}
let note = "";
try {
  note = await readFile(path.join(process.env.HOME, id + ".note"), "utf8");
} catch {
  /* A fresh synthetic session has no note. */
}
const config = JSON.parse(await readFile(option("--mcp-config"), "utf8"))
  .mcpServers.organization;
const base = config.url.replace(/\/mcp$/, "");
let waiting = false;
let context;
async function reply(body) {
  await fetch(base + "/messages", {
    method: "POST",
    headers: { ...config.headers, "content-type": "application/json" },
    body: JSON.stringify({
      body,
      conversationId: context.context.conversations[0].id,
    }),
  });
  out({
    type: "result",
    subtype: "success",
    session_id: id,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 },
    total_cost_usd: 0.001,
  });
  process.stdin.pause();
  process.exitCode = 0;
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const input = JSON.parse(line);
  if (input.type === "control_request") {
    lines.close();
    break;
  }
  if (waiting) {
    await reply(input.message.content);
    lines.close();
    break;
  }
  context = JSON.parse(input.message.content);
  const body = context.wakeReasons[0].body ?? "";
  out({ type: "system", subtype: "init", session_id: id });
  if (body === "실행 유지 연습") continue;
  if (body === "끼워 넣기 연습") {
    waiting = true;
    continue;
  }
  if (body.startsWith("메모해 주세요: ")) {
    note = body.slice("메모해 주세요: ".length);
    await writeFile(path.join(process.env.HOME, id + ".note"), note);
  }
  await reply(body === "세션 메모를 알려 주세요" ? note || "없음" : "완료");
  lines.close();
  break;
}
