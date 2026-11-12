// Synthetic Codex app-server stand-in for the credential relay tests (#148). No model or network requests beyond the given relay.
// Like Codex with a ChatGPT login and a custom provider (`requires_openai_auth`), it reads the access token (and the account id, when
// present) from CODEX_HOME/auth.json and calls `<base_url>/responses` of the `babojubot_relay` provider given with `-c`.
// It appends the login it saw to CODEX_HOME/seen-auth.jsonl for the test. On 200 the turn completes; otherwise it keeps retrying like a
// CLI would until its input closes, then exits 1.
import { createInterface } from "node:readline";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const provider = args.find((arg) =>
  arg.startsWith("model_providers.babojubot_relay=")
);
const baseUrl = provider ? /base_url="([^"]+)"/.exec(provider)?.[1] : undefined;
// Inside a container a per-attempt file may be mounted over CODEX_HOME/auth.json; the fake docker lists its mounts.
const loginAt = path.join(process.env.CODEX_HOME, "auth.json");
const mounted = JSON.parse(process.env.FAKE_DOCKER_MOUNTS ?? "[]").find(
  (mount) => mount.target === loginAt
);
const login = JSON.parse(await readFile(mounted?.source ?? loginAt, "utf8"));
await appendFile(
  path.join(process.env.CODEX_HOME, "seen-auth.jsonl"),
  JSON.stringify({
    login,
    args,
    refreshUrl: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? null,
  }) + "\n"
);

const threadId = "relay-thread",
  turnId = "relay-turn";
let closed = false,
  completed = false;
const call = () =>
  fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${login.tokens.access_token}`,
      "content-type": "application/json",
      ...(login.tokens.account_id
        ? { "chatgpt-account-id": login.tokens.account_id }
        : {}),
    },
    body: JSON.stringify({ model: "synthetic", input: [] }),
  }).then(
    async (response) => {
      await response.arrayBuffer().catch(() => undefined);
      return response.status;
    },
    () => 0
  );

async function runTurn() {
  for (;;) {
    if (closed) return;
    if ((await call()) === 200) {
      out({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          tokenUsage: {
            total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
          },
        },
      });
      out({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
      completed = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (frame.method === "initialize") out({ id: frame.id, result: {} });
  else if (frame.method === "thread/start" || frame.method === "thread/resume")
    out({ id: frame.id, result: { thread: { id: threadId } } });
  else if (frame.method === "turn/start") {
    out({ id: frame.id, result: { turn: { id: turnId } } });
    void runTurn();
  } else if (typeof frame.id === "number") out({ id: frame.id, result: {} });
});
input.on("close", () => {
  closed = true;
  process.exit(completed ? 0 : 1);
});
