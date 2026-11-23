// 실제 시험의 녹화 중계(record-cli.mjs)가 정상 입출력과 잘못된 입력·실패에서 어떻게 끝나는지(#284 리뷰 SPEC-REC-1). 실제 프로바이더
// CLI 대신 가짜 프로그램을 녹화하고, PATH를 비워 다른 프로그램을 띄울 수 없게 한다. 중계는 감독 실행기로 프로그램을 띄운다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDisconnect } from "@babojubot/contracts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { killUnlessGone, withCleanup } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";

const script = fileURLToPath(new URL("./record-cli.mjs", import.meta.url));
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("BABOJUBOT_")
    )
  ),
  PATH: "",
};

// 가짜 상위 프로그램: FAKE_URL이 있으면 OpenCode `serve --stdio`처럼 그 주소를 JSON 한 줄로 알리고, 받은 줄마다 `echo:`를 붙여
// 돌려준 뒤, 입력이 끝나면 종료 코드 3으로 끝난다. FAKE_BULK가 있으면 입력을 읽기 전에 그 수만큼의 줄을 쓴다.
const fakeProgram = `import { createInterface } from "node:readline";
if (process.env.FAKE_BULK)
  process.stdout.write(bulkLines(Number(process.env.FAKE_BULK)));
if (process.env.FAKE_URL)
  console.log(JSON.stringify({ type: "server.listening", url: process.env.FAKE_URL }));
process.stderr.write("fake stderr\\n");
for await (const line of createInterface({ input: process.stdin })) console.log("echo:" + line);
process.exitCode = 3;
function bulkLines(count) {
  return Array.from({ length: count }, (_, i) => "line " + i + "\\n").join("");
}
`;

/** 가짜 프로그램이 FAKE_BULK=`count`일 때 쓰는 줄들(가짜 안의 `bulkLines`와 같다). */
const bulkLines = (count) =>
  Array.from({ length: count }, (_, i) => `line ${i}\n`).join("");

/** 녹화 폴더와 가짜 프로그램. 시험이 끝나면 지운다. */
function folders(defer) {
  const dir = mkdtempSync(path.join(tmpdir(), "babojubot-record-cli-"));
  defer(() => removeFolder(dir));
  const recordings = path.join(dir, "recordings");
  mkdirSync(recordings);
  const program = path.join(dir, "fake-program.mjs");
  writeFileSync(program, fakeProgram);
  return { dir, recordings, program };
}

