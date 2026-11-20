// 사람이 돌리는 실제 시험 전용. 프로바이더 명령 자리에 놓여 입출력을 그대로 넘기며 비공개 폴더에 남긴다.
// 원본 기록은 모델 출력과 지침을 담으므로 Git 밖 로컬 기록 폴더에만 둔다. 인증 헤더와 환경 변수는 남기지 않는다.
import { createWriteStream } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  launchTree,
  prepareJobObjectLauncher,
} from "@babojubot/runtime/launch";
import {
  failureCode,
  isDisconnect,
  orIfUnreadable,
} from "../../packages/contracts/src/failure.ts";

const [directory, ...command] = process.argv.slice(2);
const startedAt = Date.now();
const log = createWriteStream(
  path.join(directory, `${startedAt}-${process.pid}.jsonl`),
  { flags: "wx", mode: 0o600 }
);
const record = (kind, value) =>
  log.write(
    JSON.stringify({ ms: Date.now() - startedAt, kind, ...value }) + "\n"
  );
record("start", { argv: command.slice(1), cwd: process.cwd() });

// Windows는 묶음 실행기 없이 띄우지 않는다. 이 사용자의 임시 폴더에 한 번 만들어 둔다(다른 시스템에서는 아무것도 하지 않는다).
await prepareJobObjectLauncher(path.join(tmpdir(), "babojubot-record-cli"));
// 실제 프로그램은 공용 실행으로 띄운다. 자기 그룹(Windows는 묶음)에 들어가므로 이 중계가 받은 신호를 넘기고, 끝나면 그 트리를 끈다.
// 이 중계를 띄운 제품의 표식도 물려받으므로, 이 중계가 먼저 강제로 끝나도 제품의 끄기가 그 트리에 닿는다.
const child = launchTree({
  command: [command[0], ...command.slice(1)],
  args: [],
  cwd: process.cwd(),
  env: process.env,
  stdio: "pipe",
});
process.on("SIGINT", () => {
  record("signal", { signal: "SIGINT" });
  child.interrupt();
});
// 끄라는 신호다. 아래 흐름이 트리를 끄고 그 결과로 끝난다.
let requestStop;
const stopRequested = new Promise((resolve) => {
  requestStop = resolve;
});
process.on("SIGTERM", () => {
  record("signal", { signal: "SIGTERM" });
  requestStop();
});

process.stdin.on("data", (chunk) => {
  record("stdin", { text: chunk.toString() });
  if (child.stdin.writable) child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  record("stdin-end", {});
  child.stdin.end();
});
// 프로그램이 끝나 입력이 끊긴 것(EPIPE)은 답이다. 그 밖의 쓰기 실패는 기록에 남긴다.
child.stdin.on("error", (error) => {
  if (!isDisconnect(error)) record("stdin-error", { code: error.code });
});
child.stderr.on("data", (chunk) => {
  record("stderr", { text: chunk.toString() });
  process.stderr.write(chunk);
});

/** `serve --stdio`가 알린 주소 앞에 기록용 프록시를 둔다(OpenCode). */
function proxy(target) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        const sent = Buffer.concat(body);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        record("http-request", {
          id,
          method: req.method,
          url: req.url,
          body: sent.toString(),
        });
        const upstream = http.request(
          new URL(req.url, target),
          // 기록이 읽히도록 압축하지 않은 응답을 받는다.
          {
            method: req.method,
            headers: { ...req.headers, "accept-encoding": "identity" },
          },
          (answer) => {
            record("http-response", { id, status: answer.statusCode });
            res.writeHead(answer.statusCode, answer.headers);
            answer.on("data", (chunk) => {
              record("http-chunk", { id, text: chunk.toString() });
              res.write(chunk);
            });
            answer.on("end", () => {
              record("http-end", { id });
              res.end();
            });
            answer.on("error", (error) => {
              record("http-error", { id, code: error.code });
              res.destroy();
            });
          }
        );
        upstream.on("error", (error) => {
          record("http-error", { id, code: error.code });
          res.destroy();
        });
        res.on("close", () => upstream.destroy());
        upstream.end(sent);
      });
    });
    server.unref();
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`)
    );
  });
}

let pending = "";
let queue = Promise.resolve();
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  record("stdout", { text });
  queue = queue.then(async () => {
    pending += text;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      let line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      // JSON이 아닌 줄은 그대로 넘긴다. 해석만 감싸고, 기록 proxy를 띄우지 못한 실패는 드러낸다.
      const frame = orIfUnreadable(() => JSON.parse(line), undefined);
      if (typeof frame?.url === "string" && frame.url.startsWith("http:")) {
        const origin = await proxy(new URL(frame.url).origin);
        line = JSON.stringify({
          ...frame,
          url: origin + new URL(frame.url).pathname,
        });
      }
      process.stdout.write(line + "\n");
    }
  });
});
/** 기록을 닫고 끝낸다. 기록을 다 쓰지 못한 녹화는 쓸 수 없으므로 원인을 오류 출력에 남기고 실패로 끝낸다. */
const exitAfterLog = (code) =>
  log.end((error) => {
    if (error)
      process.stderr.write(
        `[record-cli] the recording could not be written (${failureCode(error)})\n`
      );
    process.exit(error ? 1 : code);
  });
void (async () => {
  // 프로그램이 끝나거나 끄라는 신호가 오면 트리를 끈다(프로그램이 남긴 것까지). 끄기를 시작한 뒤의 끝은 끄기의 결과가 정한다: 끝났음을
  // 확인하지 못하면 그 이유를 남기고 실패로 끝난다.
  await Promise.race([child.exited, stopRequested]);
  const stopped = await child.stop().then(
    () => true,
    (error) => {
      record("stop-failed", { code: failureCode(error) });
      return false;
    }
  );
  if (stopped && (await child.started).kind === "failed") {
    record("spawn-error", { code: failureCode((await child.started).error) });
    exitAfterLog(127);
    return;
  }
  const { code, signal } = stopped
    ? await child.exited
    : { code: null, signal: null };
  record("exit", { code, signal });
  await queue;
  if (pending) process.stdout.write(pending);
  exitAfterLog(stopped ? (code ?? 1) : 1);
})();
