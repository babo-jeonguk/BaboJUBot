import type { ProviderSettings } from "@babojubot/contracts";
import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
  type Route,
} from "@playwright/test";

// 공용 E2E 서버의 전역 프로바이더 설정(Lead·작업자 기본값·압축·격리 실행·연결별 동시 실행 상한)은 모든 spec이 같이 쓴다.
// 이 fixture는 테스트 시작 전 값을 보존하고, 테스트가 성공하든 중간에 실패하든 그 값으로 되돌린 뒤 저장된 값을 확인한다.
// 고정 기본값이 아니라 시작 전 값으로 되돌리므로 앞서 있던 설정을 덮지 않는다.
//
// 저장 버튼이 잠기거나 클릭이 끝난 것은 저장 확정이 아니다. 저장을 확정한 뒤에 다음 동작을 하려면 `holdWrite`로 그 요청을
// 붙잡아 진행 중 상태를 보고, `release`가 돌려준 서버 응답과 그 안의 저장값을 확인한다.
// 정리는 (1) 아직 붙잡힌 요청을 서버에 보내지 않고 끊고 (2) 이 테스트의 화면(browser context)이 서버로 보낸 전역 설정 변경
// 요청(`release`로 보낸 요청 포함)이 모두 끝나기를 기다린 뒤 (3) 되돌린다. 기다리다 시한을 넘기면 되돌리기는 시도하되
// 정리를 실패로 알린다. API 요청(`request`·`page.request`)은 테스트가 응답을 기다리므로 추적하지 않는다.
// 그래서 늦게 도착한 화면의 저장이 되돌린 값을 덮지 않고, 정리 뒤 route callback이 닫힌 page를 쓰지 않는다.

// 붙잡은 요청의 도착·응답과 정리 단계마다 기다리는 시한.
const settleMs = 10_000;

/** 되돌릴 전역 설정. */
export type Snapshot = {
  leadDefault: ProviderSettings["leadDefault"];
  workerDefault: ProviderSettings["workerDefault"];
  compaction: ProviderSettings["compaction"];
  isolated: boolean;
  limits: Record<string, number>;
};

/** `holdWrite`가 붙잡은 요청 하나. */
export type HeldWrite = {
  /** 요청이 route에 닿아 서버로 가지 않고 멈춰 있을 때까지 기다린다. */
  arrived: () => Promise<Request>;
  /** 붙잡은 요청을 서버로 보내고 서버 응답을 돌려준다. 응답 없이 실패하면 오류다. */
  release: () => Promise<Response>;
};

export type SharedSettings = {
  /** 테스트 시작 전 전역 설정. 정리 때 이 값으로 되돌린다. */
  initial: Snapshot;
  /** 이 page에서 `url`로 가는 다음 PUT 하나를 붙잡는다. 그 뒤의 PUT은 그대로 지나간다. */
  holdWrite: (page: Page, url: string) => Promise<HeldWrite>;
};

