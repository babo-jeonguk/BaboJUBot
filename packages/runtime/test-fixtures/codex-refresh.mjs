// Synthetic Codex on this machine for the login refresh tests (#148). No network requests.
// Usage: codex-refresh.mjs <log file> <ok|slow|fail>.
// As `app-server`, it answers initialize and `account/read` with `refreshToken: true`. On ok/slow it writes a new login through the
// CODEX_HOME/auth.json link onto its target (like Codex: a new file renamed over the target), with an access token that expires in an
// hour, and appends a line to the log. On fail it answers with an error and changes nothing.
import { createInterface } from "node:readline";
import {
  appendFile,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const [log, mode = "ok", ...rest] = process.argv.slice(2);
if (rest.includes("--version")) {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (rest.includes("login")) process.exit(0);
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const jwt = (claims) =>
  [{ alg: "none" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".") + ".sig";

async function refresh() {
  const target = await realpath(path.join(process.env.CODEX_HOME, "auth.json"));
  const login = JSON.parse(await readFile(target, "utf8"));
  if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
  const count =
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean)
      .length + 1;
  login.tokens.access_token = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: `refreshed-${count}`,
  });
  login.tokens.refresh_token = `rotated-refresh-${count}`;
  login.last_refresh = new Date().toISOString();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(login), { mode: 0o600 });
  await rename(temporary, target);
  await appendFile(log, `${count}\n`);
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (frame.method === "initialize") out({ id: frame.id, result: {} });
  else if (frame.method === "account/read") {
    if (frame.params?.refreshToken !== true) {
      out({ id: frame.id, result: { account: null } });
      return;
    }
    if (mode === "fail") {
      out({ id: frame.id, error: { code: -32000, message: "refresh failed" } });
      return;
    }
    await refresh();
    out({ id: frame.id, result: { account: { type: "chatgpt" } } });
  } else if (typeof frame.id === "number") out({ id: frame.id, result: {} });
});
input.on("close", () => process.exit(0));
