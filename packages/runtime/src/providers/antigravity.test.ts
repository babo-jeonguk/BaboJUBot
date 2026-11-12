import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { request } from "./test-support.ts";

// `agy acp`(Agent Client Protocol) 대화를 정해진 순서로 재생해 adapter를 본다. 프레임 모양은 agy 1.5.4의 실제 출력(#148)을 따른다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const rpc = (id: number, body: Record<string, unknown>) => ({
  frame: { jsonrpc: "2.0", id, ...body },
});
const update = (text: string) => ({
  frame: {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "saved",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  },
});
/** 세션을 열기까지의 대화. 조직 도구는 세션을 열 때 이 실행 시도의 토큰과 함께 받는다. */
const opening = [
  { input: { method: "initialize" } },
  rpc(1, { result: { protocolVersion: 1 } }),
  {
    input: {
      method: "session/new",
      params: {
        mcpServers: [
          {
            type: "http",
            name: "organization",
            headers: [
              { name: "Authorization", value: "Bearer private-run-token" },
            ],
          },
        ],
      },
    },
  },
  rpc(2, { result: { sessionId: "saved" } }),
];
async function run(
  steps: Record<string, unknown>[],
  options: { model?: string } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), "agy-acp-"));
  roots.push(root);
  const fixture = path.join(root, "fixture.json");
  await writeFile(
    fixture,
    JSON.stringify({
      version: "9.9.9",
      argv: { acp: true, "--dangerously-skip-permissions": true },
      steps,
    })
  );
  const result = await createAntigravityProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ],
  }).adapter.execute(
    {
      ...request(),
      ...(options.model ? { model: options.model } : {}),
      workspace: { cwd: root, organization: root, personal: root, peers: [] },
    },
    { signal: new AbortController().signal, emit: async () => {} }
  );
  return { result, root };
}
const prompt = {
  input: { method: "session/prompt", params: { sessionId: "saved" } },
};

it("gives the organization tools only to the ACP session, writes nothing into the workspace, and takes the usage as the program counts it", async () => {
  const { result, root } = await run([
    ...opening,
    prompt,
    update("완료"),
    rpc(3, {
      result: {
        stopReason: "end_turn",
        // 입력은 이미 캐시 읽기를 뺀 값이다(1.5.4).
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedReadTokens: 5,
          cachedWriteTokens: 0,
          thoughtTokens: 0,
          totalTokens: 19,
        },
      },
    }),
    { inputEnd: true },
    { exit: 0 },
  ]);
  expect(result.stopReason).toBe("completed");
  expect(result.nextSession?.id).toBe("saved");
  expect(result.usage).toEqual({
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    costUsd: null,
  });
  expect(await readdir(root)).not.toContain(".agents");
});

it("does not run on another model when the chosen one cannot be selected", async () => {
  const { result } = await run(
    [
      ...opening,
      {
        input: {
          method: "session/set_model",
          params: { sessionId: "saved", modelId: "gone-model" },
        },
      },
      rpc(3, { error: { code: -32602, message: "Unknown model ID" } }),
      // 본 요청을 보내지 않고 입력을 닫는다.
      { inputEnd: true },
      { exit: 0 },
    ],
    { model: "gone-model" }
  );
  expect(result.stopReason).toBe("failed");
  expect(result.error).toContain("모델");
});

it("reports a run without a login as needing one", async () => {
  const { result } = await run([
    { input: { method: "initialize" } },
    rpc(1, { result: { protocolVersion: 1 } }),
    { input: { method: "session/new" } },
    rpc(2, { error: { code: -32000, message: "Authentication required" } }),
    { inputEnd: true },
    { exit: 0 },
  ]);
  expect(result).toMatchObject({
    stopReason: "failed",
    errorCode: "login_required",
  });
});

describe("a turn the program ends with its error notice", () => {
  /**
   * 실제 프로그램(1.5.4)은 실행 오류를 실패 종료로 알리지 않는다. 문구 한 줄과 end_turn만 보내고, 이유는 `--log-file`의 기록에만 남긴다.
   * 그 기록 한 줄을 쓰고 같은 대화를 하는 프로그램.
   */
  async function failing(log: string) {
    const root = await mkdtemp(path.join(tmpdir(), "agy-acp-error-"));
    roots.push(root);
    const script = path.join(root, "agy.mjs");
    await writeFile(
      script,
      `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const at = args.indexOf("--log-file");
const out = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") out({ id, result: { protocolVersion: 1 } });
  else if (method === "session/new") out({ id, result: { sessionId: "saved" } });
  else if (method === "session/prompt") {
    if (at >= 0) appendFileSync(args[at + 1], ${JSON.stringify(log)} + "\\n");
    out({ method: "session/update", params: { sessionId: "saved", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\\n⚠ Agent execution terminated due to error.\\n" } } } });
    out({ id, result: { stopReason: "end_turn" } });
  }
}`
    );
    return createAntigravityProvider({
      dataDir: root,
      command: [process.execPath, script],
    }).adapter.execute(
      {
        ...request(),
        workspace: { cwd: root, organization: root, personal: root, peers: [] },
      },
      { signal: new AbortController().signal, emit: async () => {} }
    );
  }

  it("fails the run, and needs a login when the program's log says the login was refused", async () => {
    expect(
      await failing(
        "agent executor error: generating and executing: UNAUTHENTICATED (code 401)"
      )
    ).toMatchObject({ stopReason: "failed", errorCode: "login_required" });
  }, 20_000);

  it("fails the run without blaming the login when the log says something else", async () => {
    const result = await failing(
      "agent executor error: RESOURCE_EXHAUSTED (code 429)"
    );
    expect(result.stopReason).toBe("failed");
    expect(result.errorCode).toBeUndefined();
  }, 20_000);
});

describe("usage numbers outside the contract (#140)", () => {
  const warnings = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return {
      lines: () => warn.mock.calls.map((call) => call.join(" ")),
      [Symbol.dispose]: () => warn.mockRestore(),
    };
  };

  it("leaves only the numbers outside the contract unreported", async () => {
    using warn = warnings();
    const { result } = await run([
      ...opening,
      prompt,
      rpc(3, {
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: 1.5,
            outputTokens: -1,
            cachedReadTokens: 5,
            cachedWriteTokens: 0,
          },
        },
      }),
      { inputEnd: true },
      { exit: 0 },
    ]);
    expect(result.stopReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsd: null,
    });
    expect(warn.lines()).toEqual([
      expect.stringMatching(/inputTokens.*invalid_value/),
      expect.stringMatching(/outputTokens.*invalid_value/),
    ]);
  });

  it("reports no usage when the program ends without a result", async () => {
    const { result } = await run([...opening, prompt, { exit: 0 }]);
    expect(result.stopReason).toBe("failed");
    expect(result.nextSession).toBeNull();
    expect(result.usage).toBeNull();
  });
});
