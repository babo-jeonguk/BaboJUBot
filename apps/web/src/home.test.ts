import type {
  InboxItem,
  LifecycleStage,
  Organization,
  Overview,
} from "@babojubot/contracts";
import { expect, test } from "vitest";
import { arrangeHome, relativeTime } from "./home.tsx";

const org = (n: number, stage: LifecycleStage): Organization => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name: `조직 ${n}`,
  stage,
  goal: null,
  completionCriteria: null,
  approvalPolicy: { addWorker: false },
  pausedFrom: null,
  createdAt: "2026-10-01T00:00:00.000Z",
});
/** 개요 한 줄: 진행 중 수와 마지막 활동(분 단위로 단순화). */
const line = (
  o: Organization,
  minute: number,
  running = 0,
  cancelling = 0
) => ({
  organizationId: o.id,
  running,
  cancelling,
  lastActivityAt: new Date(Date.UTC(2026, 9, 27, 0, minute)).toISOString(),
});
const approval = (o: Organization) =>
  ({
    kind: "approval",
    read: true,
    archived: false,
    approval: { organizationId: o.id },
  }) as unknown as InboxItem;
const failure = (
  o: Organization,
  state: { read: boolean; archived: boolean }
) =>
  ({
    kind: "run_failure",
    ...state,
    run: { organizationId: o.id },
  }) as unknown as InboxItem;
const ids = (rows: { org: Organization }[]) => rows.map((r) => r.org.name);

test("organizations that need the owner come first by attention count, then in progress running first and paused last, and closed ones apart", () => {
  const goal = org(1, "goal_setting");
  const busy = org(2, "researching");
  const paused = org(3, "paused");
  const fresh = org(4, "planning");
  const oneApproval = org(5, "awaiting_approval");
  const twoItems = org(6, "result_review");
  const done = org(7, "completed");
  const stoppedWithFailure = org(8, "stopped");
  const stopped = org(9, "stopped");
  const cancellingOnly = org(10, "researching");
  const all = [
    goal,
    busy,
    paused,
    fresh,
    oneApproval,
    twoItems,
    done,
    stoppedWithFailure,
    stopped,
    cancellingOnly,
  ];
  const overview: Overview = {
    asOf: "2026-10-27T01:00:00.000Z",
    runs: { running: 3, cancelling: 1 },
    organizations: [
      line(goal, 10),
      line(busy, 1, 2),
      line(paused, 50),
      line(fresh, 30),
      line(oneApproval, 40),
      line(twoItems, 5),
      line(done, 20),
      line(stoppedWithFailure, 1),
      line(stopped, 45),
      // 취소 정리 중뿐이면 실행 중이 아니다.
      line(cancellingOnly, 15, 1, 1),
    ],
  };
  const inbox = [
    approval(oneApproval),
    approval(twoItems),
    failure(twoItems, { read: false, archived: false }),
    failure(stoppedWithFailure, { read: false, archived: false }),
    // 읽은 실패·보관한 실패는 주의가 아니다.
    failure(goal, { read: true, archived: false }),
    failure(fresh, { read: false, archived: true }),
  ];
  const home = arrangeHome(all, overview, inbox);
  expect(ids(home.attention)).toEqual(["조직 6", "조직 5", "조직 8"]);
  expect(home.attention.map((r) => r.attention)).toEqual([2, 1, 1]);
  expect(ids(home.progress)).toEqual([
    "조직 2",
    "조직 4",
    "조직 10",
    "조직 1",
    "조직 3",
  ]);
  expect(ids(home.closed)).toEqual(["조직 9", "조직 7"]);
  expect(home.totalAttention).toBe(4);
});

test("before the overview arrives the cards order by creation time and show no activity time", () => {
  const older = { ...org(1, "planning"), createdAt: "2026-10-01T00:00:00Z" };
  const newer = { ...org(2, "planning"), createdAt: "2026-10-02T00:00:00Z" };
  const home = arrangeHome([older, newer], undefined, []);
  expect(ids(home.progress)).toEqual(["조직 2", "조직 1"]);
  expect(home.progress.map((r) => r.lastActivityAt)).toEqual([null, null]);
});

test("activity time reads as just now, minutes, hours, yesterday, days, then a date after a week", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const minute = 60_000;
  expect(relativeTime(ago(20_000), now)).toBe("방금");
  expect(relativeTime(ago(5 * minute), now)).toBe("5분 전");
  expect(relativeTime(ago(3 * 60 * minute), now)).toBe("3시간 전");
  expect(relativeTime(ago(30 * 60 * minute), now)).toBe("어제");
  expect(relativeTime(ago(3 * 24 * 60 * minute), now)).toBe("3일 전");
  expect(relativeTime(ago(10 * 24 * 60 * minute), now)).toMatch(/10월 1\d일/);
});
