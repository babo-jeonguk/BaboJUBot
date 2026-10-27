import { randomUUID } from "node:crypto";
import {
  type NotificationChannel,
  approvalSummaryListSchema,
  conversationMessageListSchema,
  fakeChannelMessagesSchema,
  inboxSchema,
  needsAttention,
  organizationDetailSchema,
  outboxSchema,
  resultSubmissionSummaryListSchema,
  runSummaryListSchema,
  type Notification,
  type WakeReason,
} from "@babojubot/contracts";
import { leadReplyScript } from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/index.ts";
import {
  calls,
  goal,
  proposeScript,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, create, say, tasksOf, taskDetail, eventsOf, researching } =
  serverHelpers(() => t!);

const outboxOf = async (orgId: string) =>
  outboxSchema
    .parse(await get("/api/notifications"))
    .filter((e) => e.organizationId === orgId);
const channelOf = async (orgId: string) =>
  fakeChannelMessagesSchema
    .parse(await get("/api/channels/fake/messages"))
    .filter((m) => m.organizationId === orgId);
const inboxOf = async (orgId: string) =>
  inboxSchema
    .parse(await get("/api/inbox"))
    .filter(
      (i) =>
        (i.kind === "approval"
          ? i.approval.organizationId
          : i.kind === "result_submission"
            ? i.submission.organizationId
            : i.run.organizationId) === orgId
    );
const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));
const approvalsOf = async (orgId: string) =>
  approvalSummaryListSchema.parse(
    await get(`/api/organizations/${orgId}/approvals`)
  );
const runsOf = async (orgId: string) =>
  runSummaryListSchema.parse(await get(`/api/organizations/${orgId}/runs`));
const reply = (messageId: string, body: unknown) =>
  t!.request("POST", `/api/channels/fake/messages/${messageId}/reply`, body);
const tidy = (orgId: string, kind: string, sourceId: string, body: unknown) =>
  t!.request(
    "PUT",
    `/api/organizations/${orgId}/inbox/${kind}/${sourceId}`,
    body
  );
const failing = (error: string) => ({
  steps: [{ do: "fail" as const, error }],
});

/** 사용자가 목표를 적어 조직을 만들고, 생성으로 깨어난 Lead가 초기 연구 승인을 요청한 상태. 결정에는 Lead가 답장만 한다. */
async function awaitingApproval(
  agents: ReturnType<typeof scriptedAgents>,
  name: string
) {
  const org = await create(name);
  const lead = org.agents.find((a) => a.role === "lead")!;
  agents.queue(lead.id, leadReplyScript);
  const [approval] = await approvalsOf(org.id);
  return { id: org.id, lead, approvalId: approval!.id };
}

