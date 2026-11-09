// Synthetic peer, NOT a recording. Mimics how Claude Code 2.1.317 keeps a session's cumulative cost:
// on exit it appends a `cost-state` row (cumulative, last wins per session) to the session transcript,
// also when the run was interrupted. Scene file (argv[2]):
// { "mode": "cancel" | "finish", "result"?: {...result frame}, "costState"?: {...cost-state fields} }
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

const scene = JSON.parse(await readFile(process.argv[2], "utf8"));
const args = process.argv.slice(3);
const resume = args.indexOf("--resume");
const id = resume >= 0 ? args[resume + 1] : "fresh-session";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function saveCost() {
  if (!scene.costState) return;
  const folder = path.join(process.env.CLAUDE_CONFIG_DIR, "projects/synthetic");
  await mkdir(folder, { recursive: true });
  await appendFile(
    path.join(folder, `${id}.jsonl`),
    JSON.stringify({ type: "cost-state", sessionId: id, ...scene.costState }) +
      "\n"
  );
}
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
await input.next();
out({ type: "system", subtype: "init", session_id: id });
if (scene.mode === "cancel") {
  // Wait for the interrupt, then save the cost like the real program does on exit.
  await input.next();
  await saveCost();
  process.exit(0);
}
out({ type: "result", subtype: "success", session_id: id, ...scene.result });
await saveCost();
process.exit(0);
