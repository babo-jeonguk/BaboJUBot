// Synthetic leader exits on interrupt; child ignores TERM and keeps acting until it is killed.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
const child = spawn(
  process.execPath,
  [
    "-e",
    `process.on('SIGTERM',()=>{}); let beats=0; const beat=()=>require('node:fs').writeFileSync(process.env.HOME+'/orphan-heartbeat',String(++beats)); beat(); process.send('ready'); setInterval(beat,20);`,
  ],
  { env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"] }
);
child.on("message", () => {
  console.log(
    JSON.stringify({ type: "system", subtype: "init", session_id: "orphan" })
  );
});
for await (const line of createInterface({ input: process.stdin }))
  if (JSON.parse(line).type === "control_request") process.exit(0);
