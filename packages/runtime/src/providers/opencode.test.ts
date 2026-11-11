import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createOpenCodeProvider } from "./opencode.ts";
import { request, saying } from "./test-support.ts";
it("runs an isolated v2 server per attempt, uses a free model, and stops it after success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-test-"));
  try {
    const provider = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    expect(
      await provider.adapter.checkReadiness(new AbortController().signal)
    ).toMatchObject({ status: "ready" });
    const input = request();
    input.instructions = [{ path: "role.md", content: "제품 역할 지침" }];
    const result = await provider.adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toMatch(/^ses_/);
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("keeps its SSE stream alive beyond the startup timeout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-long-"));
  try {
    const provider = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    const input = request();
    input.wakeReasons = saying("느린 작업")(
      input.access,
      input.identity
    ).wakeReasons;
    const result = await provider.adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

describe("usage numbers outside the contract (#140)", () => {
  async function run(usage: { before: unknown; after: unknown }) {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-usage-"));
    try {
      const file = path.join(root, "usage.json");
      await writeFile(file, JSON.stringify(usage));
      return await createOpenCodeProvider({
        dataDir: root,
        command: [
          process.execPath,
          path.resolve("test-fixtures/opencode-simulator.mjs"),
          "--usage",
          file,
        ],
      }).adapter.execute(request(), {
        signal: new AbortController().signal,
        emit: async () => {},
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("leaves a decreased, fractional or unsafe session total unreported and keeps the success and the other figures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await run({
        before: {
          tokens: { input: 100, output: 50, cache: { read: 10, write: 0 } },
          cost: 0.5,
        },
        after: {
          tokens: {
            input: 90,
            output: 60.5,
            cache: { read: 2 ** 53, write: 3 },
          },
          cost: 0.75,
        },
      });
      expect(result.stopReason).toBe("completed");
      expect(result.nextSession?.id).toMatch(/^ses_/);
      expect(result.usage).toEqual({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: 3,
        costUsd: 0.25,
      });
      expect(warn.mock.calls.map((call) => call.join(" "))).toEqual([
        expect.stringMatching(/inputTokens.*negative_result/),
        expect.stringMatching(/outputTokens.*invalid_value/),
        expect.stringMatching(/cacheReadTokens.*invalid_value/),
      ]);
    } finally {
      warn.mockRestore();
    }
  }, 20000);

  it("reads an unreported starting total as zero but not a bad one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await run({
        before: { tokens: { input: -1, output: 0 }, cost: null },
        after: {
          tokens: { input: 10, output: 4, cache: { read: 5, write: 1 } },
          cost: 0.1,
        },
      });
      expect(result.usage).toEqual({
        inputTokens: null,
        outputTokens: 4,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
        costUsd: 0.1,
      });
    } finally {
      warn.mockRestore();
    }
  }, 20000);
});

