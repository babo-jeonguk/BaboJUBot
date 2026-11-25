import { isDeepStrictEqual } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, onTestFinished, vi } from "vitest";
import { createOpenCodeProvider as unownedOpenCodeProvider } from "./opencode.ts";
import { request, saying } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// 시험 폴더는 정리가 지운다(시험이 실패해도 같다).
const folders = testFolders();
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createOpenCodeProvider = folders.owning(unownedOpenCodeProvider);
it("runs an isolated v2 server per attempt, uses a free model, and stops it after success", async () => {
  const root = await folders.make("opencode-test-");
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
}, 20000);

it("keeps its SSE stream alive beyond the startup timeout", async () => {
  const root = await folders.make("opencode-long-");
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
}, 20000);

describe("usage numbers outside the contract (#140)", () => {
  async function run(usage: { before: unknown; after: unknown }) {
    const root = await folders.make("opencode-usage-");
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
    const root = await folders.make("opencode-failed-");
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
// 먼저 차례를 잡은 서버는 시험이 gate를 열 때까지 뜨는 중에 머문다. 뒤 실행이 차례를 기다린다고 알린 것을 받은 뒤에 열거나 취소한다.
describe("one organization folder (#147)", () => {
  const waitingText = "먼저 시작한 OpenCode가 준비될 때까지 기다립니다.";
  const isWaiting = (activity: unknown) =>
    isDeepStrictEqual(activity, { type: "progress", text: waitingText });
  type Run = Promise<{ stopReason: string }>;
  /**
   * 도착 신호를 다시 확인해 기다린다. 상한(20초, 시험 시한 안)을 넘으면 `check`가 던진 오류(못 받은 신호)로 실패하고,
   * 그 전에 실행이 끝나면 그 결과와 함께 실패한다.
   */
  const arrival = (check: () => unknown, runs: Run[]) =>
    Promise.race([
      vi.waitFor(check, { timeout: 20_000 }),
      Promise.any(runs).then((result) => {
        throw new Error(
          `a run ended (${result.stopReason}) before the signal arrived`
        );
      }),
    ]);
  const racing = async () => {
    const root = await folders.make("opencode-race-");
    const gate = path.join(root, "startup-gate");
    const adapter = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--startup-race",
        gate,
      ],
    }).adapter;
    return {
      adapter,
      /** 먼저 차례를 잡은 서버가 gate에 닿을 때까지 기다린다. */
      atGate: (run: Run) =>
        arrival(async () => {
          try {
            await stat(`${gate}.reached`);
          } catch {
            throw new Error(
              "the first OpenCode server did not reach the startup gate"
            );
          }
        }, [run]),
      openGate: () => writeFile(gate, ""),
    };
  };
  const sameOrganization = (organizationId: string) => {
    const input = request();
    input.identity.organizationId = organizationId;
    input.context.organization.id = organizationId;
    return input;
  };
  /** 실행 활동에 차례 대기 문구가 왔는지 기록하고, 그 도착을 기다린다. */
  const waitingSignal = () => {
    let seen = false;
    return {
      emit: async (activity: unknown) => {
        if (isWaiting(activity)) seen = true;
      },
      before: (runs: Run[]) =>
        arrival(() => {
          if (!seen)
            throw new Error(
              "OpenCode startup waiting progress was not observed"
            );
        }, runs),
    };
  };

  it("starts the servers of two agents one at a time and lets both runs finish", async () => {
    const { adapter, openGate } = await racing();
    const first = request();
    const activities: unknown[] = [];
    const waiting = waitingSignal();
    const runs = [first, sameOrganization(first.identity.organizationId)].map(
      (input) =>
        adapter.execute(input, {
          signal: new AbortController().signal,
          emit: async (activity) => {
            activities.push(activity);
            await waiting.emit(activity);
          },
        })
    );
    // 먼저 차례를 잡은 서버는 gate가 닫혀 있는 동안 뜨는 중이다. 뒤 실행이 기다린다고 알린 뒤에 연다.
    await waiting.before(runs);
    await openGate();
    const results = await Promise.all(runs);
    expect(results.map((r) => r.stopReason)).toEqual([
      "completed",
      "completed",
    ]);
    // 뒤의 실행 하나만 기다렸다고 알린다.
    expect(activities.filter(isWaiting)).toHaveLength(1);
    // 두 실행 모두 세션을 남겼는지 먼저 본다. 한쪽이 비어 있으면 아래 비교는 다르다는 이유로 통과한다.
    const sessions = results.map((r) => r.nextSession?.id);
    expect(sessions).toEqual([expect.any(String), expect.any(String)]);
    expect(sessions[0]).not.toBe(sessions[1]);
  }, 30000);

  it("stops waiting for its turn when cancelled and hands the turn on", async () => {
    const { adapter, atGate, openGate } = await racing();
    const first = request();
    const organizationId = first.identity.organizationId;
    const run = (
      input: ReturnType<typeof request>,
      signal: AbortSignal,
      emit: (activity: unknown) => Promise<void> = async () => {}
    ) => adapter.execute(input, { signal, emit });
    const running = run(first, new AbortController().signal);
    // 취소할 실행이 뒤 차례가 되게, 앞 실행의 서버가 뜨는 중(gate)에 닿은 뒤에 시작한다.
    await atGate(running);
    const cancel = new AbortController();
    const signal = waitingSignal();
    const waiting = run(
      sameOrganization(organizationId),
      cancel.signal,
      signal.emit
    );
    // 차례를 기다리는 분기에 들어간 것을 확인한 뒤 취소한다. 앞 서버는 아직 뜨는 중이다(gate가 닫혀 있다).
    await signal.before([running, waiting]);
    cancel.abort();
    expect(await waiting).toMatchObject({
      stopReason: "cancelled",
      error: null,
    });
    // 취소한 실행이 차례를 넘겼으면, 다음 실행은 앞 서버가 뜬 뒤 차례를 받아 끝난다.
    const after = run(
      sameOrganization(organizationId),
      new AbortController().signal
    );
    await openGate();
    expect((await running).stopReason).toBe("completed");
    expect((await after).stopReason).toBe("completed");
  }, 30000);
});

