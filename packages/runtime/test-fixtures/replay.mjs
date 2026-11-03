// Synthetic/reviewed recordings use the same subprocess boundary as the provider.
// No model or network requests. Mismatched input fails closed.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const recording = JSON.parse(await readFile(process.argv[2], "utf8"));
if (process.argv.includes("--version")) {
  console.log(recording.version ?? "9.9.9 (Claude Code)");
  process.exit(0);
}
if (process.argv.includes("login") && process.argv.includes("status"))
  process.exit(0);
for (const [flag, value] of Object.entries(recording.argv ?? {})) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || (value !== true && process.argv[i + 1] !== value))
    process.exit(24);
}
for (const [flag, content] of Object.entries(recording.argvFile ?? {})) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || (await readFile(process.argv[i + 1], "utf8")) !== content)
    process.exit(25);
}
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
function matches(actual, expected) {
  if (expected && typeof expected === "object")
    return Object.entries(expected).every(([k, v]) => matches(actual?.[k], v));
  return actual === expected;
}
for (const step of recording.steps) {
  if (step.input) {
    const line = await input.next();
    if (line.done || !matches(JSON.parse(line.value), step.input))
      process.exit(23);
  }
  if (step.stdout !== undefined) process.stdout.write(step.stdout);
  if (step.frame) process.stdout.write(JSON.stringify(step.frame) + "\n");
  if (step.exit !== undefined) process.exit(step.exit);
}
process.stdin.resume();
