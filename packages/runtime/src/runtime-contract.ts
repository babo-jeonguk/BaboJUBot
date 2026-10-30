import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  orgTools,
  orgToolsBasePath,
  runResultSchema,
  runtimeActivitySchema,
  type ConversationMessage,
  type RunCancel,
  type RunRequest,
  type RunResult,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 프로바이더 계약(contracts `RuntimeAdapter`)의 공통 검사. 프로바이더 adapter마다 장면 두 개를 주고 같은 약속을 확인한다.
// 실행 맥락 조회와 Lead 대화 답장만 받는 작은 가짜 도구 HTTP 서버를 직접 띄우며, 그 밖의 도구는 501 `not_implemented`다.

/** 장면: 가짜 도구 서버의 주소·토큰을 받아 실행 시도 요청 한 장을 만든다. */
export type RuntimeContractScene = (access: RunRequest["access"]) => RunRequest;

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
};

/** 가짜 도구 서버. 지금 실행 시도의 요청 하나로 답하고, 도구 호출을 받을 때마다 알린다. */
async function startFakeToolServer() {
  let current: RunRequest | undefined;
  const onRequest = new Set<() => void>();
  const route = (tool: "get_run_context" | "send_message") =>
    `${orgTools[tool].method} ${orgToolsBasePath}${orgTools[tool].path}`;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
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
    serve(request: RunRequest) {
      current = request;
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
  }: RuntimeContractOptions
): void {
  describe(`${name} keeps the runtime contract`, () => {
    let tools: Awaited<ReturnType<typeof startFakeToolServer>>;
    beforeAll(async () => {
      tools = await startFakeToolServer();
    });
    afterAll(() => tools.close());

    /** 장면 하나를 실행한다. 돌아온 뒤 낸 활동은 `late`에 따로 모은다. */
    function run(scene: RuntimeContractScene) {
      const token = `contract-token-${crypto.randomUUID()}`;
      const request = scene({ toolsBaseUrl: tools.baseUrl, token });
      tools.serve(request);
      const controller = new AbortController();
      const activities: unknown[] = [];
      const late: unknown[] = [];
      let returned = false;
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
          },
        })
        .finally(() => {
          returned = true;
        });
      return {
        token,
        controller,
        activities,
        late,
        result,
        started,
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
  });
}
