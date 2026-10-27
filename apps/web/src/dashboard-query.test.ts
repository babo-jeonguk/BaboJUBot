import {
  dashboardDays,
  runEndReasonSchema,
  runStatuses,
  taskStatuses,
  type OrganizationDashboard,
} from "@babojubot/contracts";
import {
  environmentManager,
  isServer,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dashboardQuery } from "./api.ts";

const orgId = "00000000-0000-4000-8000-000000000001";
const zeros = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** 서버처럼 `now`를 UTC 날짜로 자른 요약. 다음 날은 다음 UTC 자정에 시작한다. */
function utcDashboard(now: Date): OrganizationDashboard {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const day = 86_400_000;
  return {
    organizationId: orgId,
    asOf: now.toISOString(),
    timeZone: "UTC",
    nextDayAt: new Date(today + day).toISOString(),
    tasks: zeros(taskStatuses),
    runs: zeros(runStatuses),
    cancelling: 0,
    artifacts: 0,
    days: Array.from({ length: dashboardDays }, (_, i) => ({
      date: new Date(today - (dashboardDays - 1 - i) * day)
        .toISOString()
        .slice(0, 10),
      runsStarted: zeros(runStatuses),
      runsFinished: zeros(runEndReasonSchema.options),
      tasksCreated: zeros(taskStatuses),
      artifactsRecorded: 0,
    })),
    runningRuns: [],
    recentEvents: [],
  };
}

let client: QueryClient;
let stop: () => void;

beforeEach(() => {
  // 화면 없는 Node에서는 Query가 재조회 타이머를 걸지 않으므로 브라우저로 둔다.
  environmentManager.setIsServer(() => false);
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  stop?.();
  client.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  environmentManager.setIsServer(() => isServer);
});

test("after falling back to UTC, refetches at the next UTC midnight rather than the browser's", async () => {
  // 서울 10/27 23:00 = UTC 10/27 14:00. 서울 자정은 1시간 뒤, UTC 자정은 10시간 뒤다.
  // 브라우저 시계를 서울로 둔다(CI는 UTC라 브라우저 자정과 UTC 자정이 같아 구별되지 않는다).
  vi.stubEnv("TZ", "Asia/Seoul");
  vi.setSystemTime(new Date("2026-10-27T14:00:00Z"));
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    const timeZone = new URL(path, "http://web").searchParams.get("timeZone")!;
    asked.push(timeZone);
    return timeZone === "UTC"
      ? Response.json(utcDashboard(new Date()))
      : Response.json(
          { error: { code: "invalid_time_zone" } },
          { status: 422 }
        );
  });
  const observer = new QueryObserver(
    client,
    dashboardQuery(orgId, "Asia/Seoul")
  );
  stop = observer.subscribe(() => {});
  const today = () => observer.getCurrentResult().data?.days.at(-1)?.date;

  await vi.waitFor(() => expect(today()).toBe("2026-10-27"));
  expect(asked).toEqual(["Asia/Seoul", "UTC"]);

  // 서울 자정이 지나도 UTC 날짜는 그대로이므로 다시 묻지 않는다.
  await vi.advanceTimersByTimeAsync(2 * 3_600_000);
  expect(asked).toHaveLength(2);

  // UTC 자정이 지나면 Event 없이 다시 불러와 오늘이 하루 밀린다.
  await vi.advanceTimersByTimeAsync(8 * 3_600_000 + 2_000);
  await vi.waitFor(() => expect(today()).toBe("2026-10-28"));
  expect(asked).toEqual(["Asia/Seoul", "UTC", "Asia/Seoul", "UTC"]);
});

test("waits by the server's clock, so a browser clock running ahead does not refetch before the day turns", async () => {
  // 브라우저 시계가 서버보다 5분 빠르다. 브라우저 자정에 다시 물으면 서버는 아직 어제라 하루 동안 밀리지 않는다.
  vi.setSystemTime(new Date("2026-10-27T23:50:00Z"));
  const serverNow = () => new Date(Date.now() - 5 * 60_000);
  vi.stubGlobal("fetch", async () => Response.json(utcDashboard(serverNow())));
  const observer = new QueryObserver(client, dashboardQuery(orgId, "UTC"));
  stop = observer.subscribe(() => {});
  const today = () => observer.getCurrentResult().data?.days.at(-1)?.date;
  await vi.waitFor(() => expect(today()).toBe("2026-10-27"));

  await vi.advanceTimersByTimeAsync(15 * 60_000 + 2_000);
  await vi.waitFor(() => expect(today()).toBe("2026-10-28"));
});
