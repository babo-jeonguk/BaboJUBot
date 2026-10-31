import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  orgTools,
  orgToolsBasePath,
  providerCapabilitiesSchema,
  providerReadinessCheckSchema,
  runResultSchema,
  runtimeActivitySchema,
  type ConversationMessage,
  type RunCancel,
  type RunIdentity,
  type RunRequest,
  type RunResult,
  type RuntimeAdapter,
  type SessionState,
} from "@babojubot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 프로바이더 계약(contracts `RuntimeAdapter`)의 공통 검사. 프로바이더 adapter마다 장면 두 개를 주고 같은 약속과
// 그 adapter가 선언한 일(`capabilities`)이 동작과 맞는지 확인한다.
// 실행 맥락 조회와 Lead 대화 답장만 받는 작은 가짜 도구 HTTP 서버를 직접 띄우며, 그 밖의 도구는 501 `not_implemented`다.

/**
 * 장면: 가짜 도구 서버의 주소·토큰과 실행 시도 신원을 받아 실행 시도 요청 한 장을 만든다. 신원은 공통 검사가 정하며,
 * 같은 에이전트의 다음 실행 시도를 재현할 때는 조직·에이전트를 그대로 두고 실행 시도 ID만 바꾼다.
 */
export type RuntimeContractScene = (
  access: RunRequest["access"],
  identity: RunIdentity
) => RunRequest;

/** 공통 검사가 정하는 에이전트 신원(조직·에이전트). 같은 에이전트의 다음 실행 시도는 이 신원에 실행 시도 ID만 새로 붙인다. */
export type RuntimeContractAgent = Omit<RunIdentity, "runId">;

/** 실행 시도 하나에서 밖으로 보인 것: 종료 결과, 공개 활동, Lead 대화로 보낸 답장 글. 선언한 일의 효과를 이것으로 판정한다. */
export type RuntimeContractEvidence = {
  result: RunResult;
  activities: unknown[];
  messages: string[];
};

export type RuntimeContractOptions = {
  adapter: RuntimeAdapter;
  /** 스스로 끝나는 요청. */
  finishes: RuntimeContractScene;
  /** 취소할 때까지 일하는 요청. */
  worksUntilCancelled: RuntimeContractScene;
  /** 취소를 받은 뒤 `cancelled`로 끝나야 하는 시간. */
  cancelWithinMs?: number;
  /** 스스로 끝나는 요청을 기다리는 시간. */
  finishWithinMs?: number;
  /** 일을 시작했다는 신호(도구 호출·활동)가 없을 때 취소 전에 기다리는 시간. */
  startupMs?: number;
  /** 이 adapter가 이어 가지 못하는 세션(만료 등). 세션 이어가기를 선언한 adapter는 꼭 준다. */
  unusableSession?: SessionState;
  /**
   * 받은 세션을 이어 갔다는 관찰 지점. 세션 이어가기를 선언한 adapter는 꼭 준다. `plant(note)`가 세션에 말을 맡기고, 같은 에이전트의
   * 다음 실행 시도인 `recall`이 그 세션을 이어 가면 `recalled(evidence, note)`가 참이다. 같은 에이전트의 다른 세션에 맡긴 말과
   * 세션 없이 시작했을 때는 거짓이어야 한다(에이전트의 최신 세션이 아니라 받은 세션을 이어 감).
   */
  resumes?: {
    plant: (note: string) => RuntimeContractScene;
    recall: RuntimeContractScene;
    recalled: (evidence: RuntimeContractEvidence, note: string) => boolean;
  };
  /**
   * 끼워 넣은 말이 실행 시도에 들어갔다는 관찰 지점. 끼워 넣기를 선언한 adapter는 꼭 준다. `scene`은 끼워 넣은 말을 받을 때까지
   * 일하다 받으면 스스로 끝나는 요청이고, 받은 말(`body`)이 그 실행 시도의 결과(종료 결과·답장)에 반영되면 `took`이 참이다.
   * 받았다는 공개 활동은 반영의 근거가 아니므로 넘기지 않는다(받았다는 결정도 그 활동을 기다리지 않는다).
   */
  steers?: {
    scene: RuntimeContractScene;
    took: (
      evidence: Omit<RuntimeContractEvidence, "activities">,
      body: string
    ) => boolean;
  };
  /** 준비 확인을 기다리는 시간. */
  readinessWithinMs?: number;
};