// #147: 2.2.6 `session.execution.failed`의 data.error(type·선택 status)만 읽어 제품이 쓴 문구로 알린다. 합성 재생이며 실제 SSE 녹화가 아니다.
describe("failed executions (#147)", () => {
  const secret = "sk-synthetic-147-secret";
  const research = "합성 연구 입력 147";
  async function run(failing: { error: unknown; foreign?: boolean }) {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-failed-"));
    try {
      const file = path.join(root, "fail.json");
      await writeFile(file, JSON.stringify(failing));
      const activities: unknown[] = [];
      const input = request();
      const result = await createOpenCodeProvider({
        dataDir: root,
        command: [
          process.execPath,
          path.resolve("test-fixtures/opencode-simulator.mjs"),
          "--fail",
          file,
        ],
      }).adapter.execute(input, {
        signal: new AbortController().signal,
        emit: async (activity) => {
          activities.push(activity);
        },
      });
      const prompts = (await readFile(file + ".prompts", "utf8"))
        .trim()
        .split("\n").length;
      return { result, activities, prompts, token: input.access.token };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // 원문 message·body와 덧붙은 필드에 비밀값·연구 내용이 섞여 있어도 공개 결과로 옮기지 않는다.
  const tainted = (type: string, status?: number) => ({
    type,
    message: `${type} ${secret} ${research}`,
    ...(status === undefined ? {} : { status }),
    response: {
      body: JSON.stringify({ error: { message: secret, input: research } }),
    },
    reasoning: research,
    retryAfterMs: 1000,
  });
  const exposes = (value: unknown, token: string) => {
    const text = JSON.stringify(value);
    return [secret, research, token, "provider.", "response"].some((s) =>
      text.includes(s)
    );
  };

  it("reports a refused request with a safe reason, not as login required, and sends the prompt once", async () => {
    const { result, activities, prompts, token } = await run({
      error: tainted("provider.invalid-request", 400),
    });
    expect(result).toMatchObject({
      stopReason: "failed",
      usage: null,
      error:
        "모델 서비스가 요청을 거부했습니다(HTTP 400). 도구 정의나 입력이 이 모델과 맞지 않을 수 있습니다.",
    });
    expect(result.errorCode ?? null).toBeNull();
    expect(prompts).toBe(1);
    expect(exposes(result, token) || exposes(activities, token)).toBe(false);
  }, 20000);

  it("leaves the status out when OpenCode gives none or an invalid one", async () => {
    for (const status of [undefined, 999, 400.5]) {
      const { result } = await run({
        error: { ...tainted("provider.invalid-request"), status },
      });
      expect(result.error, String(status)).toBe(
        "모델 서비스가 요청을 거부했습니다. 도구 정의나 입력이 이 모델과 맞지 않을 수 있습니다."
      );
    }
  }, 40000);

  it("reports an explicit authentication failure as login required", async () => {
    const { result, token } = await run({
      error: tainted("provider.auth", 401),
    });
    expect(result).toMatchObject({
      stopReason: "failed",
      errorCode: "login_required",
      error:
        "모델 서비스가 인증을 거부했습니다(HTTP 401). 프로바이더 로그인을 확인해 주세요.",
    });
    expect(exposes(result, token)).toBe(false);
  }, 20000);

  it("keeps the general failure for unknown, other or malformed errors", async () => {
    for (const error of [
      tainted("unknown"),
      tainted("provider.rate-limit", 429),
      tainted("provider.invalid-request-ish", 400),
      { message: secret, status: 400 },
      "provider.invalid-request",
      null,
    ]) {
      const { result, token } = await run({ error });
      expect(result, JSON.stringify(error)).toMatchObject({
        stopReason: "failed",
        error: "프로바이더 실행이 실패했습니다.",
      });
      expect(result.errorCode ?? null).toBeNull();
      expect(exposes(result, token)).toBe(false);
    }
  }, 60000);

  it("ignores another session's failure on the shared event stream", async () => {
    const { result } = await run({
      foreign: true,
      error: tainted("provider.invalid-request", 400),
    });
    expect(result.errorCode ?? null).toBeNull();
    expect(result.error).toMatch(/^모델 서비스가 요청을 거부했습니다/);
  }, 20000);
});

// #147: 실제 2.2.6은 새 조직 폴더에 서버 둘이 함께 뜨면 DB를 함께 만들다 하나가 끝났다. 시뮬레이터 `--startup-race`가 그 합성이다.
describe("one organization folder (#147)", () => {
  const racingAdapter = (root: string) =>
    createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--startup-race",
      ],
    }).adapter;
  const sameOrganization = (organizationId: string) => {
    const input = request();
    input.identity.organizationId = organizationId;
    input.context.organization.id = organizationId;
    return input;
  };

  it("starts the servers of two agents one at a time and lets both runs finish", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-race-"));
    try {
      const adapter = racingAdapter(root);
      const first = request();
      const results = await Promise.all(
        [first, sameOrganization(first.identity.organizationId)].map((input) =>
          adapter.execute(input, {
            signal: new AbortController().signal,
            emit: async () => {},
          })
        )
      );
      expect(results.map((r) => r.stopReason)).toEqual([
        "completed",
        "completed",
      ]);
      expect(results[0]!.nextSession?.id).not.toBe(results[1]!.nextSession?.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("stops waiting for its turn when cancelled and hands the turn on", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-race-"));
    try {
      const adapter = racingAdapter(root);
      const first = request();
      const organizationId = first.identity.organizationId;
      const run = (input: ReturnType<typeof request>, signal: AbortSignal) =>
        adapter.execute(input, { signal, emit: async () => {} });
      const running = run(first, new AbortController().signal);
      const cancel = new AbortController();
      const waiting = run(sameOrganization(organizationId), cancel.signal);
      setTimeout(() => cancel.abort(), 50);
      expect(await waiting).toMatchObject({
        stopReason: "cancelled",
        error: null,
      });
      const after = run(
        sameOrganization(organizationId),
        new AbortController().signal
      );
      expect((await running).stopReason).toBe("completed");
      expect((await after).stopReason).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
