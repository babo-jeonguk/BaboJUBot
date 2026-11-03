// Synthetic behavioral peer. No Antigravity/model is invoked.
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { bind, recording } from "./recording.mjs";
const args = process.argv
    .slice(2)
    .filter(
      (_, i, all) => all[i] !== "--recording" && all[i - 1] !== "--recording"
    ),
  out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (args.includes("--version")) {
  console.log("9.9.9");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("simulated-model\tSimulated Model");
  process.exit(0);
}
const asked = args.includes("--conversation")
  ? args[args.indexOf("--conversation") + 1]
  : null;
// 실제 프로그램은 없는 대화를 받으면 경고하고 새 대화로 시작한다.
if (asked === "expired")
  console.error('warning: conversation "expired" not found');
const id = asked && asked !== "expired" ? asked : crypto.randomUUID();
const directory = path.join(
  process.env.HOME,
  ".gemini/antigravity-cli/conversations"
);
await mkdir(directory, { recursive: true });
const file = path.join(directory, id + ".db");
let note = await readFile(file, "utf8").catch(() => "");
await writeFile(file, note);
const config = JSON.parse(
  await readFile(path.join(process.cwd(), ".agents/mcp_config.json"), "utf8")
).mcpServers.organization;
out(
  recording
    ? bind(
        recording.frames.find((f) => f.event === "init"),
        id
      )
    : { event: "init", conversation_id: id }
);
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line),
    text = frame.message.content;
  const context = JSON.parse(text.slice(text.indexOf('{"identity"'))),
    body = context.wakeReasons[0]?.body ?? "";
  if (body === "실행 유지 연습") continue;
  if (body.startsWith("메모해 주세요: ")) {
    note = body.slice("메모해 주세요: ".length);
    await writeFile(file, note);
  }
  const response = await fetch(
    config.serverUrl.replace(/\/mcp$/, "/messages"),
    {
      method: "POST",
      headers: { ...config.headers, "content-type": "application/json" },
      body: JSON.stringify({
        body: body === "세션 메모를 알려 주세요" ? note || "없음" : "완료",
        conversationId: context.context.conversations[0].id,
      }),
    }
  );
  if (!response.ok) process.exit(23);
  if (recording) {
    for (const frame of recording.frames)
      if (frame.event !== "init") out(bind(frame, id));
  } else {
    out({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: 1,
        state: "DONE",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 },
      },
    });
    out({
      event: "result",
      result: { status: "SUCCESS", conversation_id: id },
    });
  }
}