/** 가짜 도구 서버. 지금 실행 시도의 요청 하나로 답하고, 도구 호출을 받을 때마다 알린다. */
async function startFakeToolServer() {
  let current: RunRequest | undefined;
  let messages: string[] = [];
  const onRequest = new Set<() => void>();
  const route = (tool: "get_run_context" | "send_message") =>
    `${orgTools[tool].method} ${orgToolsBasePath}${orgTools[tool].path}`;
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests++;
      for (const notify of onRequest) notify();
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const refuse = (status: number, code: string) =>
        reply(status, { error: { code } });
      const request = current;
      if (
        !request ||
        req.headers.authorization !== `Bearer ${request.access.token}`
      )
        return refuse(401, "invalid_token");
      const at = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
      if (at === route("get_run_context"))
        return reply(200, {
          identity: request.identity,
          wakeReasons: request.wakeReasons,
          context: request.context,
        });
      if (at === route("send_message")) {
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          return refuse(422, "invalid_input");
        }
        const input = orgTools.send_message.input.safeParse(raw);
        if (!input.success) return refuse(422, "invalid_input");
        const conversationId =
          input.data.conversationId ??
          request.context.conversations.find((c) => c.isDefault)?.id;
        if (!conversationId) return refuse(404, "not_found");
        messages.push(input.data.body);
        return reply(201, {
          id: crypto.randomUUID(),
          organizationId: request.identity.organizationId,
          agentId: request.identity.agentId,
          conversationId,
          author: "agent",
          body: input.data.body,
          delivery: null,
          sentByRunId: request.identity.runId,
          deliveredToRunId: null,
          deliveredAt: null,
          createdAt: new Date().toISOString(),
        } satisfies ConversationMessage);
      }
      return refuse(501, "not_implemented");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    /** 지금까지 받은 도구 호출 수. */
    get requests() {
      return requests;
    },
    /** 이 요청으로 답하고, 받은 답장 글을 새로 모은다. 모은 글 목록을 돌려준다. */
    serve(request: RunRequest) {
      current = request;
      messages = [];
      return messages;
    },
    onRequest,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch가 열어 둔 keep-alive 연결도 닫는다.
        server.closeAllConnections();
      }),
  };
}

/** 돌아온 뒤 늦은 활동을 기다리는 시간. */
const quietMs = 50;
/** 기한 밖에서 검사 자체에 주는 여유(vitest 시간 제한). */
const settleMs = 5_000;

const deadline = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms)
    ),
  ]);

