// Synthetic Codex app-server stand-in for the credential relay tests (#148). No model or network requests beyond the given relay.
// Like Codex with a ChatGPT login and a custom provider (`requires_openai_auth`), it reads the access token (and the account id, when
// present) from CODEX_HOME/auth.json and calls `<base_url>/responses` of the `babojubot_relay` provider given with `-c`.
// It appends the login it saw to CODEX_HOME/seen-auth.jsonl for the test. On 200 the turn completes; otherwise it keeps retrying like a
// CLI would until its input closes, then exits 1. With `--never-start-thread` it leaves `thread/start` unanswered; with
// `--die-on-thread` it ends (code 1) instead of answering it. As `exec` it calls the relay until it answers 200, then prints the exec
// JSON lines of a finished turn and exits 0; it keeps retrying until it is stopped otherwise.
import { createInterface } from "node:readline";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { afterOutput } from "../../../scripts/exit-after-output.ts";

const args = process.argv.slice(2);
/** 시험이 이 프로그램에 주는 CODEX_HOME. */
function codexHome() {
  const folder = process.env.CODEX_HOME;
  if (!folder) throw new Error("synthetic: CODEX_HOME is not set");
  return folder;
}
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const provider = args.find((arg) =>
  arg.startsWith("model_providers.babojubot_relay=")
);
const baseUrl = provider ? /base_url="([^"]+)"/.exec(provider)?.[1] : undefined;
// Inside a container a per-attempt file may be mounted over CODEX_HOME/auth.json; the fake docker lists its mounts.
const loginAt = path.join(codexHome(), "auth.json");
const mounted = JSON.parse(process.env.FAKE_DOCKER_MOUNTS ?? "[]").find(
  (mount) => mount.target === loginAt
);
const login = JSON.parse(await readFile(mounted?.source ?? loginAt, "utf8"));
await appendFile(
  path.join(codexHome(), "seen-auth.jsonl"),
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

if (args[0] === "exec") {
  process.stdin.resume();
  for (;;) {
    if ((await call()) === 200) {
      out({ type: "thread.started", thread_id: threadId });
      out({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      });
      process.exit(await afterOutput(0));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (frame.method === "initialize") out({ id: frame.id, result: {} });
  else if (
    frame.method === "thread/start" ||
    frame.method === "thread/resume"
  ) {
    if (args.includes("--never-start-thread")) return;
    if (args.includes("--die-on-thread")) process.exit(await afterOutput(1));
    out({ id: frame.id, result: { thread: { id: threadId } } });
  } else if (frame.method === "turn/start") {
    out({ id: frame.id, result: { turn: { id: turnId } } });
    void runTurn();
  } else if (typeof frame.id === "number") out({ id: frame.id, result: {} });
});
input.on("close", async () => {
  closed = true;
  process.exit(await afterOutput(completed ? 0 : 1));
});