/** 녹화 하나(줄마다 한 기록). 중계 한 번은 녹화 파일 하나를 남긴다. */
function recording(recordings) {
  const files = readdirSync(recordings);
  assert.equal(files.length, 1, files.join(", "));
  const [file] = files;
  assert.ok(file);
  return readFileSync(path.join(recordings, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 시험 안의 사건 대기 상한. 넘기면 무엇을 기다렸는지 알리고 실패한다. */
const eventMs = 10_000;
/** 중계가 끝나기까지의 상한. 감독 실행기의 준비·끄기 확인이 그 안에 든다. */
const runMs = 60_000;

/**
 * 중계를 띄운다. 시험이 먼저 실패해도 정리가 끄고 끝나기를 기다린다. 끝남은 종료와 출력의 끝을 따로 본다: `exit` 때는 출력이 아직
 * 열려 있을 수 있어(마지막 조각이 뒤에 온다, Node 문서 child_process `'exit'`) 출력을 단언하기 전에 출력의 끝(`end`)까지 확인한다.
 */
function recordCli(defer, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...environment, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  /** 표준 출력에 완전한 줄이 처음 닿으면 이행한다. */
  const line = Promise.withResolvers();
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("\n")) line.resolve(undefined);
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  const stdoutEnded = once(child.stdout, "end");
  const outputEnded = Promise.all([stdoutEnded, once(child.stderr, "end")]);
  // 띄우지 못했으면 끌 프로세스가 없고, `exited`가 그 실패로 거절한다.
  defer(async () => {
    if (child.pid !== undefined) killUnlessGone(child.pid);
    await within(exited, eventMs, "a killed record-cli did not exit");
    await within(
      outputEnded,
      eventMs,
      "the output of a killed record-cli did not end"
    );
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    /** 표준 출력의 첫 줄. 줄 없이 출력이 끝나면 더 기다리지 않는다. 상한 안에 둘 다 오지 않으면 그렇게 알리고 실패한다. */
    firstLine: async () => {
      await within(
        Promise.race([line.promise, stdoutEnded]),
        runMs,
        "record-cli did not print an output line or end its output"
      );
      assert.ok(stdout.includes("\n"), `no output line: ${stderr}`);
      return stdout.slice(0, stdout.indexOf("\n"));
    },
    /**
     * 중계의 종료 코드. 종료와 출력의 끝을 각각 상한 안에 확인한 뒤 돌려주므로, 그 뒤의 `stdout()`·`stderr()`는 출력 전부다.
     * 상한 안에 오지 않으면 무엇이 오지 않았는지 알리고 실패한다.
     */
    ended: async () => {
      const [code] = await within(exited, runMs, "record-cli did not exit");
      await within(
        outputEnded,
        eventMs,
        "the output of record-cli did not end after it exited"
      );
      return code;
    },
  };
}

/** 시험이 끝나면 닫는 서버를 127.0.0.1의 빈 포트에서 듣게 하고 그 포트를 돌려준다. */
async function listen(defer, server) {
  server.listen(0, "127.0.0.1");
  await within(
    once(server, "listening"),
    eventMs,
    "the test server did not start listening"
  );
  defer(async () => {
    const closed = once(server, "close");
    server.close();
    await within(closed, eventMs, "the test server did not close");
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return address.port;
}

/** 중계가 알린 주소. 가짜 프로그램이 알린 주소 대신 같은 경로의 녹화 프록시 주소다. */
async function proxyUrl(run, announced) {
  const frame = JSON.parse(await run.firstLine());
  assert.equal(typeof frame.url, "string", JSON.stringify(frame));
  const url = new URL(frame.url);
  assert.notEqual(url.origin, new URL(announced).origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, new URL(announced).pathname);
  return url;
}

/**
 * 시험이 연 프록시 연결. 시험 쪽은 끝까지 닫지 않으므로(정리만 끊는다) `closed`는 프록시가 끊었다는 뜻이다. 프록시가 끊어 생긴
 * 끊김(재설정 등)도 닫힘이고, 그 밖의 오류로 끝나면 그 오류로 거절한다. `reply()`는 그때까지 받은 답이다.
 */
async function openToProxy(defer, proxy) {
  const socket = net.connect(Number(proxy.port), "127.0.0.1");
  defer(() => socket.destroy());
  let reply = "";
  socket.on("data", (chunk) => (reply += chunk));
  const closed = new Promise((resolve, reject) => {
    socket.once("close", () => resolve(undefined));
    socket.on("error", (error) => {
      if (!isDisconnect(error)) reject(error);
    });
  });
  await within(
    once(socket, "connect"),
    eventMs,
    "the connection to the proxy did not open"
  );
  return { socket, closed, reply: () => reply };
}

test("record-cli answers a missing folder or program with its usage", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "babojubot-record-cli-usage-"));
  context.after(() => removeFolder(dir));
  for (const args of [[], [dir]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: environment,
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      2,
      `${args.length} arguments: ${result.stderr}`
    );
    assert.match(result.stderr, /^Usage: node scripts\/live\/record-cli\.mjs /);
    assert.deepEqual(readdirSync(dir), [], "a recording was started");
  }
});

test("record-cli passes a program's input, output and exit code through and records them", async () => {
  await withCleanup(async (defer) => {
    const { recordings, program } = folders(defer);
    const run = recordCli(defer, [recordings, process.execPath, program]);
    run.child.stdin.end("hello\n");
    assert.equal(await run.ended(), 3, run.stderr());
    assert.equal(run.stdout(), "echo:hello\n");
    assert.match(run.stderr(), /fake stderr/);
    const rows = recording(recordings);
    assert.deepEqual(rows.find((row) => row.kind === "start")?.argv, [program]);
    assert.deepEqual(
      rows
        .filter((row) => row.kind === "stdin" || row.kind === "stdout")
        .map((row) => [row.kind, row.text]),
      [
        ["stdin", "hello\n"],
        ["stdout", "echo:hello\n"],
      ]
    );
    assert.ok(rows.some((row) => row.kind === "stdin-end"));
    assert.ok(rows.some((row) => row.kind === "stderr"));
    assert.deepEqual(
      rows.filter((row) => row.kind === "exit").map(({ code }) => code),
      [3]
    );
  });
});

// 중계는 프로그램의 출력을 자기 표준 출력(파이프)으로 넘긴다. POSIX의 파이프 쓰기는 비동기라 `process.exit()`가 아직 넘기지 못한
// 출력을 버린다(Node 문서 process `A note on process I/O`·`process.exit()`). 또 프로그램이 끝난 뒤에도 그 출력의 마지막 조각은 늦게
// 닿을 수 있다(child_process `'exit'`). 파이프 버퍼보다 훨씬 큰 출력도 빠짐없이 넘기고 끝나는지 본다.
test("record-cli passes all of a program's output through, however large, before it ends", async () => {
  await withCleanup(async (defer) => {
    const { recordings, program } = folders(defer);
    const count = 400_000;
    const run = recordCli(defer, [recordings, process.execPath, program], {
      FAKE_BULK: String(count),
    });
    run.child.stdin.end("last\n");
    assert.equal(await run.ended(), 3, run.stderr());
    const expected = `${bulkLines(count)}echo:last\n`;
    assert.equal(run.stdout().length, expected.length);
    assert.ok(
      run.stdout() === expected,
      "the output was not passed as written"
    );
  });
});

test("record-cli puts a recording proxy in front of the address the program announces", async () => {
  await withCleanup(async (defer) => {
    const { recordings, program } = folders(defer);
    /** @type {(string | undefined)[]} 상위 서버가 받은 압축 요청 머리 */
    const encodings = [];
    const upstream = http.createServer((req, res) => {
      encodings.push(req.headers["accept-encoding"]);
      res.end(`upstream:${req.url}`);
    });
    const port = await listen(defer, upstream);
    const announced = `http://127.0.0.1:${port}/base`;
    const run = recordCli(defer, [recordings, process.execPath, program], {
      FAKE_URL: announced,
    });
    const proxy = await proxyUrl(run, announced);
    const answer = await fetch(new URL("/hello", proxy), {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), "upstream:/hello");
    // 기록이 읽히도록 압축하지 않은 응답을 받는다.
    assert.deepEqual(encodings, ["identity"]);
    run.child.stdin.end();
    assert.equal(await run.ended(), 3, run.stderr());
    const rows = recording(recordings);
    assert.deepEqual(
      rows
        .filter((row) => row.kind.startsWith("http-"))
        .map(({ kind, method, url, status, text }) => ({
          kind,
          method,
          url,
          status,
          text,
        })),
      [
        {
          kind: "http-request",
          method: "GET",
          url: "/hello",
          status: undefined,
          text: undefined,
        },
        {
          kind: "http-response",
          method: undefined,
          url: undefined,
          status: 200,
          text: undefined,
        },
        {
          kind: "http-chunk",
          method: undefined,
          url: undefined,
          status: undefined,
          text: "upstream:/hello",
        },
        {
          kind: "http-end",
          method: undefined,
          url: undefined,
          status: undefined,
          text: undefined,
        },
      ]
    );
  });
});

// 코드의 "상태 없는 응답" 확인은 타입 때문이다. 통신에서 같은 경우(상태 줄이 깨진 응답)는 Node가 응답 대신 오류로 알린다. 그러면
// 중계는 그 오류를 남기고 요청한 쪽의 연결을 끊는다.
test("record-cli cuts and records a reply that has no valid status line", async () => {
  await withCleanup(async (defer) => {
    const { recordings, program } = folders(defer);
    /** @type {Set<net.Socket>} 상위 서버가 받은 연결 */
    const sockets = new Set();
    const upstream = net.createServer((socket) => {
      sockets.add(socket);
      socket.end("garbage\r\n\r\n");
    });
    const port = await listen(defer, upstream);
    // 응답을 해석하지 못한 쪽이 연결을 놓아도 이쪽 연결은 닫혔다는 알림 없이 남아 서버 닫기가 끝나지 않는다. 정리는 등록 역순이라
    // 서버를 닫기 전에 받은 연결을 먼저 끊는다.
    defer(() => {
      for (const socket of sockets) socket.destroy();
    });
    const announced = `http://127.0.0.1:${port}/`;
    const run = recordCli(defer, [recordings, process.execPath, program], {
      FAKE_URL: announced,
    });
    const proxy = await proxyUrl(run, announced);
    // 연결을 이어 쓰는 요청(HTTP/1.1 기본)이라 프록시가 답을 마쳐도 스스로 닫지 않는다. 닫힘은 프록시가 끊은 것이고, 시험의 상한을
    // 넘기면 끊김으로 받지 않고 그렇게 알리고 실패한다. 상태 줄을 쓰기 전에 끊으므로 받은 답은 없다.
    const connection = await openToProxy(defer, proxy);
    connection.socket.write("GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await within(
      connection.closed,
      eventMs,
      "the proxy did not cut the connection after the reply it could not read"
    );
    assert.equal(connection.reply(), "");
    run.child.stdin.end();
    assert.equal(await run.ended(), 3, run.stderr());
    const rows = recording(recordings);
    assert.deepEqual(
      rows
        .filter((row) => row.kind.startsWith("http-"))
        .map(({ kind, code }) => [kind, code]),
      [
        ["http-request", undefined],
        ["http-error", "HPE_INVALID_CONSTANT"],
      ]
    );
  });
});

// 코드의 "주소 없는 요청" 확인도 타입 때문이다. 통신에서 같은 경우(대상 없는 요청 줄)는 Node가 처리기에 넘기기 전에 400으로 답한다.
test("record-cli's proxy never takes a request that has no target", async () => {
  await withCleanup(async (defer) => {
    const { recordings, program } = folders(defer);
    const upstream = http.createServer((req, res) => res.end("unexpected"));
    const port = await listen(defer, upstream);
    const announced = `http://127.0.0.1:${port}/`;
    const run = recordCli(defer, [recordings, process.execPath, program], {
      FAKE_URL: announced,
    });
    const proxy = await proxyUrl(run, announced);
    const connection = await openToProxy(defer, proxy);
    connection.socket.write("GET HTTP/1.1\r\n\r\n");
    await within(
      connection.closed,
      eventMs,
      "the proxy did not close the connection after its answer"
    );
    assert.match(connection.reply(), /^HTTP\/1\.1 400 /);
    run.child.stdin.end();
    assert.equal(await run.ended(), 3, run.stderr());
    assert.deepEqual(
      recording(recordings).filter((row) => row.kind.startsWith("http-")),
      []
    );
  });
});

test("record-cli ends with 127 and records the failure when the program cannot start", async () => {
  await withCleanup(async (defer) => {
    const { dir, recordings } = folders(defer);
    const missing = path.join(dir, "missing-program");
    assert.equal(existsSync(missing), false);
    const run = recordCli(defer, [recordings, missing]);
    run.child.stdin.end();
    assert.equal(await run.ended(), 127, run.stderr());
    const rows = recording(recordings);
    assert.deepEqual(
      rows.filter((row) => row.kind === "spawn-error").length,
      1,
      JSON.stringify(rows)
    );
    assert.equal(
      rows.some((row) => row.kind === "exit"),
      false
    );
  });
});
