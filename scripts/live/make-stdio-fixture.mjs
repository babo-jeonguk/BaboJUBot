// 사람이 돌리는 도구. 비공개 표준 입출력 기록에서 저장소에 넣을 정제본을 만든다.
// 허용 목록 방식이다. 아래 키 외의 모든 글자는 가리므로 지침·답변·경로·ID가 들어갈 수 없다. 숫자와 구조는 그대로 둔다.
// 사용: node scripts/live/make-stdio-fixture.mjs <claude|claude-background|codex-app-server|codex-exec|antigravity> <출력 파일> <녹화 폴더...>
// claude-background는 provider-live의 background 장면을 replay.mjs 순서(입력 → 첫 결과 → 입력 닫힘 → 나머지 → 종료)로 만든다.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [provider, output, ...directories] = process.argv.slice(2);
const versions = {
  claude: "2.1.317 (Claude Code)",
  "claude-background": "2.1.317 (Claude Code)",
  "codex-app-server": "codex-cli 0.166.0",
  "codex-exec": "codex-cli 0.166.0",
  antigravity: "1.4.12",
};
const keptStrings = new Set([
  "type",
  "subtype",
  "status",
  "method",
  "event",
  "state",
  "role",
  "stop_reason",
]);
const sessionKeys = new Set([
  "session_id",
  "sessionId",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
]);
const mask = (value, key, parent) => {
  if (Array.isArray(value)) return value.map((item) => mask(item, key, parent));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mask(v, k, key)])
    );
  if (typeof value !== "string") return value;
  if (sessionKeys.has(key)) return "<session>";
  if (key === "turnId" || (key === "id" && parent === "turn")) return "<turn>";
  return keptStrings.has(key) ? value : "<masked>";
};

async function runs() {
  const found = [];
  for (const directory of directories)
    for (const name of (await readdir(directory)).sort()) {
      const rows = (await readFile(path.join(directory, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const frames = rows
        .filter((row) => row.kind === "stdout")
        .map((row) => row.text)
        .join("")
        .split("\n")
        .flatMap((line) => {
          try {
            return line.trim() ? [JSON.parse(line)] : [];
          } catch {
            return [];
          }
        });
      if (frames.length) found.push(frames);
    }
  return found;
}
const all = await runs();
if (provider === "claude-background") {
  const chosen = all.find((frames) =>
    frames.some(
      (f) => f.subtype === "background_tasks_changed" && f.tasks?.length
    )
  );
  if (!chosen) throw new Error("No recorded run with a background task");
  const first = chosen.findIndex((f) => f.type === "result");
  const steps = [
    { input: { type: "user", message: { role: "user" } } },
    ...chosen.slice(0, first + 1).map((frame) => ({ frame: mask(frame) })),
    { inputEnd: true },
    // 실제로는 45초 명령을 기다린 자리다. 순서만 지키고 시간은 줄인다.
    { sleepMs: 300 },
    ...chosen.slice(first + 1).map((frame) => ({ frame: mask(frame) })),
    { exit: 0 },
  ];
  await writeFile(
    output,
    JSON.stringify(
      {
        provenance: `Reviewed recording of real Claude stream-json output (${versions[provider]}, 2026-11-09, provider-live background scene: a foreground subagent, then a 45 s background command, then one more turn). Every string outside a short allowlist is masked; numbers and structure are real. The 45 s wait is shortened.`,
        version: versions[provider],
        steps,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`${provider}: ${steps.length} steps`);
  process.exit(0);
}
const pick = {
  claude: (frames) =>
    frames.some((f) => f.type === "result" && f.subtype === "success") &&
    frames.some((f) =>
      f.message?.content?.some?.((c) => c.type === "tool_use")
    ) &&
    !frames.some((f) => f.subtype === "compact_boundary"),
  "codex-app-server": (frames) =>
    frames.some((f) => f.method === "turn/completed") &&
    frames.some((f) => f.method === "item/completed"),
  "codex-exec": (frames) =>
    frames.some((f) => f.type === "turn.completed") &&
    frames.some((f) => f.type?.startsWith("item.")),
  antigravity: (frames) =>
    frames.some((f) => f.event === "result" && f.result?.status === "SUCCESS"),
}[provider];
const chosen = all.find(pick);
if (!chosen) throw new Error("No suitable recorded run");
const fixture = {
  provenance: `Reviewed recording of real ${provider} protocol output (2026-11-04). Every string outside a short allowlist is masked; numbers and structure are real. Behaviour around it is scripted by the simulator.`,
  version: versions[provider],
  // 응답(id가 있고 method가 없는 프레임)은 요청에 묶여 있어 뺀다.
  frames: mask(chosen.filter((f) => f.method || f.id === undefined)),
};
if (provider === "claude") {
  const compact = all.find((frames) =>
    frames.some((f) => f.subtype === "compact_boundary")
  );
  if (compact) fixture.compact = mask(compact);
}
await writeFile(output, JSON.stringify(fixture, null, 2) + "\n");
console.log(`${provider}: ${fixture.frames.length} frames`);