function failAfter<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${settleMs}ms 안에 ${what}`)),
      settleMs
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function snapshotOf(settings: ProviderSettings): Snapshot {
  return {
    leadDefault: settings.leadDefault,
    workerDefault: settings.workerDefault,
    compaction: settings.compaction,
    isolated: settings.isolated,
    limits: Object.fromEntries(
      settings.providers.map((p) => [p.id, p.maxConcurrentRuns])
    ),
  };
}

/** 서버에 저장된 전역 설정. */
export async function readSettings(request: APIRequestContext) {
  const response = await request.get("/api/providers", { timeout: settleMs });
  expect(response.status()).toBe(200);
  return snapshotOf((await response.json()) as ProviderSettings);
}

async function put(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.put(path, { data, timeout: settleMs });
  expect(response.status(), `${path} 되돌리기`).toBe(200);
}

async function restore(request: APIRequestContext, initial: Snapshot) {
  await put(request, "/api/providers/defaults", {
    leadDefault: initial.leadDefault,
    workerDefault: initial.workerDefault,
    compaction: initial.compaction,
  });
  await put(request, "/api/providers/isolation", {
    isolated: initial.isolated,
  });
  for (const [provider, maxConcurrentRuns] of Object.entries(initial.limits))
    await put(request, `/api/providers/${provider}/limit`, {
      maxConcurrentRuns,
    });
  expect(await readSettings(request), "되돌린 전역 설정").toEqual(initial);
}

/** 전역 프로바이더 설정을 바꾸는 요청. 정리는 이 요청들이 끝난 뒤에 되돌린다. */
const isSettingsWrite = (request: Request) =>
  request.method() === "PUT" &&
  new URL(request.url()).pathname.startsWith("/api/providers/");

export const test = base.extend<{ sharedSettings: SharedSettings }>({
  // 이 test를 쓰는 spec은 모든 테스트에서 되돌린다(auto). page에 기대어 page보다 먼저 정리하므로 붙잡은 route를 끊는 동안 page가 열려 있다.
  sharedSettings: [
    async ({ page, request }, use) => {
      const initial = await readSettings(request);
      const writes: Request[] = [];
      const onRequest = (r: Request) => {
        if (isSettingsWrite(r)) writes.push(r);
      };
      page.context().on("request", onRequest);
      const gates: { drop: () => void; settle: () => Promise<void> }[] = [];
      // 붙잡았다가 보내지 않고 끊은 요청. 서버에 닿지 않았고, 붙잡힌 채 화면이 이동해 취소됐으면 응답도 실패도 알리지 않으므로
      // 정리는 이 요청을 기다리지 않는다. 서버로 보낸 요청은 다른 화면 요청처럼 정리가 끝날 때까지 기다린다.
      const unsent = new Set<Request>();

      const holdWrite = async (target: Page, url: string) => {
        let decide!: (send: boolean) => void;
        const decision = new Promise<boolean>((resolve) => (decide = resolve));
        let arrive!: (request: Request) => void;
        const arrival = new Promise<Request>((resolve) => (arrive = resolve));
        let taken = false;
        let running: Promise<void> = Promise.resolve();
        const handler = (route: Route) => {
          if (taken || route.request().method() !== "PUT")
            return route.fallback();
          taken = true;
          arrive(route.request());
          running = decision.then((send) => {
            if (send) return route.fallback();
            unsent.add(route.request());
            return route.abort();
          });
          return running;
        };
        await target.route(url, handler);
        gates.push({
          drop: () => decide(false),
          settle: async () => {
            await failAfter(running, `${url} route callback이 끝나지 않았다`);
            if (!target.isClosed()) await target.unroute(url, handler);
          },
        });
        const arrived = () =>
          failAfter(arrival, `${url} PUT이 route에 닿지 않았다`);
        return {
          arrived,
          release: async () => {
            const request = await arrived();
            decide(true);
            const response = await failAfter(
              request.response(),
              `${url} 응답이 오지 않았다`
            );
            if (!response) throw new Error(`${url} PUT이 응답 없이 실패했다`);
            return response;
          },
        };
      };

      // 테스트가 실패해도 use는 돌아오고 아래 정리가 이어진다.
      await use({ initial, holdWrite });
      // 앞 단계가 실패해도 되돌리기는 시도하고, 모은 실패를 함께 알린다.
      const problems: unknown[] = [];
      const attempt = async (step: () => Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          problems.push(error);
        }
      };
      for (const gate of gates) gate.drop();
      for (const gate of gates) await attempt(gate.settle);
      page.context().off("request", onRequest);
      // 실패한 요청은 null, 서버에 닿은 요청은 그 응답으로 끝난다. 그 뒤에는 화면이 보낸 변경이 되돌린 값을 덮지 않는다.
      await attempt(() =>
        failAfter(
          Promise.all(
            writes.filter((r) => !unsent.has(r)).map((r) => r.response())
          ),
          "이 테스트가 보낸 전역 설정 변경이 끝나지 않았다"
        )
      );
      await attempt(() => restore(request, initial));
      if (problems.length === 1) throw problems[0];
      if (problems.length > 1)
        throw new AggregateError(
          problems,
          problems.map((p) => String(p)).join("\n")
        );
    },
    { auto: true },
  ],
});