// OpenCode는 서버를 연 뒤에도 Location의 plugin 활성화를 기다리며, 5초 안에 끝나지 않으면 모델 목록 등에 503 "plugin 활성화 중"으로
// 답한다(2.2.6 server/src/location.ts). 준비를 알리는 신호가 없어 adapter는 그 답만 상한 안에서 다시 묻는다(공식 Desktop 클라이언트와
// 같은 선례). 그 밖의 실패 답은 바로 실패이고, 진단에는 HTTP 상태가 코드로 남는다(#298 조사: 그동안 `(Error)`로 접혔다).
describe("plugins still activating (#286)", () => {
  async function run(scene: { busy: number; body?: unknown }) {
    const root = await folders.make("opencode-activating-");
    const file = path.join(root, "activating.json");
    await writeFile(file, JSON.stringify(scene));
    // 경고는 그대로 내보내고 기록만 한다.
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());
    const result = await createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--plugins-activating",
        file,
      ],
    }).adapter.execute(request(), {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    const asked = (await readFile(file + ".asked", "utf8"))
      .split("\n")
      .filter(Boolean).length;
    return { result, asked, warned: warn.mock.calls };
  }

  it("asks again while OpenCode's plugins are still activating, and runs once they are", async () => {
    const { result, asked, warned } = await run({ busy: 2 });
    expect(result.stopReason).toBe("completed");
    expect(asked).toBe(3);
    expect(warned).toEqual([]);
  }, 30_000);

  it("fails at once on any other unavailable answer, naming its HTTP status", async () => {
    const { result, asked, warned } = await run({
      busy: 1,
      body: {
        _tag: "ServiceUnavailableError",
        message: "Storage is not ready",
        service: "storage",
      },
    });
    expect(result.stopReason).toBe("failed");
    expect(asked).toBe(1);
    expect(warned).toEqual([["[provider] the OpenCode run failed (HTTP_503)"]]);
  }, 30_000);
});
