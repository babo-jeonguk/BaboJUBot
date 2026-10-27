import {
  dashboardDays,
  organizationDashboardSchema,
  organizationDetailSchema,
  overviewSchema,
  runStatuses,
  runSummaryListSchema,
  taskDetailSchema,
  taskStatuses,
} from "@babojubot/contracts";
import { leadReplyScript, type Script } from "@babojubot/runtime";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { calls, goal, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 조직 대시보드 요약과 홈 개요(#62). 수는 조직 원장에서 바로 센 값과 같아야 하고 다른 조직을 섞지 않는다.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, say, tasksOf, eventsOf, researching } = serverHelpers(() => t!);

let clock = new Date("2026-10-27T03:00:00Z");
const at = (iso: string) => {
  clock = new Date(iso);
};

const dashboard = async (orgId: string, timeZone = "UTC") =>
  organizationDashboardSchema.parse(
    await get(
      `/api/organizations/${orgId}/dashboard?timeZone=${encodeURIComponent(timeZone)}`
    )
  );
const overview = async () => overviewSchema.parse(await get("/api/overview"));
const runningRuns = async (orgId: string) =>
  runSummaryListSchema.parse(
    await get(`/api/organizations/${orgId}/runs?status=running`)
  );
const allRuns = async (orgId: string) =>
  runSummaryListSchema.parse(await get(`/api/organizations/${orgId}/runs`));

/** 사용자가 목표를 적어 만든 조직. 생성으로 깨어난 Lead의 실행 시도가 끝날 때까지 기다린다. */
async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name, ...goal });
  expect(res.status).toBe(201);
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}

/** 상태별 수. 빠진 상태는 0이다. */
const countBy = <K extends string>(keys: readonly K[], values: K[]) =>
  Object.fromEntries(
    keys.map((k) => [k, values.filter((v) => v === k).length])
  ) as Record<K, number>;
/** 날짜별 값만 뽑되 0인 날은 뺀다. */
const nonZero = (days: { date: string }[], pick: (d: any) => number) =>
  Object.fromEntries(days.flatMap((d) => (pick(d) ? [[d.date, pick(d)]] : [])));

