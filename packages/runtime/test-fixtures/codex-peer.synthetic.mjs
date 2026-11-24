// Synthetic Codex app-server peer for the connection lifetime tests (#145). No model or network requests.
// Usage: codex-peer.synthetic.mjs <script.json> [adapter arguments...]
// The script is { log, steps: { "<method>": [step, ...] } }. It appends every input line to `log` (first line: its pid), then answers
// each request by the next step for its method (the last step repeats; a method without steps gets `{}`). Lines are handled one by one
// as they arrive, so a delayed step does not hold back the next line. A step is
// { holdUntil?, delayMs?, result?, error?, silent?, frames?, exit? }: once the file `holdUntil` (a name next to the script) exists
// and after `delayMs`, it answers with `error`, or `result` (default `{}`), unless `silent`; then writes `frames`; then exits with
// `exit`. `holdUntil` lets a test decide when a request is answered. The peer exits when its input closes.
// With `lifeline: { module, port, prefix }` it first holds a connection named `<prefix><pid>` to the test's lifeline server
// (@babojubot/process/lifelines) and logs its pid and starts reading only once the server took that name, so every logged
// program has a connection and the test sees it run and end by that connection, not by its number.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (args.includes("login")) process.exit(0);
const [scriptFile] = args;
if (scriptFile === undefined)
  throw new Error(
    "usage: codex-peer.synthetic.mjs <script.json> [arguments...]"
  );
const script = JSON.parse(readFileSync(scriptFile, "utf8"));
/** 붙잡은 답을 풀어 주는 파일이 놓이는 폴더(스크립트 옆). */
const scriptFolder = path.dirname(scriptFile);
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
/** 요청 이름별로 받은 수. 이름은 상대가 보낸 프레임에서 오므로 일반 객체 대신 Map에 센다. */
const seen = new Map();
/** 자기 번호를 기록에 남기고 입력을 받기 시작한다. */
function serve() {
  appendFileSync(script.log, JSON.stringify({ pid: process.pid }) + "\n");
  const input = createInterface({ input: process.stdin });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    appendFileSync(script.log, line + "\n");
    const frame = JSON.parse(line);
    if (frame.id === undefined) return;
    const steps = Object.hasOwn(script.steps, frame.method)
      ? script.steps[frame.method]
      : [{}];
    const index = seen.get(frame.method) ?? 0;
    seen.set(frame.method, index + 1);
    const step = steps[Math.min(index, steps.length - 1)];
    if (step.holdUntil) {
      const release = path.join(scriptFolder, step.holdUntil);
      while (!existsSync(release)) await new Promise((r) => setTimeout(r, 10));
    }
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (!step.silent)
      out(
        step.error
          ? { id: frame.id, error: step.error }
          : { id: frame.id, result: step.result ?? {} }
      );
    for (const extra of step.frames ?? []) out(extra);
    if (step.exit !== undefined) process.exit(step.exit);
  });
  input.on("close", () => process.exit(0));
}
// 시험의 연결 서버가 있으면 연결을 쥐고, 서버가 이름을 받은 뒤에야 번호를 남기고 시작한다. 그래서 기록에 있는 프로그램은 모두
// 연결이 있고, 그 끝은 연결 닫힘으로 보인다.
if (script.lifeline) {
  const { hold } = await import(pathToFileURL(script.lifeline.module).href);
  hold(script.lifeline.port, `${script.lifeline.prefix}${process.pid}`, serve);
} else serve();
