// Synthetic Codex app-server peer for the connection lifetime tests (#145). No model or network requests.
// Usage: codex-peer.synthetic.mjs <script.json> [adapter arguments...]
// The script is { log, steps: { "<method>": [step, ...] } }. It appends every input line to `log` (first line: its pid), then answers
// each request by the next step for its method (the last step repeats; a method without steps gets `{}`). Lines are handled one by one
// as they arrive, so a delayed step does not hold back the next line. A step is
// { holdUntil?, delayMs?, result?, error?, silent?, frames?, exit? }: once the file `holdUntil` (a name next to the script) exists
// and after `delayMs`, it answers with `error`, or `result` (default `{}`), unless `silent`; then writes `frames`; then exits with
// `exit`. `holdUntil` lets a test decide when a request is answered. The peer exits when its input closes.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

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
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const seen = {};
appendFileSync(script.log, JSON.stringify({ pid: process.pid }) + "\n");
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  appendFileSync(script.log, line + "\n");
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  const steps = script.steps[frame.method] ?? [{}];
  const index = seen[frame.method] ?? 0;
  seen[frame.method] = index + 1;
  const step = steps[Math.min(index, steps.length - 1)];
  if (step.holdUntil) {
    const release = path.join(path.dirname(scriptFile), step.holdUntil);
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
