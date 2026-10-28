import type {
  InboxItem,
  LifecycleStage,
  Overview,
  OverviewAgent,
  OverviewOrganization,
} from "@babojubot/contracts";
import { expect, test } from "vitest";
import {
  arrangeHome,
  columnsOf,
  decisionBubble,
  isWideRoom,
  placeOf,
  relativeTime,
} from "./home-model.ts";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const appearance = {
  color: "sky",
  eyes: "round",
  mouth: "smile",
  accessory: "none",
} as const;
const agent = (
  n: number,
  fields: Partial<OverviewAgent> = {}
): OverviewAgent => ({
  id: uuid(1000 + n),
  role: "worker",
  name: `작업자 ${n}`,
  appearance,
  status: "idle",
  paused: false,
  lastRunFailed: false,
  currentTask: null,
  wakeKind: null,
  ...fields,
});
const lead = (fields: Partial<OverviewAgent> = {}) =>
  agent(0, { role: "lead", name: "Research Lead", ...fields });
const org = (
  n: number,
  stage: LifecycleStage,
  fields: Partial<OverviewOrganization> = {}
): OverviewOrganization => ({
  organizationId: uuid(n),
  name: `조직 ${n}`,
  goal: null,
  stage,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
  running: 0,
  cancelling: 0,
  lastActivityAt: null,
  agents: [lead()],
  pendingDecisions: [],
  ...fields,
});
const overview = (organizations: OverviewOrganization[]): Overview => ({
  asOf: "2026-10-27T01:00:00.000Z",
  runs: { running: 0, cancelling: 0 },
  organizations,
});
const approval = (o: OverviewOrganization) =>
  ({
    kind: "approval",
    read: true,
    archived: false,
    approval: { organizationId: o.organizationId, status: "pending" },
  }) as unknown as InboxItem;
const failure = (
  o: OverviewOrganization,
  state: { read: boolean; archived: boolean }
) =>
  ({
    kind: "run_failure",
    ...state,
    run: { organizationId: o.organizationId },
  }) as unknown as InboxItem;
const names = (rooms: { org: OverviewOrganization }[]) =>
  rooms.map((r) => r.org.name);

test("rooms stay in creation order whatever needs attention or runs, and only closed organizations move to the folded section", () => {
  const first = org(1, "researching", { running: 2 });
  const second = org(2, "awaiting_approval");
  const third = org(3, "paused");
  const done = org(4, "completed");
  const stopped = org(5, "stopped");
  const latest = org(6, "result_review");
  // 응답 순서가 섞여 와도 만든 순서로 놓는다.
  const home = arrangeHome(
    overview([latest, stopped, third, first, done, second]),
    [
      approval(latest),
      failure(latest, { read: false, archived: false }),
      approval(second),
      failure(stopped, { read: false, archived: false }),
      // 읽은 실패·보관한 실패는 주의가 아니다.
      failure(first, { read: true, archived: false }),
      failure(third, { read: false, archived: true }),
    ]
  );
  expect(names(home.open)).toEqual(["조직 1", "조직 2", "조직 3", "조직 6"]);
  expect(home.open.map((r) => r.attention)).toEqual([0, 1, 0, 2]);
  expect(names(home.closed)).toEqual(["조직 4", "조직 5"]);
  expect(home.totalAttention).toBe(4);
});

test("a room takes half the width up to six agents, the full width from seven, and folded rooms are never wide", () => {
  const crew = (n: number) => [
    lead(),
    ...Array.from({ length: n - 1 }, (_, i) => agent(i + 1)),
  ];
  expect(isWideRoom(org(1, "researching", { agents: crew(6) }))).toBe(false);
  expect(isWideRoom(org(1, "researching", { agents: crew(7) }))).toBe(true);
  expect(isWideRoom(org(1, "stopped", { agents: crew(9) }))).toBe(false);
});

test("worker desks keep at most six to a row and split the rows evenly", () => {
  expect([1, 5, 6, 7, 9, 12, 13].map(columnsOf)).toEqual([1, 5, 6, 4, 5, 6, 5]);
});

test("where each agent is: the Lead waiting for the owner stands with the decision, paused agents doze, working ones sit with what they hold, a failed one worries, the rest rest in the lounge", () => {
  const room = org(1, "researching", {
    pendingDecisions: [
      { kind: "add_worker", createdAt: "2026-10-27T00:00:00Z" },
      { kind: "result_submission", createdAt: "2026-10-27T00:01:00Z" },
    ],
  });
  expect(placeOf(lead({ status: "running" }), room)).toMatchObject({
    pose: "standing",
    asking: "작업자 추가 승인 외 1",
    state: "작업자 추가 승인 외 1 기다림",
    lounge: false,
  });
  // 작업자는 결정을 기다리지 않는다.
  expect(placeOf(agent(1), room)).toMatchObject({
    lounge: true,
    pose: "away",
    state: "쉬는 중",
    asking: null,
  });
  expect(
    placeOf(
      agent(2, { status: "running", currentTask: "문헌 42편 요약" }),
      room
    )
  ).toMatchObject({
    pose: "seated",
    screen: "code",
    mood: "working",
    state: "작업 중",
    saying: "문헌 42편 요약",
  });
  // 작업이 없으면 깨어난 이유로 하는 일을 말한다.
  expect(
    placeOf(agent(3, { status: "running", wakeKind: "owner_message" }), room)
      .saying
  ).toBe("사용자 메시지 읽는 중");
  expect(placeOf(agent(4, { lastRunFailed: true }), room)).toMatchObject({
    pose: "seated",
    screen: "error",
    mood: "worried",
    state: "마지막 실행 실패",
  });
  expect(
    placeOf(agent(5, { paused: true, status: "running" }), room)
  ).toMatchObject({ pose: "doze", mood: "sleepy", state: "일시정지" });

  const paused = org(2, "paused");
  for (const a of [agent(1), agent(2, { status: "running" }), lead()])
    expect(placeOf(a, paused)).toMatchObject({ pose: "doze", lounge: false });

  const stopped = org(3, "stopped", {
    pendingDecisions: [
      { kind: "initial_research", createdAt: "2026-10-27T00:00:00Z" },
    ],
  });
  expect(placeOf(lead(), stopped)).toMatchObject({
    pose: "away",
    lounge: false,
    asking: null,
    state: "중단됨",
  });
});

test("the Lead's question names the oldest open decision", () => {
  const at = "2026-10-27T00:00:00Z";
  expect(decisionBubble(org(1, "awaiting_approval"))).toBeNull();
  expect(
    decisionBubble(
      org(1, "awaiting_approval", {
        pendingDecisions: [{ kind: "initial_research", createdAt: at }],
      })
    )
  ).toBe("계획 승인");
  expect(
    decisionBubble(
      org(1, "result_review", {
        pendingDecisions: [{ kind: "result_submission", createdAt: at }],
      })
    )
  ).toBe("결과 검토");
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