describe("organization dashboard", () => {
  it("counts this organization's tasks, runs and artifacts from its own records, and nothing of another organization", async () => {
    at("2026-10-27T03:00:00Z");
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime, now: () => clock });
    const a = await researching(agents, "대시보드 A");
    const b = await researching(agents, "대시보드 B");
    agents.queue(
      a.lead.id,
      calls(
        {
          tool: "create_task",
          input: { title: "A 작업 1", assigneeAgentId: a.workers[0]!.id },
        },
        {
          tool: "create_task",
          input: { title: "A 작업 2", assigneeAgentId: a.workers[1]!.id },
        }
      )
    );
    agents.queue(
      b.lead.id,
      calls({
        tool: "create_task",
        input: { title: "B 작업", assigneeAgentId: b.workers[0]!.id },
      })
    );
    await say(a.id, "작업을 나눠 주세요");
    await say(b.id, "작업을 나눠 주세요");
    await t.drain();

    for (const org of [a, b]) {
      const summary = await dashboard(org.id);
      const tasks = await tasksOf(org.id);
      const runs = await allRuns(org.id);
      const artifacts = (
        await Promise.all(
          tasks.map(async (task) =>
            taskDetailSchema.parse(
              await get(`/api/organizations/${org.id}/tasks/${task.id}`)
            )
          )
        )
      ).flatMap((task) => task.artifacts);
      const events = await eventsOf(org.id);

      expect(summary).toMatchObject({
        organizationId: org.id,
        asOf: clock.toISOString(),
        timeZone: "UTC",
        tasks: countBy(
          taskStatuses,
          tasks.map((x) => x.status)
        ),
        runs: countBy(
          runStatuses,
          runs.map((r) => r.status)
        ),
        cancelling: 0,
        artifacts: artifacts.length,
        runningRuns: [],
      });
      expect(summary.artifacts).toBeGreaterThan(0);
      // 최근 활동은 이 조직의 마지막 Event들이다. 최근 것이 먼저다.
      expect(summary.recentEvents).toEqual(events.slice(-10).reverse());

      // 모든 기록이 오늘 생겼으므로 오늘 bucket이 전체 수와 같다.
      expect(summary.days.map((d) => d.date)).toEqual([
        ...Array.from({ length: 13 }, (_, i) => `2026-10-${14 + i}`),
        "2026-10-27",
      ]);
      const today = summary.days.at(-1)!;
      expect(today).toEqual({
        date: "2026-10-27",
        runsStarted: summary.runs,
        runsFinished: {
          completed: summary.runs.completed,
          failed: 0,
          cancelled: 0,
          server_restart: 0,
        },
        tasksCreated: summary.tasks,
        artifactsRecorded: summary.artifacts,
      });
    }
    expect((await dashboard(a.id)).tasks.completed).toBe(2);
    expect((await dashboard(b.id)).tasks.completed).toBe(1);
  });

  it("answers 404 for an unknown organization and 422 for a time zone it does not know", async () => {
    t = await startTestServer();
    const org = await createOrganization("시간대 조직");
    for (const id of [crypto.randomUUID(), "not-a-uuid"])
      expect(
        (await t.request("GET", `/api/organizations/${id}/dashboard`)).status
      ).toBe(404);
    for (const timeZone of ["Mars/Olympus", "+09:00", "UTC+9"]) {
      const res = await t.request(
        "GET",
        `/api/organizations/${org.id}/dashboard?timeZone=${encodeURIComponent(timeZone)}`
      );
      expect(res.status, timeZone).toBe(422);
      expect(res.body).toEqual({ error: { code: "invalid_time_zone" } });
    }
    // 시간대를 주지 않으면 UTC다. 작업·산출물이 없는 조직도 14일이 모두 있다. 실행 시도는 생성으로 깨어난 Lead의 것 하나다.
    const empty = organizationDashboardSchema.parse(
      await get(`/api/organizations/${org.id}/dashboard`)
    );
    expect(empty.timeZone).toBe("UTC");
    expect(empty.days).toHaveLength(dashboardDays);
    expect(empty.days.every((d) => d.artifactsRecorded === 0)).toBe(true);
    expect(empty).toMatchObject({
      tasks: { open: 0, in_progress: 0, completed: 0 },
      runs: { running: 0, completed: 1 },
      artifacts: 0,
      runningRuns: [],
    });
  });

  it("cuts the 14 days at the given time zone's midnights, counting starts and ends on their own days", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime, now: () => clock });
    // 생성으로 깨어난 Lead의 실행 시도는 14일 밖에 둔다.
    at("2026-10-01T00:00:00.000Z");
    const org = await createOrganization("날짜 조직");
    const reply = async (iso: string, body = "안녕하세요") => {
      at(iso);
      await say(org.id, body);
      await t!.drain();
    };
    await reply("2026-10-14T14:59:59.999Z"); // 서울 10/14 23:59, UTC 10/14
    await reply("2026-10-14T15:00:00.000Z"); // 서울 10/15 00:00, UTC 10/14
    await reply("2026-10-27T14:59:59.999Z"); // 서울 10/27, UTC 10/27
    await reply("2026-10-27T15:00:00.000Z"); // 서울 10/28 00:00, UTC 10/27
    await reply("2026-10-27T15:30:00.000Z", "실패 연습"); // 서울 10/28, UTC 10/27
    // 서울 10/28에 시작해 UTC 기준으로도 날이 바뀐 뒤 끝나는 실행 시도.
    const gate = createGate();
    agents.queue(org.lead.id, {
      ...leadReplyScript,
      steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
    } satisfies Script);
    at("2026-10-27T23:00:00.000Z"); // 서울 10/28 08:00, UTC 10/27
    await say(org.id, "오래 걸리는 일");
    await gate.reached;
    at("2026-10-28T01:00:00.000Z"); // 서울 10/28 10:00, UTC 10/28
    gate.open();
    await t.drain();

    const seoul = await dashboard(org.id, "Asia/Seoul");
    expect(seoul.asOf).toBe("2026-10-28T01:00:00.000Z");
    expect(seoul.days[0]!.date).toBe("2026-10-15");
    expect(seoul.days.at(-1)!.date).toBe("2026-10-28");
    // 오늘은 서울 10/29 00:00에 끝난다. 화면은 이 시각까지 기다렸다 다시 불러온다.
    expect(seoul.nextDayAt).toBe("2026-10-28T15:00:00.000Z");
    // 서울 10/14 23:59에 시작한 실행 시도는 14일 밖이다.
    expect(nonZero(seoul.days, (d) => d.runsStarted.completed)).toEqual({
      "2026-10-15": 1,
      "2026-10-27": 1,
      "2026-10-28": 2,
    });
    expect(nonZero(seoul.days, (d) => d.runsStarted.failed)).toEqual({
      "2026-10-28": 1,
    });
    expect(nonZero(seoul.days, (d) => d.runsFinished.completed)).toEqual({
      "2026-10-15": 1,
      "2026-10-27": 1,
      "2026-10-28": 2,
    });
    expect(nonZero(seoul.days, (d) => d.runsFinished.failed)).toEqual({
      "2026-10-28": 1,
    });

    const utc = await dashboard(org.id, "UTC");
    expect(utc.days[0]!.date).toBe("2026-10-15");
    expect(utc.days.at(-1)!.date).toBe("2026-10-28");
    expect(utc.nextDayAt).toBe("2026-10-29T00:00:00.000Z");
    // UTC 10/14의 두 실행 시도는 14일 밖이다. 마지막 실행 시도는 10/27에 시작해 10/28에 끝났다.
    expect(nonZero(utc.days, (d) => d.runsStarted.completed)).toEqual({
      "2026-10-27": 3,
    });
    expect(nonZero(utc.days, (d) => d.runsStarted.failed)).toEqual({
      "2026-10-27": 1,
    });
    expect(nonZero(utc.days, (d) => d.runsFinished.completed)).toEqual({
      "2026-10-27": 2,
      "2026-10-28": 1,
    });
    // 전체 수는 기간과 상관없는 원장 전체다(생성 깨우기를 받은 실행 시도 포함).
    expect(utc.runs).toMatchObject({ completed: 6, failed: 1 });
  });

  it("keeps the 14 calendar days whole across a daylight saving change", async () => {
    at("2026-11-02T00:30:00Z"); // 뉴욕 11/1 19:30, 그날 새벽 2시에 서머타임이 끝났다.
    t = await startTestServer({ now: () => clock });
    // 생성으로 깨어난 Lead의 실행 시도는 14일 밖에 둔다.
    at("2026-10-01T00:00:00Z");
    const org = await createOrganization("서머타임 조직");
    at("2026-11-01T03:59:59.999Z"); // 뉴욕 10/31 23:59 EDT
    await say(org.id, "하나");
    await t.drain();
    at("2026-11-01T04:00:00.000Z"); // 뉴욕 11/1 00:00 EDT
    await say(org.id, "둘");
    await t.drain();
    at("2026-11-02T00:30:00Z");

    const ny = await dashboard(org.id, "America/New_York");
    expect(ny.days.map((d) => d.date)).toEqual([
      ...Array.from({ length: 13 }, (_, i) => `2026-10-${19 + i}`),
      "2026-11-01",
    ]);
    // 11/1은 25시간이라 다음 날은 EST 자정(UTC 05:00)에 시작한다.
    expect(ny.nextDayAt).toBe("2026-11-02T05:00:00.000Z");
    expect(nonZero(ny.days, (d) => d.runsStarted.completed)).toEqual({
      "2026-10-31": 1,
      "2026-11-01": 1,
    });
  });
});

