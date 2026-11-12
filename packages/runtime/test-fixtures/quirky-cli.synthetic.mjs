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
if (args[0] === "login") process.exit(variant === "no-file-login" ? 1 : 0);
if (args[0] === "auth") process.exit(variant === "logged-out" ? 1 : 0);
// 이전 세션으로는 어떤 문구로든 시작하지 못하는 프로그램. 문구에 기대지 않는다는 것을 확인한다.
const resuming = args.includes("--resume") || args.includes("resume");
if (variant === "fails-on-resume" && resuming) {
  console.error("Something unexpected happened with that conversation.");
  process.exit(1);
}
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
  // 결과를 낸 뒤 입력이 닫혀도 몇 초 더 머문다. 끝나기를 기다리는 adapter(Claude, #125)도 시험 시간 안에 결과를 받는다.
  if (variant === "slow-exit") {
    process.stdin.pause();
    setInterval(() => {}, 1000);
    await sleep(6_000);
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
    // 실제 프로그램이 인증에 실패할 때 내는 출력이다. subtype이 success인 데 주의한다.
    if (variant === "auth-fail") {
      out({
        type: "assistant",
        error: "authentication_failed",
        message: {
          content: [{ type: "text", text: "Failed to authenticate" }],
        },
      });
      out({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
        session_id: "session-one",
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      });
      process.exit(1);
    }
    if (variant === "api-error") {
      out({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 500,
        result: "API Error: 500 Internal server error",
        session_id: "session-one",
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      });
      process.exit(1);
    }
    if (variant === "waits-for-steer") {
      for await (const _steer of input) break;
    }
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
  if (variant === "auth-fail") {
    out({
      type: "error",
      message: "unexpected status 401 Unauthorized: Missing bearer",
    });
    out({
      type: "turn.failed",
      error: { message: "unexpected status 401 Unauthorized: Missing bearer" },
    });
    process.exit(1);
  }
  // 실제 프로그램은 재개한 세션의 누적 사용량을 낸다.
  if (variant === "cumulative") {
    out({
      type: "turn.completed",
      usage: resuming
        ? {
            input_tokens: 76549,
            cached_input_tokens: 69632,
            cache_write_input_tokens: 0,
            output_tokens: 591,
          }
        : {
            input_tokens: 43619,
            cached_input_tokens: 38400,
            cache_write_input_tokens: 0,
            output_tokens: 461,
          },
    });
    await finish();
  }
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
    if (method === "thread/resume") {
      if (variant === "fails-on-resume")
        out({ id, error: { code: -1, message: "that went badly" } });
      else out({ id, result: { thread: { id: "thread-one" } } });
    }
    if (method === "thread/start") {
      if (variant === "slow-answer") await sleep(3_500);
      out({ id, result: { thread: { id: "thread-one" } } });
    }
    if (method === "turn/start") {
      out({ id, result: { turn: { id: "turn-one" } } });
      if (variant === "auth-fail") {
        out({
          method: "turn/completed",
          params: {
            threadId: "thread-one",
            turn: {
              id: "turn-one",
              status: "failed",
              error: { message: "unexpected status 401 Unauthorized" },
            },
          },
        });
        continue;
      }
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

// `agy acp`(Agent Client Protocol, 줄 단위 JSON-RPC).
if (kind === "antigravity")
  for await (const line of input) {
    const { id, method } = JSON.parse(line);
    const answer = (body) => out({ jsonrpc: "2.0", id, ...body });
    if (method === "initialize") {
      if (variant === "slow-start") await sleep(13_000);
      answer({ result: { protocolVersion: 1 } });
    } else if (method === "session/new" || method === "session/load") {
      // 실제 프로그램(1.5.4)이 로그인 없이 세션을 열 때 내는 오류다.
      if (variant === "logged-out")
        answer({ error: { code: -32000, message: "Authentication required" } });
      else answer({ result: { sessionId: "conversation-one" } });
    } else if (method === "session/prompt") {
      answer({ result: { stopReason: "end_turn" } });
      await finish();
    } else if (id !== undefined) answer({ result: {} });
  }
