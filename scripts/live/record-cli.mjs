// 사람이 돌리는 실제 시험 전용. 프로바이더 명령 자리에 놓여 입출력을 그대로 넘기며 비공개 폴더에 남긴다.
// 원본 기록은 모델 출력과 지침을 담으므로 Git 밖 로컬 기록 폴더에만 둔다. 인증 헤더와 환경 변수는 남기지 않는다.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import http from "node:http";
import path from "node:path";

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

const child = spawn(command[0], command.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
});
// 프로세스 그룹 신호는 자식도 함께 받는다. 자식이 끝날 때까지 기다린다.
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => record("signal", { signal }));

process.stdin.on("data", (chunk) => {
  record("stdin", { text: chunk.toString() });
  if (child.stdin.writable) child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  record("stdin-end", {});
  child.stdin.end();
});
child.stdin.on("error", () => {});
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
            answer.on("error", () => res.destroy());
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
      try {
        const frame = JSON.parse(line);
        if (typeof frame?.url === "string" && frame.url.startsWith("http:")) {
          const origin = await proxy(new URL(frame.url).origin);
          line = JSON.stringify({
            ...frame,
            url: origin + new URL(frame.url).pathname,
          });
        }
      } catch {
        /* JSON이 아닌 줄은 그대로 넘긴다. */
      }
      process.stdout.write(line + "\n");
    }
  });
});
child.on("close", (code, signal) => {
  record("exit", { code, signal });
  void queue.then(() => {
    if (pending) process.stdout.write(pending);
    log.end(() => process.exit(code ?? 1));
  });
});
child.on("error", (error) => {
  record("spawn-error", { code: error.code });
  log.end(() => process.exit(127));
});