describe("notification outbox and fake channel", () => {
  it("queues Lead messages, both kinds of approval request, result submissions and failed runs, and the fake channel records each once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    // 초기 연구 승인 요청 → 승인 → Lead 답장(Lead 메시지).
    const org = await researching(agents, "알림 조직");
    // 작업자 추가 승인 요청.
    expect(
      (
        await t.request("PUT", `/api/organizations/${org.id}/approval-policy`, {
          addWorker: true,
        })
      ).status
    ).toBe(200);
    agents.queue(
      org.lead.id,
      calls({ tool: "add_worker", input: { role: "researcher" } })
    );
    await say(org.id, "작업자를 더 두세요");
    await t.drain();
    // 실패한 실행 시도.
    agents.queue(org.lead.id, failing("가짜 실행기 사고"));
    await say(org.id, "실패해 보세요");
    await t.drain();
    // 결과 제출(근거 산출물을 남긴 작업 뒤).
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "오류 분류", assigneeAgentId: org.workers[0]!.id },
      })
    );
    await say(org.id, "작업을 맡겨 주세요");
    await t.drain();
    const [task] = await tasksOf(org.id);
    const [artifact] = (await taskDetail(org.id, task!.id)).artifacts;
    agents.queue(
      org.lead.id,
      calls({
        tool: "submit_result",
        input: { summary: "오류 유형 세 가지", artifactIds: [artifact!.id] },
      })
    );
    await say(org.id, "결과를 정리해 주세요");
    await t.drain();
    await t.deliverNotifications();

    const approvals = await approvalsOf(org.id);
    const [submission] = resultSubmissionSummaryListSchema.parse(
      await get(`/api/organizations/${org.id}/results`)
    );
    // 결정을 기다리는 결과 제출도 보관할 수 없다.
    expect(
      await tidy(org.id, "result_submission", submission!.id, {
        archived: true,
      })
    ).toMatchObject({
      status: 422,
      body: { error: { code: "archive_not_allowed" } },
    });
    const failed = (await runsOf(org.id)).filter((r) => r.status === "failed");
    const leadMessages = conversationMessageListSchema
      .parse(await get(`/api/organizations/${org.id}/messages`))
      .filter((m) => m.author === "agent");
    expect(failed).toHaveLength(1);
    expect(leadMessages.length).toBeGreaterThan(0);

    const outbox = await outboxOf(org.id);
    const sourcesOf = (kind: string) =>
      outbox.filter((e) => e.kind === kind).map((e) => e.sourceId);
    expect(sourcesOf("approval_request").sort()).toEqual(
      approvals.map((a) => a.id).sort()
    );
    expect(approvals.map((a) => a.kind).sort()).toEqual([
      "add_worker",
      "initial_research",
    ]);
    expect(sourcesOf("result_submission")).toEqual([submission!.id]);
    expect(sourcesOf("run_failure")).toEqual([failed[0]!.id]);
    // 사용자 메시지는 알리지 않는다.
    expect(sourcesOf("lead_message").sort()).toEqual(
      leadMessages.map((m) => m.id).sort()
    );
    for (const entry of outbox)
      expect(entry.delivery).toMatchObject({
        status: "sent",
        attempts: 1,
        lastError: null,
      });

    const channel = await channelOf(org.id);
    expect(channel.map((m) => m.notificationId).sort()).toEqual(
      outbox.map((e) => e.id).sort()
    );
    const recordOf = (kind: string) => channel.find((m) => m.kind === kind)!;
    expect(recordOf("run_failure")).toMatchObject({
      organizationName: "알림 조직",
      title: "실행 시도 실패",
      body: "Research Lead: 가짜 실행기 사고",
      link: `/inbox/${org.id}/run_failure/${failed[0]!.id}`,
    });
    expect(recordOf("result_submission")).toMatchObject({
      body: "오류 유형 세 가지",
      link: `/inbox/${org.id}/result_submission/${submission!.id}`,
    });
    expect(
      channel
        .filter((m) => m.kind === "approval_request")
        .map((m) => m.title)
        .sort()
    ).toEqual(["작업자 추가 승인 요청", "초기 연구 승인 요청"]);
    // 알림을 누르면 Inbox 상세(요약)가 열린다. Lead 메시지는 Inbox 항목이 아니라 대화로 간다.
    for (const m of channel.filter((m) => m.kind === "approval_request"))
      expect(m.link).toBe(`/inbox/${org.id}/approval/${m.sourceId}`);
    // 이 조직의 Lead 메시지는 모두 기본 대화에 있다.
    const [chat] = (await get(
      `/api/organizations/${org.id}/conversations`
    )) as {
      id: string;
    }[];
    expect(recordOf("lead_message").link).toBe(
      `/orgs/${org.id}/chat/${chat!.id}`
    );

    // 다시 보내도 전송 기록은 늘지 않는다.
    await t.deliverNotifications();
    expect(await channelOf(org.id)).toHaveLength(channel.length);
  });

  it("keeps an undelivered notification and retries it after the delay, recording it once", async () => {
    let now = new Date("2026-10-23T09:00:00.000Z");
    let down = true;
    const delivered: Notification[] = [];
    const flaky: NotificationChannel = {
      name: "flaky",
      async deliver(notification) {
        if (down) throw new Error("채널 연결 끊김");
        delivered.push(notification);
      },
    };
    // 생성으로 깨어난 Lead는 Lead 대화 답장 없이 요청만 해, 알림은 승인 요청 하나다.
    const agents = scriptedAgents({ created: proposeScript });
    t = await startTestServer({
      runtime: agents.runtime,
      now: () => now,
      notificationChannel: flaky,
    });
    const org = await awaitingApproval(agents, "재시도 조직");
    await t.deliverNotifications();
    const [entry] = await outboxOf(org.id);
    expect(entry).toMatchObject({
      kind: "approval_request",
      sourceId: org.approvalId,
      delivery: {
        status: "pending",
        attempts: 1,
        nextAttemptAt: new Date(now.getTime() + 1_000).toISOString(),
        lastError: "채널 연결 끊김",
      },
    });

    down = false;
    await t.deliverNotifications();
    expect(delivered).toEqual([]);
    now = new Date(now.getTime() + 1_000);
    await t.deliverNotifications();
    expect(delivered.map((n) => n.id)).toEqual([entry!.id]);
    expect((await outboxOf(org.id))[0]!.delivery).toMatchObject({
      status: "sent",
      attempts: 2,
      sentAt: now.toISOString(),
    });
  });

  it("delivers after a restart what was stored but never sent", async () => {
    const agents = scriptedAgents({ created: proposeScript });
    t = await startTestServer({
      runtime: agents.runtime,
      notificationChannel: {
        name: "off",
        deliver: () => Promise.reject(new Error("꺼짐")),
      },
    });
    const org = await awaitingApproval(agents, "재시작 조직");
    await t.deliverNotifications();
    await t.stopServer();

    const restarted = await startServer({
      db: t.db,
      port: 0,
      now: () => new Date(Date.now() + 60_000),
    });
    try {
      await restarted.deliverNotifications();
      const res = await fetch(`${restarted.url}/api/channels/fake/messages`);
      const records = fakeChannelMessagesSchema
        .parse(await res.json())
        .filter((m) => m.organizationId === org.id);
      expect(records.map((m) => [m.kind, m.sourceId])).toEqual([
        ["approval_request", org.approvalId],
      ]);
    } finally {
      await restarted.close();
    }
  });

  it("an approval decision through the fake channel has the same effect as the dashboard's", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const viaDashboard = await awaitingApproval(agents, "대시보드 조직");
    const viaChannel = await awaitingApproval(agents, "채널 조직");
    await t.deliverNotifications();

    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${viaDashboard.id}/approvals/${viaDashboard.approvalId}/decision`,
          { decision: "approve" }
        )
      ).status
    ).toBe(200);
    const message = (await channelOf(viaChannel.id)).find(
      (m) => m.kind === "approval_request"
    )!;
    const replied = await reply(message.id, { decision: "approve" });
    expect(replied.status).toBe(200);
    expect(replied.body).toMatchObject({
      id: viaChannel.approvalId,
      status: "approved",
    });
    await t.drain();

    const effects = async (org: { id: string; lead: { id: string } }) => {
      const detail = await organization(org.id);
      const decided = (await eventsOf(org.id)).filter(
        (e) => e.type === "approval.decided"
      );
      const wakes = agents
        .of(org.lead.id)
        .flatMap((r) => r.request.wakeReasons)
        .filter(
          (r): r is Extract<WakeReason, { kind: "approval_decision" }> =>
            r.kind === "approval_decision"
        );
      return {
        stage: detail.stage,
        roles: detail.agents.map((a) => a.role).sort(),
        decided: decided.map((e) => ({
          by: e.type === "approval.decided" && e.payload.by,
          decision: e.type === "approval.decided" && e.payload.decision,
        })),
        wakes: wakes.map((w) => w.decision),
      };
    };
    const expected = {
      stage: "researching",
      roles: ["lead", "worker", "worker"],
      decided: [{ by: "owner", decision: "approve" }],
      wakes: ["approve"],
    };
    expect(await effects(viaDashboard)).toEqual(expected);
    expect(await effects(viaChannel)).toEqual(expected);

    // 이미 결정한 요청은 채널로도 대시보드로도 다시 결정되지 않는다.
    expect(
      await reply(message.id, { decision: "reject", note: "늦음" })
    ).toMatchObject({
      status: 409,
      body: { error: { code: "already_decided" } },
    });
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${viaChannel.id}/approvals/${viaChannel.approvalId}/decision`,
          { decision: "reject", note: "늦음" }
        )
      ).status
    ).toBe(409);
    expect(await effects(viaChannel)).toEqual(expected);
  });

  it("a worker request decided through the fake channel adds the worker and wakes the Lead like the dashboard, without changes requested", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "작업자 채널 조직");
    await t.request("PUT", `/api/organizations/${org.id}/approval-policy`, {
      addWorker: true,
    });
    agents.queue(
      org.lead.id,
      calls({ tool: "add_worker", input: { role: "researcher" } })
    );
    await say(org.id, "작업자를 더 두세요");
    await t.drain();
    await t.deliverNotifications();
    const request = (await approvalsOf(org.id)).find(
      (a) => a.kind === "add_worker"
    )!;
    const message = (await channelOf(org.id)).find(
      (m) => m.kind === "approval_request" && m.sourceId === request.id
    )!;

    // 작업자 추가에는 수정 요청이 없다는 대시보드 명령의 거부가 그대로 돌아온다.
    expect(
      await reply(message.id, { decision: "request_changes", note: "다시" })
    ).toMatchObject({
      status: 422,
      body: { error: { code: "decision_not_allowed" } },
    });
    expect(await reply(message.id, { decision: "approve" })).toMatchObject({
      status: 200,
      body: { id: request.id, status: "approved" },
    });
    await t.drain();
    const detail = await organization(org.id);
    expect(detail.stage).toBe("researching");
    expect(detail.agents.filter((a) => a.role === "worker")).toHaveLength(3);
    expect(
      (await eventsOf(org.id)).filter(
        (e) =>
          e.type === "approval.decided" &&
          e.payload.approvalId === request.id &&
          e.payload.by === "owner"
      )
    ).toHaveLength(1);
    expect(
      agents
        .of(org.lead.id)
        .flatMap((r) => r.request.wakeReasons)
        .filter(
          (r) =>
            r.kind === "approval_decision" && r.approvalKind === "add_worker"
        )
        .map((r) => r.kind === "approval_decision" && r.decision)
    ).toEqual(["approve"]);
  });

  it("refuses channel replies that are not an approval decision for a delivered approval request", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await awaitingApproval(agents, "거부 조직");
    // 승인 대기 중에도 Lead는 대화에 답한다(Lead 메시지 알림).
    await say(org.id, "진행 상황을 알려 주세요");
    await t.drain();
    await t.deliverNotifications();
    const records = await channelOf(org.id);
    const approvalMessage = records.find((m) => m.kind === "approval_request")!;
    const leadMessage = records.find((m) => m.kind === "lead_message")!;

    // 결정 입력 계약 그대로: 사유 없는 반려, 다른 조직을 가리키려는 추가 필드는 받지 않는다.
    expect(
      (await reply(approvalMessage.id, { decision: "reject" })).status
    ).toBe(422);
    expect(
      (
        await reply(approvalMessage.id, {
          decision: "approve",
          organizationId: org.id,
        })
      ).status
    ).toBe(422);
    expect(await reply(leadMessage.id, { decision: "approve" })).toMatchObject({
      status: 422,
      body: { error: { code: "reply_not_allowed" } },
    });
    expect(
      (
        await reply("00000000-0000-4000-8000-000000000000", {
          decision: "approve",
        })
      ).status
    ).toBe(404);
    expect((await reply("not-a-uuid", { decision: "approve" })).status).toBe(
      404
    );
    expect((await organization(org.id)).stage).toBe("awaiting_approval");
    expect((await approvalsOf(org.id))[0]!.status).toBe("pending");
  });
});