describe("running runs on the dashboard and home", () => {
  it("counts every unfinished run per organization and in total, with those cleaning up after a cancellation apart", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const a = await researching(agents, "실행 중 A");
    const b = await createOrganization("실행 중 B");
    const idleOrg = await createOrganization("쉬는 조직");
    // 작업자 1은 취소 요청을 받아도 바로 끝내지 않는다(정리 중). 작업자 2와 B의 Lead는 취소되면 끝난다.
    const stuck = createGate();
    const held = createGate();
    const heldB = createGate();
    const neverAborted = new AbortController().signal;
    try {
      agents.queue(a.workers[0]!.id, {
        steps: [{ do: "hold", until: () => stuck.wait(neverAborted) }],
      });
      agents.queue(a.workers[1]!.id, {
        steps: [{ do: "hold", until: held.wait }],
      });
      agents.queue(b.lead.id, { steps: [{ do: "hold", until: heldB.wait }] });
      agents.queue(
        a.lead.id,
        calls(
          {
            tool: "create_task",
            input: { title: "긴 작업 1", assigneeAgentId: a.workers[0]!.id },
          },
          {
            tool: "create_task",
            input: { title: "긴 작업 2", assigneeAgentId: a.workers[1]!.id },
          }
        )
      );
      await say(a.id, "긴 작업을 맡겨 주세요");
      await say(b.id, "오래 걸리는 일");
      await Promise.all([stuck.reached, held.reached, heldB.reached]);
      // Lead 실행 시도가 끝날 때까지 기다린다.
      await expect.poll(async () => (await runningRuns(a.id)).length).toBe(2);

      const before = await overview();
      expect(before.runs).toEqual({ running: 3, cancelling: 0 });
      const orgs = (await get("/api/organizations")) as { id: string }[];
      expect(before.organizations.map((o) => o.organizationId)).toEqual(
        orgs.map((o) => o.id)
      );
      expect(before.organizations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organizationId: a.id,
            running: 2,
            cancelling: 0,
          }),
          expect.objectContaining({
            organizationId: b.id,
            running: 1,
            cancelling: 0,
          }),
          expect.objectContaining({
            organizationId: idleOrg.id,
            running: 0,
            cancelling: 0,
          }),
        ])
      );

      const paused = await t.request(
        "POST",
        `/api/organizations/${a.id}/agents/${a.workers[0]!.id}/pause`,
        {}
      );
      expect(paused.status).toBe(200);

      const after = await overview();
      expect(after.runs).toEqual({ running: 3, cancelling: 1 });
      expect(after.organizations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organizationId: a.id,
            running: 2,
            cancelling: 1,
          }),
        ])
      );
      // 대시보드의 진행 중 수·목록은 실제 진행 중 실행 시도와 같다.
      const summary = await dashboard(a.id);
      const running = await runningRuns(a.id);
      expect(summary.runs.running).toBe(running.length);
      expect(summary.cancelling).toBe(1);
      expect(summary.runningRuns.map((r) => r.id).sort()).toEqual(
        running.map((r) => r.id).sort()
      );
      expect(
        summary.runningRuns.find((r) => r.agentId === a.workers[0]!.id)
      ).toMatchObject({ status: "running", cancelReason: "agent_paused" });
      expect((await dashboard(b.id)).runningRuns).toEqual([
        expect.objectContaining({ agentId: b.lead.id, cancelReason: null }),
      ]);
    } finally {
      stuck.open();
      held.open();
      heldB.open();
    }
    await t.drain();
    expect((await overview()).runs).toEqual({ running: 0, cancelling: 0 });
    expect((await dashboard(a.id)).runs).toMatchObject({
      running: 0,
      cancelled: 1,
    });
  });
});

