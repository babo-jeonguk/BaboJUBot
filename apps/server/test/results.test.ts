import {
  inboxSchema,
  needsAttention,
  orgToolNames,
  orgTools,
  organizationDetailSchema,
  resultSubmissionSchema,
  resultSubmissionSummaryListSchema,
  runSummaryListSchema,
  type Event,
  type OrganizationCommand,
  type RuntimeAdapter,
  type WakeReason,
} from "@babojubot/contracts";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/index.ts";
import {
  chatMessages,
  calls,
  idle,
  ok,
  reasons,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, say, taskDetail, tasksOf, eventsOf, researching } = serverHelpers(
  () => t!
);

const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));
const submissions = async (orgId: string) =>
  resultSubmissionSummaryListSchema.parse(
    await get(`/api/organizations/${orgId}/results`)
  );
const submission = async (orgId: string, submissionId: string) =>
  resultSubmissionSchema.parse(
    await get(`/api/organizations/${orgId}/results/${submissionId}`)
  );
const runsOf = async (orgId: string) =>
  runSummaryListSchema.parse(await get(`/api/organizations/${orgId}/runs`));
/** Inbox의 결과 제출 항목. 앞서 결정한 초기 연구 승인 요청은 결정 기록으로 남아 있다. */
const inbox = async () =>
  inboxSchema
    .parse(await get("/api/inbox"))
    .filter((i) => i.kind === "result_submission");
/** 결정한 결과 제출은 결정 상태와 함께 Inbox에 남고, 결정했으니 읽음이며 주의 필요가 아니다. */
async function expectKeptDecided(submissionId: string, status: string) {
  const items = await inbox();
  expect(items).toEqual([
    expect.objectContaining({
      read: true,
      archived: false,
      submission: expect.objectContaining({ id: submissionId, status }),
    }),
  ]);
  expect(needsAttention(items[0]!)).toBe(false);
}
const decide = (
  orgId: string,
  submissionId: string,
  body: Record<string, unknown>
) =>
  t!.request(
    "POST",
    `/api/organizations/${orgId}/results/${submissionId}/decision`,
    body
  );
const resultEvents = async (orgId: string) =>
  (await eventsOf(orgId)).filter((e) => e.type.startsWith("result."));
const changesRequested = (runs: { request: { wakeReasons: WakeReason[] } }[]) =>
  reasons(runs).filter((r) => r.kind === "result_changes_requested");

/** 실행 시도마다 받은 토큰을 에이전트별로 모으는 프로바이더. */
function capturingTokens(inner: RuntimeAdapter) {
  const tokens = new Map<string, string>();
  const runtime: RuntimeAdapter = {
    ...inner,
    execute(request, control) {
      tokens.set(request.identity.agentId, request.access.token);
      return inner.execute(request, control);
    },
  };
  return { runtime, tokenOf: (agentId: string) => tokens.get(agentId)! };
}

/** 연구 진행 중이고, 작업자 하나가 기본 시나리오로 작업을 끝내 산출물 하나를 남긴 조직. */
async function withArtifact(
  agents: ReturnType<typeof scriptedAgents>,
  name: string
) {
  const org = await researching(agents, name);
  agents.queue(
    org.lead.id,
    calls({
      tool: "create_task",
      input: { title: "오류 유형 분류", assigneeAgentId: org.workers[0]!.id },
    })
  );
  await say(org.id, "작업을 맡겨 주세요");
  await t!.drain();
  const [task] = await tasksOf(org.id);
  const [artifact] = (await taskDetail(org.id, task!.id)).artifacts;
  return { ...org, task: task!, artifact: artifact! };
}

/** Lead가 근거 산출물과 함께 결과를 제출해 결과 검토 중인 조직. */
async function submitted(
  agents: ReturnType<typeof scriptedAgents>,
  name: string
) {
  const org = await withArtifact(agents, name);
  agents.queue(
    org.lead.id,
    calls({
      tool: "submit_result",
      input: {
        summary: "오류 유형 세 가지를 정리했다",
        artifactIds: [org.artifact.id],
      },
    })
  );
  await say(org.id, "결과를 정리해 주세요");
  await t!.drain();
  const [pending] = await submissions(org.id);
  expect(pending).toMatchObject({ status: "pending" });
  return { ...org, submissionId: pending!.id };
}