describe("Inbox", () => {
  it("lists every failed run, even after a later success, and keeps read and archive apart from the run", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "실패 조직");
    const other = await researching(agents, "다른 조직");
    agents.queue(
      org.lead.id,
      failing("첫 실패"),
      leadReplyScript,
      failing("두 번째 실패")
    );
    for (const body of ["하나", "둘", "셋"]) {
      await say(org.id, body);
      await t.drain();
    }
    const failed = (await runsOf(org.id))
      .filter((r) => r.status === "failed")
      .reverse();
    expect(failed).toHaveLength(2);

    const failures = (await inboxOf(org.id)).filter(
      (i) => i.kind === "run_failure"
    );
    expect(failures).toEqual(
      failed.map((run) => ({
        kind: "run_failure",
        organizationName: "실패 조직",
        agentName: "Research Lead",
        read: false,
        archived: false,
        run,
      }))
    );

    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    const first = failed[0]!.id;
    expect(await tidy(org.id, "run_failure", first, { read: true })).toEqual({
      status: 200,
      body: { read: true, archived: false },
    });
    expect(await stream.next()).toMatchObject({
      type: "inbox_item.updated",
      payload: {
        by: "owner",
        kind: "run_failure",
        sourceId: first,
        read: true,
        archived: false,
      },
    });
    expect(
      await tidy(org.id, "run_failure", first, { archived: true })
    ).toMatchObject({ status: 200, body: { read: true, archived: true } });
    await stream.next();
    // 같은 값은 아무것도 남기지 않는다.
    expect(
      await tidy(org.id, "run_failure", first, { read: true, archived: true })
    ).toMatchObject({ status: 200, body: { read: true, archived: true } });
    const seen = stream.events.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(stream.events).toHaveLength(seen);
    stream.close();

    const [archived, unread] = (await inboxOf(org.id)).filter(
      (i) => i.kind === "run_failure"
    );
    expect(archived).toMatchObject({ read: true, archived: true });
    expect(unread).toMatchObject({ read: false, archived: false });
    expect((await runsOf(org.id)).find((r) => r.id === first)!.status).toBe(
      "failed"
    );

    // 다른 조직의 실행 시도, 실패하지 않은 실행 시도, 없는 종류와 빈 명령은 받지 않는다.
    expect(
      (await tidy(other.id, "run_failure", first, { read: true })).status
    ).toBe(404);
    const completed = (await runsOf(org.id)).find(
      (r) => r.status === "completed"
    )!;
    expect(
      (await tidy(org.id, "run_failure", completed.id, { read: true })).status
    ).toBe(404);
    expect((await tidy(org.id, "task", first, { read: true })).status).toBe(
      404
    );
    expect((await tidy(org.id, "run_failure", first, {})).status).toBe(422);
    expect(
      (await tidy(org.id, "run_failure", first, { read: "yes" })).status
    ).toBe(422);
  });

  it("reading a pending approval request leaves the decision, the stage and the Lead alone, archiving it is refused until it is decided, and it stays after the decision", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await awaitingApproval(agents, "보관 조직");
    const runsBefore = (await runsOf(org.id)).length;

    // 다른 조직의 원본과 없는 원본은 보관 여부를 따지기 전에 찾을 수 없다.
    const other = organizationDetailSchema.parse(
      (
        await t.request("POST", "/api/organizations", {
          name: "다른 보관 조직",
          ...goal,
        })
      ).body
    );
    expect(
      (await tidy(other.id, "approval", org.approvalId, { archived: true }))
        .status
    ).toBe(404);
    expect(
      (await tidy(org.id, "approval", randomUUID(), { archived: true })).status
    ).toBe(404);

    // 결정을 기다리는 항목은 보관할 수 없다. 함께 보낸 읽음도 반영하지 않는다.
    expect(
      await tidy(org.id, "approval", org.approvalId, {
        read: true,
        archived: true,
      })
    ).toMatchObject({
      status: 422,
      body: { error: { code: "archive_not_allowed" } },
    });
    expect(await inboxOf(org.id)).toEqual([
      expect.objectContaining({
        kind: "approval",
        read: false,
        archived: false,
      }),
    ]);

    expect(
      await tidy(org.id, "approval", org.approvalId, { read: true })
    ).toMatchObject({ status: 200, body: { read: true, archived: false } });
    await t.drain();
    expect(await inboxOf(org.id)).toEqual([
      expect.objectContaining({
        kind: "approval",
        read: true,
        archived: false,
        approval: expect.objectContaining({
          id: org.approvalId,
          status: "pending",
        }),
      }),
    ]);
    expect((await organization(org.id)).stage).toBe("awaiting_approval");
    expect(await runsOf(org.id)).toHaveLength(runsBefore);

    // 결정해도 Inbox에 결정 상태와 함께 남고, 주의 필요에서만 빠진다. 사용자가 붙인 읽음은 그대로다.
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${org.id}/approvals/${org.approvalId}/decision`,
          { decision: "approve" }
        )
      ).status
    ).toBe(200);
    const [decided] = await inboxOf(org.id);
    expect(decided).toMatchObject({
      kind: "approval",
      read: true,
      archived: false,
      approval: { id: org.approvalId, status: "approved" },
    });
    expect(needsAttention(decided!)).toBe(false);

    // 결정한 항목은 보관하고 되돌릴 수 있으며, 결정은 그대로다.
    expect(
      await tidy(org.id, "approval", org.approvalId, { archived: true })
    ).toMatchObject({ status: 200, body: { read: true, archived: true } });
    expect(await inboxOf(org.id)).toEqual([
      expect.objectContaining({
        archived: true,
        approval: expect.objectContaining({ status: "approved" }),
      }),
    ]);
    expect(
      await tidy(org.id, "approval", org.approvalId, { archived: false })
    ).toMatchObject({ status: 200, body: { read: true, archived: false } });

    // 중단된 조직의 결정한 항목도 기록으로 남는다.
    expect(
      (await t.request("POST", `/api/organizations/${org.id}/stop`, {})).status
    ).toBe(200);
    expect(await inboxOf(org.id)).toEqual([
      expect.objectContaining({
        approval: expect.objectContaining({
          id: org.approvalId,
          status: "approved",
        }),
      }),
    ]);
  });

  it("shows a decided item nobody organized as read, and archiving it keeps it read", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await awaitingApproval(agents, "정리하지 않은 조직");
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${org.id}/approvals/${org.approvalId}/decision`,
          { decision: "reject", note: "범위를 줄여 주세요" }
        )
      ).status
    ).toBe(200);
    await t.drain();
    const rejected = (await inboxOf(org.id)).find(
      (i) => i.kind === "approval" && i.approval.id === org.approvalId
    );
    expect(rejected).toMatchObject({
      read: true,
      archived: false,
      approval: { status: "rejected" },
    });
    expect(
      await tidy(org.id, "approval", org.approvalId, { archived: true })
    ).toMatchObject({ status: 200, body: { read: true, archived: true } });
  });
});