describe("last activity on the home", () => {
  it("gives each organization the time of its own latest event", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const quiet = await createOrganization("조용한 조직");
    const busy = await createOrganization("바쁜 조직");
    await say(busy.id, "안녕하세요");
    await t.drain();
    const latest = async (orgId: string) =>
      (await eventsOf(orgId))
        .map((e) => e.createdAt)
        .reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    const at = Object.fromEntries(
      (await overview()).organizations.map((o) => [
        o.organizationId,
        o.lastActivityAt,
      ])
    );
    expect(Date.parse(at[quiet.id]!)).toBe(Date.parse(await latest(quiet.id)));
    expect(Date.parse(at[busy.id]!)).toBe(Date.parse(await latest(busy.id)));
    // 다른 조직의 Event는 조용한 조직의 시각을 바꾸지 않는다.
    expect(Date.parse(at[busy.id]!)).toBeGreaterThan(Date.parse(at[quiet.id]!));
  });
});

describe("rooms on the home", () => {
  it("lists organizations in creation order with their agents in join order, each agent's state and what a working agent holds, and the owner decisions still open", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const awaiting = await createOrganization("승인 기다리는 방");
    const room = await researching(agents, "작업하는 방");
    const closed = await createOrganization("끝난 방");
    expect(
      (await t.request("POST", `/api/organizations/${closed.id}/stop`, {}))
        .status
    ).toBe(200);
    // 함께 들어온 작업자는 처음 받은 이름의 번호 순으로 앉는다.
    const [first, second] = [...room.workers].sort((a, b) =>
      a.name.localeCompare(b.name)
    ) as [(typeof room.workers)[number], (typeof room.workers)[number]];

    // 작업자 1은 맡은 작업에 착수한 채 붙잡히고, 작업자 2는 실패로 끝난다.
    const held = createGate();
    const heldComment = createGate();
    try {
      agents.queue(first.id, (request) => {
        const assigned = request.wakeReasons.find(
          (r) => r.kind === "task_assigned"
        )!;
        return {
          steps: [
            {
              do: "call",
              tool: "start_task",
              params: () => ({ taskId: assigned.taskId }),
            },
            { do: "hold", until: held.wait },
          ],
        };
      });
      agents.queue(second.id, {
        steps: [{ do: "fail", error: "일부러 실패" }],
      });
      agents.queue(
        room.lead.id,
        calls(
          {
            tool: "create_task",
            input: { title: "긴 문헌 조사", assigneeAgentId: first.id },
          },
          {
            tool: "create_task",
            input: { title: "실패할 분석", assigneeAgentId: second.id },
          }
        )
      );
      await say(room.id, "작업을 맡겨 주세요");
      await held.reached;
      await expect
        .poll(async () =>
          (await allRuns(room.id)).some(
            (r) => r.agentId === second.id && r.status === "failed"
          )
        )
        .toBe(true);
      await expect
        .poll(async () => (await runningRuns(room.id)).length)
        .toBe(1);
      expect(
        (
          await t.request(
            "POST",
            `/api/organizations/${room.id}/agents/${room.lead.id}/pause`,
            {}
          )
        ).status
      ).toBe(200);

      const before = await overview();
      const orgs = (await get("/api/organizations")) as { id: string }[];
      // 만든 순서(목록 API와 같은 순서). 상태가 바뀌어도 순서는 그대로다.
      expect(before.organizations.map((o) => o.organizationId)).toEqual(
        orgs.map((o) => o.id)
      );
      const ids = before.organizations.map((o) => o.organizationId);
      expect(ids.indexOf(awaiting.id)).toBeLessThan(ids.indexOf(room.id));
      expect(ids.indexOf(room.id)).toBeLessThan(ids.indexOf(closed.id));
      const of = (id: string) =>
        before.organizations.find((o) => o.organizationId === id)!;

      expect(of(awaiting.id)).toMatchObject({
        name: "승인 기다리는 방",
        goal: goal.goal,
        stage: "awaiting_approval",
        createdAt: awaiting.createdAt,
        pendingDecisions: [
          { kind: "initial_research", createdAt: expect.any(String) },
        ],
        agents: [
          {
            id: awaiting.lead.id,
            role: "lead",
            name: awaiting.lead.name,
            appearance: awaiting.lead.appearance,
            status: "idle",
            paused: false,
            lastRunFailed: false,
            currentTask: null,
            wakeKind: null,
          },
        ],
      });
      // 끝난 조직의 승인 요청은 결정할 수 없으므로 기다리는 결정이 아니다.
      expect(of(closed.id)).toMatchObject({
        stage: "stopped",
        pendingDecisions: [],
      });

      const working = of(room.id);
      expect(working.stage).toBe("researching");
      expect(working.pendingDecisions).toEqual([]);
      expect(working.agents.map((a) => a.id)).toEqual([
        room.lead.id,
        first.id,
        second.id,
      ]);
      expect(working.agents).toEqual([
        expect.objectContaining({
          role: "lead",
          status: "idle",
          paused: true,
          lastRunFailed: false,
          currentTask: null,
        }),
        expect.objectContaining({
          role: "worker",
          status: "running",
          paused: false,
          lastRunFailed: false,
          currentTask: "긴 문헌 조사",
          wakeKind: "task_assigned",
        }),
        expect.objectContaining({
          role: "worker",
          status: "idle",
          lastRunFailed: true,
          currentTask: null,
          wakeKind: null,
        }),
      ]);

      // 작업이 진행 중이 아니어도 실행 시도가 받은 댓글의 작업을 붙잡고 있다. 다시 실행하면 실패 표시는 사라진다.
      agents.queue(second.id, {
        steps: [{ do: "hold", until: heldComment.wait }],
      });
      const failedTask = (await tasksOf(room.id)).find(
        (task) => task.title === "실패할 분석"
      )!;
      expect(
        (
          await t.request(
            "POST",
            `/api/organizations/${room.id}/tasks/${failedTask.id}/comments`,
            { body: "다시 봐 주세요" }
          )
        ).status
      ).toBe(201);
      await heldComment.reached;
      const retried = (await overview()).organizations
        .find((o) => o.organizationId === room.id)!
        .agents.find((a) => a.id === second.id);
      expect(retried).toMatchObject({
        status: "running",
        lastRunFailed: false,
        currentTask: "실패할 분석",
        wakeKind: "task_comment",
      });
    } finally {
      held.open();
      heldComment.open();
    }
    await t.drain();
    const after = (await overview()).organizations.find(
      (o) => o.organizationId === room.id
    )!;
    expect(after.agents.every((a) => a.status === "idle")).toBe(true);
    expect(after.agents.every((a) => a.currentTask === null)).toBe(true);
  });
});
