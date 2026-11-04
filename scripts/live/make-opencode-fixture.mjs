// 사람이 돌리는 도구. 비공개 OpenCode 원본 기록에서 저장소에 넣을 정제본을 만든다.
// 허용 목록 방식이다. 아래 키 외의 모든 글자는 가리므로 지침·답변·경로·ID가 들어갈 수 없다. 숫자와 구조는 그대로 둔다.
// 사용: node scripts/live/make-opencode-fixture.mjs <녹화 폴더> <출력 파일>
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [directory, output] = process.argv.slice(2);
const keptStrings = new Set([
  "type",
  "status",
  "outcome",
  "providerID",
  "agent",
]);
const sessionKeys = new Set(["sessionID", "aggregateID"]);
const mask = (value, key) => {
  if (Array.isArray(value)) return value.map((item) => mask(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mask(v, k)])
    );
  if (typeof value !== "string") return value;
  if (sessionKeys.has(key)) return "<session>";
  return keptStrings.has(key) ? value : "<masked>";
};
const events = (text) =>
  text.split("\n\n").flatMap((block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  });

let best;
for (const name of (await readdir(directory)).sort()) {
  const rows = (await readFile(path.join(directory, name), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const body = (id) =>
    rows
      .filter((row) => row.kind === "http-chunk" && row.id === id)
      .map((row) => row.text)
      .join("");
  const requests = rows.filter((row) => row.kind === "http-request");
  const find = (test) => requests.find((request) => test(request));
  const stream = find((r) => r.url === "/api/event");
  if (!stream) continue;
  const all = events(body(stream.id));
  const start = all.findIndex((e) => e.type === "session.execution.started");
  const end = all.findIndex((e) => e.type === "session.execution.succeeded");
  if (start < 0 || end < 0) continue;
  if (!all.slice(start, end).some((e) => e.type === "session.tool.success"))
    continue;
  const model = find((r) => r.url.startsWith("/api/model"));
  const created = find((r) => r.url === "/api/session" && r.method === "POST");
  const prompt = find((r) => r.url.endsWith("/prompt"));
  const session = requests
    .filter((r) => r.method === "GET" && /^\/api\/session\/[^/]+$/.test(r.url))
    .at(-1);
  if (!model || !created || !prompt || !session) continue;
  best = {
    models: JSON.parse(body(model.id)).data,
    session: JSON.parse(body(session.id)).data,
    prompt: JSON.parse(body(prompt.id)),
    connected: all.slice(0, start),
    started: all[start],
    turn: all.slice(start + 1, end),
    succeeded: all[end],
  };
  break;
}
if (!best) throw new Error("No completed run with a tool call was recorded");
const usable = best.models.filter((m) => m.cost?.[0]?.input === 0).slice(0, 1);
const fixture = {
  provenance:
    "Reviewed recording of real OpenCode 2.2.5 protocol output (free model, 2026-11-03). Every string outside a short allowlist is masked; numbers and structure are real. Behaviour around it is scripted by opencode-simulator.mjs.",
  version: "opencode v2.2.5",
  models: usable.map((m) => ({
    ...mask(m),
    id: "recorded-free",
    providerID: "opencode",
    name: "Recorded free model",
  })),
  session: mask(best.session),
  prompt: mask(best.prompt),
  connected: mask(best.connected),
  started: mask(best.started),
  turn: mask(best.turn),
  succeeded: mask(best.succeeded),
};
await writeFile(output, JSON.stringify(fixture, null, 2) + "\n");
console.log(
  `events: connected ${fixture.connected.length}, turn ${fixture.turn.length}`
);