/**
 * 프로바이더 adapter의 공통 검사를 등록한다. 두 장면에서 다음 약속을 확인한다.
 * 1. 취소를 받으면 정해진 시간 안에 `cancelled`로 끝난다.
 * 2. 돌아온 뒤 활동을 내지 않는다.
 * 3. 내는 활동은 모두 공개 활동 형식(`runtimeActivitySchema`)에 맞는다. 맞지 않으면 dispatcher가 버려 대시보드에서 사라진다.
 * 4. 종료 결과가 계약 형식(`runResultSchema`)에 맞는다.
 * 5. 실행 시도 토큰이 오류 문구·요약·활동에 나오지 않는다.
 * 선언한 일은 이렇게 확인한다(지원한다고 하면 그 동작, 아니라고 하면 그 동작이 없음).
 * 6. 지원하는 일을 모두 기본값 없이 선언하고, 끼워 넣기 선언과 `steer`가 맞고, 지침 다시 넣기·미리 압축은 세션 이어가기와 함께다.
 *    지침 다시 넣기는 프로바이더 안에서 일어나 공개 결과로 보이지 않으므로 adapter 자체 검사가 확인하고, 미리 압축의 실행은 후속(#99)이다.
 * 7. 끼워 넣기: 일하는 실행 시도는 받고(`accepted`) 받은 말이 끝까지 간 그 실행 시도의 결과에 반영되며(`steers.took`),
 *    모르는 실행 시도와 돌아온 실행 시도는 거절한다(`rejected`). 받았다는 결정은 공개 활동 기록을 기다리지 않는다(받았다는 활동은 실행 흐름이 남김).
 * 8. 세션 이어가기: 같은 에이전트의 다음 실행 시도가 받은 세션을 이어 가 그 세션에 맡긴 말을 알고(`resumes`, 다른 세션의 말이나
 *    세션 없이는 모름), 이어 가지 못하는 세션이면 같은 실행 시도 안에서 새 세션으로 시작해 진행 활동을 남긴다.
 *    지원하지 않으면 다음 세션을 돌려주지 않는다.
 * 9. 사용량: 토큰·비용을 선언한 대로 보고한다(지원하지 않는 항목은 `null`).
 * 10. 준비 확인: 도구를 부르지 않고 정해진 시간 안에 형식에 맞는 결과를 낸다.
 * 응답 모양(받음·완료)만으로는 선언한 일을 했다고 보지 않는다. 효과는 adapter가 주는 관찰 지점으로 결과·답장에서 확인한다.
 */
