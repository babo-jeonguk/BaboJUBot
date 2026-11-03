// Synthetic leader exits on interrupt; child ignores TERM and would act after the run returns.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("2.1.316 (Claude Code)");
  process.exit(0);
}
const child = spawn(
  process.execPath,
  [
    "-e",
    `process.on('SIGTERM',()=>{}); process.send('ready'); setTimeout(()=>require('node:fs').writeFileSync(process.env.HOME+'/orphan-effect','unexpected'),2500);setInterval(()=>{},1000);`,
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
