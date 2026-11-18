// CI의 OpenCode 내려받기(.github/workflows/scaffold.yml `Install OpenCode`)가 쓰는 curl 옵션을 그대로 꺼내
// 이 컴퓨터의 HTTP 서버에 돌린다. 일시적인 오류 뒤에는 회복하고, 영구 오류는 바로 실패하고,
// 시도가 다 떨어지면 마지막 오류로 실패하는지 본다(#218). curl이 없으면 건너뛴다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../.github/workflows/scaffold.yml", import.meta.url),
    "utf8"
  )
);
const install = workflow.jobs["test-opencode"].steps.find(
  (each) => each.name === "Install OpenCode"
);
// `curl <옵션> -o "$archive" \` 줄에서 옵션만 꺼낸다. 옵션에는 따옴표·변수가 없어야 한다.
const flags = /^\s*curl ([^"$\\\n]+?) -o "\$archive" \\$/m
  .exec(install.run)?.[1]
  .split(/\s+/);
const hasCurl = spawnSync("curl", ["--version"]).status === 0;

test("downloads to a file with curl's transient-only retries", () => {
  assert.ok(flags, install.run);
  assert.deepEqual(
    flags.slice(flags.indexOf("--retry"), flags.indexOf("--retry") + 2),
    ["--retry", "2"]
  );
  // 실패한 HTTP 응답을 파일로 남기지 않고, 재시도 경고와 마지막 오류를 로그에 남긴다.
  assert.ok(flags.includes("-fSL") && flags.includes("--no-progress-meter"));
  assert.ok(!flags.includes("--retry-all-errors"));
  // 받은 묶음은 파일에서 푼다(파이프로 받으면 curl이 받다 만 내용을 버리지 못한다).
  assert.doesNotMatch(install.run, /curl[^\n]*\|/);
  assert.match(install.run, /tar -xzf "\$archive"/);
});

// statuses[i]는 i번째 요청의 응답 코드다. 모자라면 마지막 값을 쓴다.
async function serve(statuses, context) {
  const requests = [];
  const server = createServer((request, response) => {
    const status = statuses[Math.min(requests.length, statuses.length - 1)];
    requests.push(request.url);
    // curl이 기다리지 않도록 Retry-After를 0으로 준다.
    response.writeHead(status, { "retry-after": "0" });
    response.end(status === 200 ? "archive" : `error ${status}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  return {
    url: `http://127.0.0.1:${server.address().port}/opencode.tar.gz`,
    requests,
  };
}

async function download(url, context) {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-download-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.tar.gz");
  // 시험에서는 재시도 사이 대기를 0초로 둔다. 시도 횟수와 오류 판단은 workflow 옵션 그대로다.
  const child = spawn(
    "curl",
    [...flags, "--retry-delay", "0", "-o", file, url],
    {
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  // 시험마다 시한을 둔다. 넘기면 curl을 끝내 종료 코드 없이(null) 돌려준다.
  const deadline = setTimeout(() => child.kill(), 20_000);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(deadline));
  return { status, stderr, file };
}

test(
  "recovers when the server fails transiently and then answers",
  { skip: !hasCurl },
  async (context) => {
    const server = await serve([503, 502, 200], context);
    const result = await download(server.url, context);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(server.requests.length, 3);
    assert.equal(readFileSync(result.file, "utf8"), "archive");
  }
);

test(
  "fails at once on a permanent error such as 404",
  { skip: !hasCurl },
  async (context) => {
    const server = await serve([404, 200], context);
    const result = await download(server.url, context);
    assert.notEqual(result.status, 0);
    assert.equal(server.requests.length, 1);
    assert.match(result.stderr, /404/);
    assert.equal(existsSync(result.file), false);
  }
);

test(
  "fails with the last error after three attempts",
  { skip: !hasCurl },
  async (context) => {
    const server = await serve([503], context);
    const result = await download(server.url, context);
    assert.notEqual(result.status, 0);
    assert.equal(server.requests.length, 3);
    assert.match(result.stderr, /retries? left/);
    assert.match(result.stderr, /503/);
  }
);

// 모든 시도가 전송 시한까지 기다리거나 서버가 Retry-After로 긴 대기를 요구해도, 단계 시한 안에서 마지막 오류와 안내를
// 남겨야 한다(PR #221 외부 리뷰 SPEC-2·SPEC-3). 서버가 정한 대기는 --max-time이 막지 못하므로 --retry-max-time으로
// 재시도 전체를 묶는다. 그 시간 안에 시작한 마지막 시도는 --max-time까지 돌 수 있다(curl --retry-max-time 문서).
// 최악 시간 = --retry-max-time + --max-time + 압축 풀기·안내 여유 30초.
test("fits the retries' worst case, server-requested waits included, inside the install step's time limit", () => {
  const value = (name) => Number(flags[flags.indexOf(name) + 1]);
  const total = value("--retry-max-time");
  const perAttempt = value("--max-time");
  assert.ok(total > 0, "--retry-max-time bounds every retry and wait");
  assert.ok(perAttempt > 0, "--max-time bounds each attempt");
  const worst = total + perAttempt + 30;
  assert.ok(
    worst <= install["timeout-minutes"] * 60,
    `${worst}s > ${install["timeout-minutes"]} minutes`
  );
});

// 서버가 429와 함께 단계 시한보다 긴 대기(Retry-After 600초)를 요구하면 기다리지 않고 그 오류로 바로 끝난다.
test(
  "fails at once with the last error when the server asks to wait longer than the retry budget",
  { skip: !hasCurl },
  async (context) => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(429, { "retry-after": "600" });
      response.end("slow down");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => server.close());
    const started = Date.now();
    const result = await download(
      `http://127.0.0.1:${server.address().port}/opencode.tar.gz`,
      context
    );
    assert.equal(result.status, 22, result.stderr);
    assert.equal(requests.length, 1);
    assert.match(result.stderr, /429/);
    assert.ok(Date.now() - started < 10_000);
  }
);

// 연결은 됐는데 본문이 멈추는 서버. 시험에서는 전송 시한만 1초로 줄인다(뒤에 준 --max-time이 앞의 값을 덮는다).
test(
  "retries a stalled transfer as a timeout and fails with that error after three attempts",
  { skip: !hasCurl },
  async (context) => {
    const requests = [];
    const sockets = new Set();
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(200, { "content-length": "100" });
      response.write("partial");
    });
    server.on("connection", (socket) => sockets.add(socket));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    const dir = mkdtempSync(path.join(tmpdir(), "ci-download-"));
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    const child = spawn(
      "curl",
      [
        ...flags,
        "--max-time",
        "1",
        "--retry-delay",
        "0",
        "-o",
        path.join(dir, "archive.tar.gz"),
        `http://127.0.0.1:${server.address().port}/opencode.tar.gz`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 28, stderr);
    assert.equal(requests.length, 3);
    assert.match(stderr, /retries? left/);
    assert.match(stderr, /timed out/i);
  }
);
