// 사람이 돌리는 실제 시험 전용. 프로바이더 명령 자리에 놓여 입출력을 그대로 넘기며 비공개 폴더에 남긴다.
// 원본 기록은 모델 출력과 지침을 담으므로 Git 밖 로컬 기록 폴더에만 둔다. 인증 헤더와 환경 변수는 남기지 않는다.
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { launchTree, prepareSupervisor } from "@babojubot/process";
import {
  failureCode,
  isDisconnect,
  orIfUnreadable,
} from "@babojubot/contracts";

const [directory, program, ...programArgs] = process.argv.slice(2);
if (directory === undefined || program === undefined) {
  console.error(
    "Usage: node scripts/live/record-cli.mjs <recording folder> <program> [arguments...]"
  );
  process.exit(2);
}
const startedAt = Date.now();
const log = createWriteStream(
  path.join(directory, `${startedAt}-${process.pid}.jsonl`),
  { flags: "wx", mode: 0o600 }
);
const record = (kind, value) =>
  log.write(
    JSON.stringify({ ms: Date.now() - startedAt, kind, ...value }) + "\n"
  );
record("start", { argv: programArgs, cwd: process.cwd() });

// 감독 실행기 없이는 띄우지 않는다. 준비하지 못하면 launchTree가 그 이유로 거절한다.
await prepareSupervisor();
// 실제 프로그램은 공용 실행으로 띄운다. 자기 그룹(Windows는 묶음)에 들어가므로 이 중계가 받은 신호를 넘기고, 끝나면 그 트리를 끈다.
// 이 중계를 띄운 제품의 표식도 물려받으므로, 이 중계가 먼저 강제로 끝나도 제품의 끄기가 그 트리에 닿는다.
const child = launchTree({
  command: [program, ...programArgs],
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
  if (!isDisconnect(error)) record("stdin-error", { code: failureCode(error) });
});
child.stderr.on("data", (chunk) => {
  record("stderr", { text: chunk.toString() });
  process.stderr.write(chunk);
});

/** `serve --stdio`가 알린 주소 앞에 기록용 프록시를 둔다(OpenCode). */
function proxy(target) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // 서버가 받은 요청에는 늘 주소가 있다. 없으면 넘길 곳을 모르므로 거절한다.
      const { url } = req;
      if (url === undefined) {
        res.writeHead(400).end();
        return;
      }
      // 본문은 끝까지 받은 뒤에 넘긴다. 요청자가 본문 중간에 떠나면 Node가 그 요청을 오류로 끝내고 `end`는 오지 않는다. 읽기가
      // 정상 끝·오류·중간 닫힘을 함께 받으므로, 그때는 그 실패를 남기고 상류로 넘기지 않는다.
      void buffer(req).then(
        (sent) => passOn(sent, url),
        (error) => {
          record("http-request-error", {
            method: req.method,
            url,
            code: failureCode(error),
          });
          res.destroy();
        }
      );
      /** 끝까지 받은 요청을 상류로 넘기고 그 답을 요청자에게 넘긴다. */
      function passOn(sent, url) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        record("http-request", {
          id,
          method: req.method,
          url,
          body: sent.toString(),
        });
        const upstream = http.request(
          new URL(url, target),
          // 기록이 읽히도록 압축하지 않은 응답을 받는다.
          {
            method: req.method,
            headers: { ...req.headers, "accept-encoding": "identity" },
          },
          (answer) => {
            const status = answer.statusCode;
            record("http-response", { id, status });
            // 받은 응답에는 늘 상태가 있다. 없으면 넘길 수 없으므로 끊는다.
            if (status === undefined) {
              res.destroy();
              return;
            }
            res.writeHead(status, answer.headers);
            answer.on("data", (chunk) => {
              record("http-chunk", { id, text: chunk.toString() });
              res.write(chunk);
            });
            answer.on("end", () => {
              record("http-end", { id });
              res.end();
            });
            answer.on("error", (error) => {
              record("http-error", { id, code: failureCode(error) });
              res.destroy();
            });
          }
        );
        upstream.on("error", (error) => {
          record("http-error", { id, code: failureCode(error) });
          res.destroy();
        });
        res.on("close", () => upstream.destroy());
        upstream.end(sent);
      }
    });
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      // TCP로 들었으므로 주소는 포트가 있는 객체다(문자열은 파이프·소켓 경로).
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(
          new Error(`record-cli: the proxy is not on a TCP port (${address})`)
        );
      else resolve(`http://127.0.0.1:${address.port}`);
    });
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
/**
 * 넘긴 출력을 모두 쓴 뒤에 이행한다. POSIX의 파이프 쓰기는 비동기라 `process.exit()`가 아직 쓰지 못한 출력을 버린다(Node 문서
 * process `A note on process I/O`·`process.exit()`). 빈 쓰기의 콜백은 앞선 쓰기가 끝난 뒤에 온다. 쓰지 못했으면 false다.
 */
const flushed = () =>
  Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise((resolve) => stream.write("", (error) => resolve(!error)))
    )
  ).then((results) => results.every(Boolean));
/**
 * 기록을 닫고, 넘긴 출력을 다 쓴 뒤 끝낸다. 기록을 다 쓰지 못한 녹화는 쓸 수 없으므로 원인을 오류 출력에 남기고 실패로 끝낸다.
 * 넘긴 출력을 다 쓰지 못했어도 실패로 끝낸다.
 */
const exitAfterLog = (code) =>
  log.end((error) => {
    if (error)
      process.stderr.write(
        `[record-cli] the recording could not be written (${failureCode(error)})\n`
      );
    void flushed().then((written) =>
      process.exit(error || !written ? 1 : code)
    );
  });
/** 트리가 끝난 뒤 프로그램의 출력이 닫히기까지의 상한. */
const outputCloseMs = 10_000;
/**
 * 프로그램의 출력(표준 출력·오류)이 모두 닫혔는가. 트리가 끝났으니 출력을 쥔 프로그램은 없어 곧 닫히고, 닫힐 때까지 마지막 조각을
 * 넘긴다(공용 실행 `runTree`와 같은 판단). 상한 안에 닫히지 않거나 읽기가 실패하면 그 이유를 남기고 false다.
 */
const outputClosed = () =>
  Promise.all(
    [child.stdout, child.stderr].map((stream) =>
      stream.closed
        ? undefined
        : once(stream, "close", { signal: AbortSignal.timeout(outputCloseMs) })
    )
  ).then(
    () => true,
    (error) => {
      record("output-not-closed", { code: failureCode(error) });
      return false;
    }
  );
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
  const started = await child.started;
  if (stopped && started.kind === "failed") {
    record("spawn-error", { code: failureCode(started.error) });
    exitAfterLog(127);
    return;
  }
  const { code, signal } = stopped
    ? await child.exited
    : { code: null, signal: null };
  record("exit", { code, signal });
  // 프로그램의 끝(`exit`)과 그 출력의 끝은 따로 온다: 마지막 출력은 끝난 뒤에 닿을 수 있다(Node 문서 child_process `'exit'`).
  // 끄기가 트리의 끝을 확인했을 때만 출력이 닫히기를 기다린다. 확인하지 못했으면 출력을 쥔 프로그램이 남았을 수 있다.
  const complete = stopped && (await outputClosed());
  await queue;
  if (pending) process.stdout.write(pending);
  exitAfterLog(complete ? (code ?? 1) : 1);
})();