export function describeRuntimeContract(
  name: string,
  {
    adapter,
    finishes,
    worksUntilCancelled,
    cancelWithinMs = 5_000,
    finishWithinMs = 10_000,
    startupMs = 200,
    unusableSession,
    resumes,
    steers,
    readinessWithinMs = 10_000,
  }: RuntimeContractOptions
): void {
  const { capabilities } = adapter;
  if (capabilities?.resume && (!unusableSession || !resumes))
    throw new Error(
      `${name} declares resume; give an unusableSession and resumes`
    );
  if (capabilities?.steer && !steers)
    throw new Error(`${name} declares steer; give steers`);
  const newAgent = (): RuntimeContractAgent => ({
    organizationId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
  });
  describe(`${name} keeps the runtime contract`, () => {
    let tools: Awaited<ReturnType<typeof startFakeToolServer>>;
    beforeAll(async () => {
      tools = await startFakeToolServer();
    });
    afterAll(() => tools.close());

    /**
     * 새 신원(또는 `agent`의 조직·에이전트에 새 실행 시도 ID)으로 장면 하나를 실행한다. 돌아온 뒤 낸 활동은 `late`에 따로 모은다.
     */
    function run(
      scene: RuntimeContractScene,
      agent: RuntimeContractAgent = newAgent()
    ) {
      const token = `contract-token-${crypto.randomUUID()}`;
      const request = scene(
        { toolsBaseUrl: tools.baseUrl, token },
        { ...agent, runId: crypto.randomUUID() }
      );
      const messages = tools.serve(request);
      const controller = new AbortController();
      const activities: unknown[] = [];
      const late: unknown[] = [];
      let returned = false;
      // 활동 기록을 붙잡아 두면 풀어 줄 때까지 `emit`이 돌아오지 않는다. 기록은 그대로 한다.
      let gate: Promise<void> | undefined;
      let open: (() => void) | undefined;
      const holdActivities = () => {
        gate ??= new Promise<void>((resolve) => {
          open = resolve;
        });
        return () => {
          open?.();
          gate = undefined;
          open = undefined;
        };
      };
      // 도구 호출이나 활동이 일을 시작했다는 신호다. 신호가 없으면 `startupMs` 뒤에 취소한다.
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
        setTimeout(resolve, startupMs);
      });
      tools.onRequest.add(markStarted);
      void started.then(() => tools.onRequest.delete(markStarted));
      const result = adapter
        .execute(request, {
          signal: controller.signal,
          emit: async (activity) => {
            (returned ? late : activities).push(activity);
            markStarted();
            await gate;
          },
        })
        .finally(() => {
          returned = true;
        });
      return {
        token,
        messages,
        runId: request.identity.runId,
        controller,
        activities,
        late,
        result,
        started,
        holdActivities,
        get returned() {
          return returned;
        },
      };
    }

    /** 약속 2–5: 돌아온 뒤의 활동, 활동 형식, 종료 형식, 토큰 노출. */
    async function expectSettled(
      attempt: ReturnType<typeof run>,
      result: RunResult
    ) {
      expect(runResultSchema.safeParse(result).error).toBeUndefined();
      for (const activity of attempt.activities)
        expect(
          runtimeActivitySchema.safeParse(activity).error,
          JSON.stringify(activity)
        ).toBeUndefined();
      await new Promise((r) => setTimeout(r, quietMs));
      expect(attempt.late).toEqual([]);
      const published = JSON.stringify({
        error: result.error,
        summary: result.summary,
        activities: [...attempt.activities, ...attempt.late],
      });
      expect(published).not.toContain(attempt.token);
    }

    it(
      "finishes a request on its own with a public result and public activities only",
      async () => {
        const attempt = run(finishes);
        const result = await deadline(
          attempt.result,
          finishWithinMs,
          "did not finish on its own"
        );
        expect(result.stopReason).not.toBe("cancelled");
        await expectSettled(attempt, result);
      },
      finishWithinMs + settleMs
    );

    it(
      "settles as cancelled soon after a cancel and stays quiet afterwards",
      async () => {
        const attempt = run(worksUntilCancelled);
        await attempt.started;
        expect(attempt.returned, "returned before it was cancelled").toBe(
          false
        );
        attempt.controller.abort({
          type: "cancel",
          reason: "owner_interrupt",
        } satisfies RunCancel);
        const result = await deadline(
          attempt.result,
          cancelWithinMs,
          "did not settle as cancelled"
        );
        expect(result.stopReason).toBe("cancelled");
        await expectSettled(attempt, result);
      },
      startupMs + cancelWithinMs + settleMs
    );

    const evidenceOf = (
      attempt: ReturnType<typeof run>,
      result: RunResult
    ): RuntimeContractEvidence => ({
      result,
      activities: attempt.activities,
      messages: attempt.messages,
    });

    /** 장면을 이전 세션만 바꿔 실행하고 스스로 끝날 때까지 기다린다. `agent`를 주면 그 에이전트의 다음 실행 시도다. */
    async function finish(
      previousSession: SessionState | null = null,
      {
        scene = finishes,
        agent,
      }: {
        scene?: RuntimeContractScene;
        agent?: RuntimeContractAgent;
      } = {}
    ) {
      const attempt = run(
        (access, identity) => ({
          ...scene(access, identity),
          previousSession,
        }),
        agent
      );
      const result = await deadline(
        attempt.result,
        finishWithinMs,
        "did not finish on its own"
      );
      await expectSettled(attempt, result);
      return { attempt, result, evidence: evidenceOf(attempt, result) };
    }

    it("declares every capability without defaults, consistently with its channels", () => {
      expect(
        providerCapabilitiesSchema.safeParse(capabilities).error
      ).toBeUndefined();
      expect(typeof adapter.steer === "function").toBe(capabilities.steer);
      if (capabilities.reinjectInstructionsOnResume || capabilities.precompact)
        expect(capabilities.resume).toBe(true);
      expect(typeof adapter.checkReadiness).toBe("function");
      expect(
        adapter.loginCommand === null ||
          typeof adapter.loginCommand === "string"
      ).toBe(true);
    });

    it(
      "reports token and cost usage as declared and leaves the rest unreported",
      async () => {
        const { result } = await finish();
        const { usage } = result;
        const tokens = usage && [
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
        ];
        if (capabilities.usageTokens)
          expect(tokens?.some((n) => n !== null)).toBe(true);
        else expect(tokens?.every((n) => n === null) ?? true).toBe(true);
        if (capabilities.usageCost)
          expect(usage?.costUsd ?? null).not.toBeNull();
        else expect(usage?.costUsd ?? null).toBeNull();
      },
      finishWithinMs + settleMs
    );

    if (capabilities.resume) {
      it(
        "carries the session it was given into the same agent's next run, not another session of that agent and not a fresh start",
        async () => {
          const agent = newAgent();
          const plant = async (note: string) => {
            const planted = await finish(null, {
              scene: resumes!.plant(note),
              agent,
            });
            expect(planted.result.stopReason).toBe("completed");
            expect(planted.result.nextSession).not.toBeNull();
            return planted.result.nextSession;
          };
          const tag = crypto.randomUUID().slice(0, 8);
          const [given, other] = [`첫 세션 ${tag}`, `둘째 세션 ${tag}`];
          const session = await plant(given);
          // 같은 에이전트의 다른 세션이 나중에 생겨도 받은 세션을 이어 가야 한다(최신 세션을 이어 가는 adapter를 거른다).
          await plant(other);
          const resumed = await finish(session, {
            scene: resumes!.recall,
            agent,
          });
          expect(resumed.result.stopReason).toBe("completed");
          expect(resumes!.recalled(resumed.evidence, given)).toBe(true);
          expect(resumes!.recalled(resumed.evidence, other)).toBe(false);
          // 대조군: 같은 에이전트라도 세션 없이 시작하면 어느 세션의 말도 모른다.
          const fresh = await finish(null, { scene: resumes!.recall, agent });
          expect(resumes!.recalled(fresh.evidence, given)).toBe(false);
          expect(resumes!.recalled(fresh.evidence, other)).toBe(false);
        },
        4 * finishWithinMs + settleMs
      );

      it(
        "starts a new session within the same run when it cannot resume, and says so in a progress activity",
        async () => {
          const progress = (activities: unknown[]) =>
            activities.filter(
              (a) =>
                runtimeActivitySchema.safeParse(a).data?.type === "progress"
            ).length;
          // 같은 장면을 처음부터 했을 때보다 진행 활동이 하나 이상 많아야 한다(새 세션으로 시작했다는 알림).
          const fresh = await finish();
          const { attempt, result } = await finish(unusableSession!);
          expect(result.stopReason).toBe("completed");
          expect(result.nextSession).not.toEqual(unusableSession);
          expect(progress(attempt.activities)).toBeGreaterThan(
            progress(fresh.attempt.activities)
          );
        },
        2 * finishWithinMs + settleMs
      );
    } else
      it(
        "returns no session to resume",
        async () => {
          expect((await finish()).result.nextSession).toBeNull();
        },
        finishWithinMs + settleMs
      );

    if (capabilities.steer)
      it(
        "takes a steered message into the run it is working on so that the run's result reflects it, and refuses one for an unknown or returned run",
        async () => {
          const attempt = run(steers!.scene);
          await attempt.started;
          const steer = (runId: string, body: string) =>
            adapter.steer!({
              runId,
              messageId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              body,
            });
          const body = `끼워 넣는 말 ${crypto.randomUUID().slice(0, 8)}`;
          expect(await steer(crypto.randomUUID(), body)).toBe("rejected");
          const release = attempt.holdActivities();
          try {
            expect(
              await deadline(
                steer(attempt.runId, body),
                finishWithinMs,
                "did not decide the steer without waiting for an activity to be recorded"
              )
            ).toBe("accepted");
          } finally {
            release();
          }
          const result = await deadline(
            attempt.result,
            finishWithinMs,
            "did not finish after taking the steered message"
          );
          expect(result.stopReason).toBe("completed");
          expect(
            steers!.took({ result, messages: attempt.messages }, body)
          ).toBe(true);
          expect(await steer(attempt.runId, "늦은 말")).toBe("rejected");
          await expectSettled(attempt, result);
        },
        startupMs + 2 * finishWithinMs + settleMs
      );

    it(
      "checks readiness without calling tools, within its time",
      async () => {
        const before = tools.requests;
        const result = await deadline(
          adapter.checkReadiness(new AbortController().signal),
          readinessWithinMs,
          "did not check readiness"
        );
        expect(
          providerReadinessCheckSchema.safeParse(result).error
        ).toBeUndefined();
        expect(tools.requests).toBe(before);
      },
      readinessWithinMs + settleMs
    );
  });
}
