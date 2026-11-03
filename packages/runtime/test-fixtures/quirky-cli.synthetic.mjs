// Synthetic peer that behaves like a real CLI on a bad day: banners, big lines, slow answers, untidy exits.
// Not a recording. Usage: quirky-cli.synthetic.mjs <claude|codex|antigravity> <variant> [adapter arguments...]
import { createInterface } from "node:readline";

const [kind, variant] = process.argv.slice(2);
const args = process.argv.slice(4);
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (args.includes("--version")) {
  if (variant === "version-fails") process.exit(3);
  console.log("anything 1.2.3");
  process.exit(0);
}
if (args[0] === "login") process.exit(0);
if (args[0] === "models") {
  if (variant === "logged-out") {
    console.error(
      "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."
    );
    process.exit(1);
  }
  if (variant === "offline") {
    console.error("Error: could not reach the service.");
    process.exit(1);
  }
  console.log("model-one\tModel One");
  process.exit(0);
}
if (variant === "banner")
  console.log("A new version is available. Run the update command.");
const finish = async () => {
  if (variant === "exits-1") process.exit(1);
  if (variant === "slow-exit") {
    process.stdin.pause();
    setInterval(() => {}, 1000);
    await sleep(60_000);
  }
  // 파이프 출력은 비동기다. 큰 줄이 잘리지 않도록 비운 뒤 끝낸다.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
};
const input = createInterface({ input: process.stdin });

if (kind === "claude")
  for await (const _ of input) {
    if (variant === "slow-start") await sleep(13_000);
    out({ type: "system", subtype: "init", session_id: "session-one" });
    if (variant === "long-line")
      out({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
        },
      });
    out({
      type: "result",
      subtype: "success",
      session_id: "session-one",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.001,
    });
    await finish();
  }

if (kind === "codex" && args.includes("exec")) {
  for await (const _ of input) break;
  out({ type: "thread.started", thread_id: "thread-one" });
  out({
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
  });
  await finish();
}

if (kind === "codex")
  for await (const line of input) {
    const { id, method } = JSON.parse(line);
    if (method === "initialize") out({ id, result: {} });
    if (method === "thread/start") {
      if (variant === "slow-answer") await sleep(3_500);
      out({ id, result: { thread: { id: "thread-one" } } });
    }
    if (method === "turn/start") {
      out({ id, result: { turn: { id: "turn-one" } } });
      if (variant === "ignores-steer") await sleep(11_000);
      out({
        method: "turn/completed",
        params: {
          threadId: "thread-one",
          turn: { id: "turn-one", status: "completed" },
        },
      });
      if (variant === "exits-1" || variant === "slow-exit") await finish();
    }
  }

if (kind === "antigravity")
  for await (const _ of input) {
    // 실제 프로그램이 로그인 없이 내는 출력이다.
    if (variant === "logged-out") {
      out({
        event: "result",
        result: {
          conversation_id: "",
          status: "ERROR",
          error: "authentication failed or timed out",
        },
      });
      process.exit(1);
    }
    if (variant === "slow-start") await sleep(13_000);
    out({ event: "init", conversation_id: "conversation-one" });
    out({
      event: "result",
      result: { status: "SUCCESS", conversation_id: "conversation-one" },
    });
    await finish();
  }