describe("result submission and final completion", () => {
  it("submitting a result puts the organization in result review with a fixed review target and lists it in the Inbox", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await withArtifact(agents, "결과 제출 조직");
    const before = await organization(org.id);
    const stream = await t.subscribe({ kind: "all" });

    agents.queue(
      org.lead.id,
      calls({
        tool: "submit_result",
        input: {
          summary: "  오류 유형 세 가지를 정리했다  ",
          artifactIds: [org.artifact.id],
        },
      })
    );
    await say(org.id, "결과를 정리해 주세요");
    await t.drain();

    const leadRun = agents.of(org.lead.id).at(-1)!;
    const output = resultSubmissionSchema.parse(ok(leadRun.state.calls[0]));
    expect((await organization(org.id)).stage).toBe("result_review");
    // 제출은 서버가 정한 출처·검토 기준과 같은 조직 산출물을 묶어 고정한다. 다시 읽어도 같다.
    const detail = await submission(org.id, output.id);
    expect(detail).toEqual(output);
    expect(detail).toMatchObject({
      organizationId: org.id,
      status: "pending",
      submittedByAgentId: org.lead.id,
      submittedByRunId: leadRun.request.identity.runId,
      previousSubmissionId: null,
      summary: "오류 유형 세 가지를 정리했다",
      goal: before.goal,
      completionCriteria: before.completionCriteria,
      decisionNote: null,
      decidedAt: null,
      artifacts: [
        {
          id: org.artifact.id,
          organizationId: org.id,
          taskId: org.task.id,
          title: org.artifact.title,
          format: "markdown",
          createdByAgentId: org.workers[0]!.id,
          createdByRunId: org.artifact.createdByRunId,
          createdAt: org.artifact.createdAt,
        },
      ],
    });
    expect(await submissions(org.id)).toEqual([
      expect.objectContaining({ id: output.id, status: "pending" }),
    ]);
    expect(await inbox()).toEqual([
      {
        kind: "result_submission",
        organizationName: "결과 제출 조직",
        read: false,
        archived: false,
        submission: expect.objectContaining({
          id: output.id,
          organizationId: org.id,
          status: "pending",
        }),
      },
    ]);
    const submittedEvent = (await resultEvents(org.id))[0];
    expect(submittedEvent).toMatchObject({
      type: "result.submitted",
      payload: {
        submissionId: output.id,
        runId: leadRun.request.identity.runId,
        agentId: org.lead.id,
        artifactIds: [org.artifact.id],
        stage: "result_review",
      },
    });
    while ((await stream.next()).type !== "result.submitted") {
      /* 전체 구독에도 온다 */
    }
    stream.close();
  });

  it("requesting changes returns to researching and wakes the Lead with the note; a resubmission is a new submission and the earlier decision stays", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await submitted(agents, "수정 요청 조직");
    const leadRunsBefore = agents.of(org.lead.id).length;

    // 수정 요청에는 의견이 필요하다.
    expect(
      (await decide(org.id, org.submissionId, { decision: "request_changes" }))
        .status
    ).toBe(422);
    expect(
      (
        await decide(org.id, org.submissionId, {
          decision: "request_changes",
          note: "   ",
        })
      ).status
    ).toBe(422);

    agents.queue(org.lead.id, idle);
    const res = await decide(org.id, org.submissionId, {
      decision: "request_changes",
      note: "평가셋 근거를 더 붙여 주세요",
    });
    expect(res.status).toBe(200);
    expect(resultSubmissionSchema.parse(res.body)).toMatchObject({
      id: org.submissionId,
      status: "changes_requested",
      decisionNote: "평가셋 근거를 더 붙여 주세요",
      decidedAt: expect.any(String),
    });
    expect((await organization(org.id)).stage).toBe("researching");
    await expectKeptDecided(org.submissionId, "changes_requested");
    await t.drain();

    // Lead가 그 제출을 가리키는 수정 요청 사유로 깨어나 의견을 받는다.
    const woken = agents.of(org.lead.id).slice(leadRunsBefore);
    expect(changesRequested(woken)).toEqual([
      {
        kind: "result_changes_requested",
        wakeId: expect.any(String),
        submissionId: org.submissionId,
        note: "평가셋 근거를 더 붙여 주세요",
      },
    ]);
    expect((await resultEvents(org.id)).at(-1)).toMatchObject({
      type: "result.decided",
      payload: {
        submissionId: org.submissionId,
        by: "owner",
        decision: "request_changes",
        note: "평가셋 근거를 더 붙여 주세요",
        stage: "researching",
        wokenAgentId: org.lead.id,
      },
    });

    // 다시 제출하면 직전 제출을 가리키는 새 제출이고, 직전 제출의 내용과 결정은 그대로 남는다.
    agents.queue(
      org.lead.id,
      calls({
        tool: "submit_result",
        input: { summary: "근거를 보강했다", artifactIds: [org.artifact.id] },
      })
    );
    await say(org.id, "다시 제출해 주세요");
    await t.drain();
    const [latest, earlier] = await submissions(org.id);
    expect(latest).toMatchObject({
      status: "pending",
      previousSubmissionId: org.submissionId,
    });
    expect(earlier).toMatchObject({
      id: org.submissionId,
      status: "changes_requested",
    });
    expect((await submission(org.id, org.submissionId)).decisionNote).toBe(
      "평가셋 근거를 더 붙여 주세요"
    );
    expect((await organization(org.id)).stage).toBe("result_review");

    // 옛 제출로는 더 결정할 수 없다. 새 제출은 결정을 기다린다.
    const stale = await decide(org.id, org.submissionId, {
      decision: "complete",
    });
    expect(stale).toEqual({
      status: 409,
      body: { error: { code: "already_decided" } },
    });
    expect((await submission(org.id, latest!.id)).status).toBe("pending");
    expect((await organization(org.id)).stage).toBe("result_review");
  });

  it("after final completion a new wake never starts a run, even across a server restart", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await submitted(agents, "최종 완료 조직");

    const res = await decide(org.id, org.submissionId, {
      decision: "complete",
      note: "기준을 충족했습니다",
    });
    expect(res.status).toBe(200);
    expect(resultSubmissionSchema.parse(res.body)).toMatchObject({
      status: "completed",
      decisionNote: "기준을 충족했습니다",
    });
    expect((await organization(org.id)).stage).toBe("completed");
    await expectKeptDecided(org.submissionId, "completed");
    // 최종 완료는 아무도 깨우지 않는다.
    expect((await resultEvents(org.id)).at(-1)).toMatchObject({
      type: "result.decided",
      payload: { decision: "complete", stage: "completed", wokenAgentId: null },
    });
    await t.drain();
    const runsAfterCompletion = await runsOf(org.id);

    // 완료 뒤 Lead 대화는 메시지를 받지 않는다. 작업 댓글은 깨우기로 남지만 실행 시도는 시작되지 않는다.
    const late = await t.request(
      "POST",
      `/api/organizations/${org.id}/messages`,
      { body: "완료 뒤 메시지" }
    );
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ error: { code: "organization_closed" } });
    const comment = await t.request(
      "POST",
      `/api/organizations/${org.id}/tasks/${org.task.id}/comments`,
      { body: "완료 뒤 댓글" }
    );
    expect(comment.status).toBe(201);
    await t.drain();
    expect(await runsOf(org.id)).toEqual(runsAfterCompletion);
    expect((await chatMessages(t, org.id)).map((m) => m.body)).not.toContain(
      "완료 뒤 메시지"
    );
    // 같은 결정을 다시 보내도 효과가 없다.
    expect(
      (await decide(org.id, org.submissionId, { decision: "complete" })).status
    ).toBe(409);

    // 서버를 다시 시작해 남은 깨우기를 다시 확인해도 실행 시도는 없다.
    await t.stopServer();
    const restarted = await startServer({
      db: t.db,
      port: 0,
      runtime: agents.runtime,
    });
    try {
      await restarted.drain();
    } finally {
      await restarted.close();
    }
    const { listRuns } = await import("@babojubot/db");
    expect(await listRuns(t.db, org.id)).toEqual(runsAfterCompletion);
  });

  it("lets a run admitted before final completion finish on its own while its research writes are refused, and starts no run afterwards", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await submitted(agents, "진행 중 완료 조직");
    const gate = createGate();
    agents.queue(org.lead.id, {
      steps: [
        { do: "hold", until: gate.wait },
        {
          do: "call",
          tool: "create_task",
          input: () => ({
            title: "늦은 작업",
            assigneeAgentId: org.workers[0]!.id,
          }),
          allowRefusal: true,
        },
        { do: "send_message", body: () => "검토 중에 받은 질문에 답합니다" },
      ],
    });
    // 결과 검토 중에도 사용자 메시지로 Lead가 깨어나 답할 수 있다.
    await say(org.id, "3번 근거는 어떤 데이터로 만들었나요?");
    await gate.reached;

    expect(
      (await decide(org.id, org.submissionId, { decision: "complete" })).status
    ).toBe(200);
    // 완료 뒤에는 Lead 대화가 메시지를 받지 않는다.
    expect(
      (
        await t.request("POST", `/api/organizations/${org.id}/messages`, {
          body: "완료 뒤 메시지",
        })
      ).status
    ).toBe(409);
    gate.open();
    await t.drain();

    const held = agents.of(org.lead.id).at(-1)!;
    expect(held.state.calls).toEqual([
      { tool: "create_task", ok: false, status: 409, code: "stage_closed" },
    ]);
    expect(held.state.sent).toHaveLength(1);
    const runs = await runsOf(org.id);
    expect(runs[0]).toMatchObject({
      id: held.request.identity.runId,
      status: "completed",
    });
    // 완료 뒤에는 새 실행 시도가 없다.
    expect(agents.of(org.lead.id).at(-1)).toBe(held);
    expect(await tasksOf(org.id)).toHaveLength(1);
  });

  it("has no organization tool that completes the organization or changes the approval policy, and refuses result submission outside the Lead in researching", async () => {
    const agents = scriptedAgents();
    const capture = capturingTokens(agents.runtime);
    t = await startTestServer({ runtime: capture.runtime });
    const org = await withArtifact(agents, "도구 경계 조직");
    const [w1] = org.workers;

    // 작업자는 결과를 제출할 수 없고, 계약 밖 필드(단계·상태·출처)는 받지 않는다.
    agents.queue(
      w1!.id,
      calls({
        tool: "submit_result",
        input: { summary: "작업자 제출", artifactIds: [org.artifact.id] },
      })
    );
    agents.queue(
      org.lead.id,
      calls(
        {
          tool: "submit_result",
          input: {
            summary: "단계를 바꿔 제출",
            artifactIds: [org.artifact.id],
            stage: "completed",
          },
        },
        {
          tool: "submit_result",
          input: {
            summary: "중복 근거",
            artifactIds: [org.artifact.id, org.artifact.id],
          },
        },
        {
          tool: "submit_result",
          input: { summary: "근거 없음", artifactIds: [] },
        },
        {
          tool: "message_agent",
          input: { recipientAgentId: w1!.id, body: "제출을 시도해 보세요" },
        }
      )
    );
    await say(org.id, "결과 제출을 시도해 주세요");
    await t.drain();
    const outcome = (c: { ok: boolean; status?: number; code?: string }) =>
      c.ok ? "ok" : `${c.status} ${c.code}`;
    expect(agents.of(org.lead.id).at(-1)!.state.calls.map(outcome)).toEqual([
      "422 invalid_input",
      "422 invalid_input",
      "422 invalid_input",
      "ok",
    ]);
    expect(agents.of(w1!.id).at(-1)!.state.calls.map(outcome)).toEqual([
      "403 forbidden",
    ]);
    expect(await submissions(org.id)).toEqual([]);
    expect((await organization(org.id)).stage).toBe("researching");

    // 제출 뒤 결과 검토 중인 Lead가 조직 도구 전체를 완료·정책 변경 시도 입력으로 불러도 아무것도 완료되지 않는다.
    agents.queue(
      org.lead.id,
      calls({
        tool: "submit_result",
        input: { summary: "결과", artifactIds: [org.artifact.id] },
      })
    );
    await say(org.id, "제출해 주세요");
    await t.drain();
    const [pending] = await submissions(org.id);
    const gate = createGate();
    agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
    await say(org.id, "잠시 기다려 주세요");
    await gate.reached;
    // 조직 도구 목록에는 결과 제출까지만 있고 최종 완료·승인 결정·승인 정책 변경 도구가 없다.
    expect(orgToolNames).toContain("submit_result");
    expect(
      orgToolNames.filter((n) =>
        /(complete|finish|close)_(org|organization|research)|stage|polic|decide|decision|approve/.test(
          n
        )
      )
    ).toEqual([]);
    const token = capture.tokenOf(org.lead.id);
    const attempt = {
      decision: "complete",
      status: "completed",
      stage: "completed",
      approvalPolicy: {},
    };
    const id = pending!.id;
    for (const name of orgToolNames) {
      const { method } = orgTools[name];
      const path = orgTools[name].path.replace(/:\w+/g, id);
      const res = await t.tool(
        token,
        method,
        path,
        method === "GET" ? undefined : attempt
      );
      expect(res.status, name).not.toBe(500);
    }
    for (const path of [
      `/results/${id}/decision`,
      `/results/${id}/complete`,
      "/organization",
      "/organization/stage",
      "/complete",
      "/approval-policy",
      "/approvals/decision",
    ])
      for (const method of ["POST", "PATCH", "PUT"])
        expect((await t.tool(token, method, path, attempt)).status).toBe(404);
    gate.open();
    await t.drain();
    expect((await organization(org.id)).stage).toBe("result_review");
    expect((await submission(org.id, id)).status).toBe("pending");
    expect((await resultEvents(org.id)).map((e) => e.type)).toEqual([
      "result.submitted",
    ]);
    // 결과 검토 중에는 다시 제출할 수 없다.
    agents.queue(
      org.lead.id,
      calls({
        tool: "submit_result",
        input: { summary: "또 제출", artifactIds: [org.artifact.id] },
      })
    );
    await say(org.id, "또 제출해 주세요");
    await t.drain();
    expect(outcome(agents.of(org.lead.id).at(-1)!.state.calls[0]!)).toBe(
      "409 stage_closed"
    );
    expect(await submissions(org.id)).toHaveLength(1);
  });

  it("resumes a paused organization on a decision, completing it at once, and refuses decisions once stopped", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const control = (orgId: string, command: OrganizationCommand) =>
      t!.request("POST", `/api/organizations/${orgId}/${command}`, {});

    const changing = await submitted(agents, "멈춘 채 수정 요청");
    await control(changing.id, "pause");
    const changed = await decide(changing.id, changing.submissionId, {
      decision: "request_changes",
      note: "근거를 더 모아 주세요",
    });
    expect(changed.status).toBe(200);
    expect(await organization(changing.id)).toMatchObject({
      stage: "researching",
      pausedFrom: null,
    });
    const events = await eventsOf(changing.id);
    const resumedAt = events.findIndex(
      (e) => e.type === "organization.resumed"
    );
    expect(events.slice(resumedAt, resumedAt + 2)).toMatchObject([
      { type: "organization.resumed", payload: { stage: "result_review" } },
      { type: "result.decided", payload: { stage: "researching" } },
    ]);
    await t.drain();
    expect(changesRequested(agents.of(changing.lead.id))).toHaveLength(1);

    const completing = await submitted(agents, "멈춘 채 최종 완료");
    await control(completing.id, "pause");
    expect(
      (
        await decide(completing.id, completing.submissionId, {
          decision: "complete",
        })
      ).status
    ).toBe(200);
    expect(await organization(completing.id)).toMatchObject({
      stage: "completed",
      pausedFrom: null,
    });
    // 최종 완료한 조직은 제어 명령을 받지 않는다.
    for (const command of ["pause", "stop"] as const) {
      const res = await control(completing.id, command);
      expect(res.status, command).toBe(409);
      expect(res.body).toEqual({ error: { code: "organization_closed" } });
    }

    const stopped = await submitted(agents, "중단 뒤 결정");
    await control(stopped.id, "stop");
    const refused = await decide(stopped.id, stopped.submissionId, {
      decision: "complete",
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: { code: "organization_closed" } });
    expect((await submission(stopped.id, stopped.submissionId)).status).toBe(
      "pending"
    );
    expect(
      (await inbox()).filter(
        (item) =>
          item.kind === "result_submission" &&
          item.submission.id === stopped.submissionId
      )
    ).toEqual([]);
  });

  it("applies one of concurrent decisions once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await submitted(agents, "동시 결정 조직");
    agents.queue(org.lead.id, idle);

    const results = await Promise.all([
      decide(org.id, org.submissionId, {
        decision: "request_changes",
        note: "보강",
      }),
      decide(org.id, org.submissionId, { decision: "complete" }),
      decide(org.id, org.submissionId, { decision: "complete" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    await t.drain();
    const winner = resultSubmissionSchema.parse(
      results.find((r) => r.status === 200)!.body
    );
    const decided = (await resultEvents(org.id)).filter(
      (e) => e.type === "result.decided"
    );
    expect(decided).toHaveLength(1);
    expect((await submission(org.id, org.submissionId)).status).toBe(
      winner.status
    );
    expect((await organization(org.id)).stage).toBe(
      winner.status === "completed" ? "completed" : "researching"
    );
    expect(changesRequested(agents.of(org.lead.id))).toHaveLength(
      winner.status === "changes_requested" ? 1 : 0
    );
  });

  it("keeps submissions and their evidence inside their organization", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const a = await withArtifact(agents, "조직 A");
    const b = await submitted(agents, "조직 B");

    // A의 Lead는 B의 산출물을 근거로 묶을 수 없다. 없는 산출물과 같은 404이고 아무것도 바뀌지 않는다.
    agents.queue(
      a.lead.id,
      calls(
        {
          tool: "submit_result",
          input: { summary: "남의 근거", artifactIds: [b.artifact.id] },
        },
        {
          tool: "submit_result",
          input: {
            summary: "섞인 근거",
            artifactIds: [a.artifact.id, b.artifact.id],
          },
        },
        {
          tool: "submit_result",
          input: { summary: "없는 근거", artifactIds: [crypto.randomUUID()] },
        }
      )
    );
    await say(a.id, "제출해 주세요");
    await t.drain();
    expect(
      agents
        .of(a.lead.id)
        .at(-1)!
        .state.calls.map((c) => (c.ok ? "ok" : `${c.status} ${c.code}`))
    ).toEqual(["404 not_found", "404 not_found", "404 not_found"]);
    expect(await submissions(a.id)).toEqual([]);
    expect((await organization(a.id)).stage).toBe("researching");

    // A의 경로로는 B의 제출을 읽거나 결정할 수 없다.
    const viaA = `/api/organizations/${a.id}/results/${b.submissionId}`;
    expect((await t.request("GET", viaA)).status).toBe(404);
    expect(
      (await t.request("POST", `${viaA}/decision`, { decision: "complete" }))
        .status
    ).toBe(404);
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${a.id}/results/not-a-uuid/decision`,
          { decision: "complete" }
        )
      ).status
    ).toBe(404);
    expect((await submission(b.id, b.submissionId)).status).toBe("pending");
    expect((await organization(b.id)).stage).toBe("result_review");
    expect(await submissions(a.id)).toEqual([]);
    const bEvents: Event[] = await eventsOf(b.id);
    expect(bEvents.filter((e) => e.type === "result.decided")).toEqual([]);
    expect(
      (
        await t.request(
          "GET",
          `/api/organizations/${crypto.randomUUID()}/results`
        )
      ).status
    ).toBe(404);
  });
});

// 가짜 Lead의 데모 흐름: 사용자가 결과 제출을 부탁하면 완료한 작업의 산출물을 근거로 제출하고,
// 수정 요청을 받으면 의견을 반영해 다시 제출한다.
describe("demo Lead result submission", () => {
  it("submits the completed tasks' artifacts when asked and resubmits with the owner's note after a change request", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await withArtifact(agents, "데모 결과 조직");

    await say(org.id, "결과 제출 부탁해요");
    await t.drain();
    const [first] = await submissions(org.id);
    const detail = await submission(org.id, first!.id);
    expect(detail.artifacts.map((x) => x.id)).toEqual([org.artifact.id]);
    expect(detail.summary).toContain("오류 유형 분류");

    expect(
      (
        await decide(org.id, first!.id, {
          decision: "request_changes",
          note: "한계도 적어 주세요",
        })
      ).status
    ).toBe(200);
    await t.drain();
    const [second] = await submissions(org.id);
    expect(second).toMatchObject({
      status: "pending",
      previousSubmissionId: first!.id,
    });
    expect((await submission(org.id, second!.id)).summary).toContain(
      "한계도 적어 주세요"
    );
    expect((await organization(org.id)).stage).toBe("result_review");
  });

  it("does not submit without evidence artifacts", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "근거 없는 조직");
    await say(org.id, "결과를 제출해 주세요");
    await t.drain();
    expect(await submissions(org.id)).toEqual([]);
    expect((await organization(org.id)).stage).toBe("researching");
    expect(agents.of(org.lead.id).at(-1)!.state.sent).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("산출물이 없어"),
      }),
    ]);
  });
});
