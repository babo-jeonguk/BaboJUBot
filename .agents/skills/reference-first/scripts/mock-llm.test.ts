// 참고 앱용 가짜 OpenAI 호환 서버(mock-llm.ts). 잘못된 인수·규칙 파일·요청을 기본값으로 접지 않고 이유와 함께 거절한다(#270 PR 3b-1).
// 실제 모델은 부르지 않는다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import {
  killUnlessGone,
  withCleanup,
  type CleanupStep,
} from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";

const script = fileURLToPath(new URL("./mock-llm.ts", import.meta.url));

test("refuses a missing, non-numeric or out-of-range port and unknown arguments before it listens", () => {
  for (const args of [
    ["--port"],
    ["--port", "abc"],
    ["--port", "1.5"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", ""],
    ["--rules"],
    ["--log"],
    ["--nope", "x"],
    ["--port", "8787", "--port", "8788"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    if (result.error) throw result.error;
    const shape = args.join(" ");
    assert.equal(result.status, 2, `${shape}: ${result.stderr}`);
    assert.match(result.stderr, /^bad argument: /m, shape);
    assert.match(result.stderr, /^usage: node /m, shape);
    assert.doesNotMatch(result.stdout, /mock-llm on/, shape);
  }
});

/** 서버를 띄우고 알린 주소를 받는다. 포트 0은 운영체제가 고른 빈 포트이고, 서버는 실제로 들은 포트를 알린다. */
async function serve(defer: (step: CleanupStep) => void, args: string[]) {
  const child = spawn(process.execPath, [script, "--port", "0", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  defer(async () => {
    if (child.pid !== undefined) killUnlessGone(child.pid);
    await within(exited, 10_000, "a killed mock-llm did not exit");
  });
  let output = "";
  const announced = new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const url = /mock-llm on (http:\/\/127\.0\.0\.1:\d+\/v1)\n/.exec(
        output
      )?.[1];
      if (url) resolve(url);
    });
    child.once("exit", (code) =>
      reject(new Error(`mock-llm exited ${code} before listening`))
    );
  });
  return within(announced, 30_000, "mock-llm did not announce its address");
}

/** 요청 하나를 보내고 상태와 본문을 받는다. */
async function post(url: string, body: string) {
  const answer = await fetch(`${url}/chat/completions`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: answer.status, text: await answer.text() };
}

test("listens on the port the system picks for port 0 and answers by its rules", async () => {
  await withCleanup(async (defer) => {
    const dir = mkdtempSync(path.join(tmpdir(), "babojubot-mock-llm-"));
    defer(() => removeFolder(dir));
    const rules = path.join(dir, "rules.json");
    writeFileSync(
      rules,
      JSON.stringify([{ match: "^fail", status: 503, error: "down" }])
    );
    const url = await serve(defer, ["--rules", rules]);
    assert.doesNotMatch(url, /:0\/v1$/);
    const plain = await post(
      url,
      JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
    );
    assert.equal(plain.status, 200, plain.text);
    assert.match(plain.text, /"content":"mock reply"/);
    const failed = await post(
      url,
      JSON.stringify({ messages: [{ role: "user", content: "fail now" }] })
    );
    assert.equal(failed.status, 503, failed.text);
    assert.match(failed.text, /"message":"down"/);
  });
});

// 잘못된 규칙(필드의 타입이 다름)을 없는 필드로 보면, 규칙이 조용히 모든 메시지에 걸리거나(match) 빠진다(status·delay).
test("answers 500 naming a rule whose fields are not the documented types", async () => {
  await withCleanup(async (defer) => {
    const dir = mkdtempSync(path.join(tmpdir(), "babojubot-mock-llm-"));
    defer(() => removeFolder(dir));
    const url = await serve(defer, ["--rules", path.join(dir, "rules.json")]);
    for (const rule of [
      { match: 1, reply: "a" },
      { match: "^a", status: "500" },
      { match: "^a", delay: "1000" },
      { match: "^a", reply: 3 },
      { match: "^a", hang: "yes" },
      { match: "^a", message: "text" },
      "not a rule",
    ]) {
      writeFileSync(path.join(dir, "rules.json"), JSON.stringify([rule]));
      const answer = await post(
        url,
        JSON.stringify({ messages: [{ role: "user", content: "a" }] })
      );
      assert.equal(answer.status, 500, JSON.stringify(rule));
      assert.match(answer.text, /rule 0/, JSON.stringify(rule));
    }
  });
});

// OpenAI API처럼 요청의 모양이 틀리면 400이다. 빈 글로 보고 기본 답을 주면 참고 앱의 요청 결함이 가려진다.
test("answers 400 to a request without a message list or with a stream flag that is not true or false", async () => {
  await withCleanup(async (defer) => {
    const url = await serve(defer, []);
    for (const body of [
      "",
      "{}",
      JSON.stringify({ messages: "hi" }),
      JSON.stringify({ messages: [{ role: "user", content: 3 }] }),
      JSON.stringify({ messages: [], stream: "yes" }),
      "[]",
    ]) {
      const answer = await post(url, body);
      assert.equal(answer.status, 400, `${body}: ${answer.text}`);
      assert.match(answer.text, /"type":"invalid_request_error"/, body);
    }
  });
});
