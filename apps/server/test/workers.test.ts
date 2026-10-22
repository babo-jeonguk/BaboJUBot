import fs from "node:fs";
import path from "node:path";
import {
  agentInstructionsSchema,
  approvalSchema,
  inboxSchema,
  orgToolNames,
  orgToolPaths,
  organizationDetailSchema,
  type RuntimeAdapter,
  type WakeReason,
} from "@babojubot/contracts";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { idle, reasons, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, say, eventsOf, researching } = serverHelpers(() => t!);

const harnessDir = path.resolve(import.meta.dirname, "../../../harness");
const library = (file: string) =>
  fs.readFileSync(path.join(harnessDir, file), "utf8");

const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));
const workersOf = async (orgId: string) =>
  (await organization(orgId)).agents.filter((a) => a.role === "worker");
const inbox = async () => inboxSchema.parse(await get("/api/inbox"));
const approval = async (orgId: string, approvalId: string) =>
  approvalSchema.parse(
    await get(`/api/organizations/${orgId}/approvals/${approvalId}`)
  );
const instructions = async (orgId: string, agentId: string) =>
  agentInstructionsSchema.parse(
    await get(`/api/organizations/${orgId}/agents/${agentId}/instructions`)
  );
const setPolicy = (orgId: string, body: unknown) =>
  t!.request("PUT", `/api/organizations/${orgId}/approval-policy`, body);
const decide = (orgId: string, approvalId: string, body: unknown) =>
  t!.request(
    "POST",
    `/api/organizations/${orgId}/approvals/${approvalId}/decision`,
    body
  );
const workerDecisions = (runs: { request: { wakeReasons: WakeReason[] } }[]) =>
  reasons(runs).filter(
    (r) => r.kind === "approval_decision" && r.approvalKind === "add_worker"
  );

/** 실행 시도마다 받은 토큰을 에이전트별로 모으는 실행기. */
function capturingTokens(inner: RuntimeAdapter) {
  const tokens = new Map<string, string>();
  const runtime: RuntimeAdapter = {
    execute(request, control) {
      tokens.set(request.identity.agentId, request.access.token);
      return inner.execute(request, control);
    },
  };
  return { runtime, tokenOf: (agentId: string) => tokens.get(agentId)! };
}

/**
 * 연구 진행 중인 조직에서 Lead 실행 시도 하나를 멈춰 두고 그 토큰으로 작업자 추가를 직접 부른다.
 * 실제 조직 도구 HTTP 경로이며, 끝나면 실행 시도를 보내 준다.
 */
async function leadSession(name: string) {
  const agents = scriptedAgents();
  const capture = capturingTokens(agents.runtime);
  t = await startTestServer({ runtime: capture.runtime });
  const org = await researching(agents, name);
  const gate = createGate();
  agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
  await say(org.id, "작업자를 더 둘지 보세요");
  await gate.reached;
  const token = capture.tokenOf(org.lead.id);
  const addWorker = (body: unknown = { role: "researcher" }) =>
    t!.tool(token, "POST", orgToolPaths.add_worker, body);
  /** 멈춰 둔 실행 시도를 끝내고, 그 뒤 깨운 실행 시도까지 모두 처리한다. 다음 Lead 실행 시도는 읽기만 한다. */
  const finish = async () => {
    agents.queue(org.lead.id, idle, idle);
    gate.open();
    await t!.drain();
  };
  return { agents, org, addWorker, finish, capture };
}

describe("add_worker approval policy", () => {
  it("starts every organization with the policy off, so the Lead's call adds a worker with its own library copies right away", async () => {
    const s = await leadSession("정책 꺼짐 조직");
    expect((await organization(s.org.id)).approvalPolicy).toEqual({
      addWorker: false,
    });
    const before = await workersOf(s.org.id);

    const res = await s.addWorker();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "added",
      agent: {
        organizationId: s.org.id,
        role: "worker",
        name: "연구원 3",
      },
    });
    const added = res.body.agent.id as string;
    await s.finish();

    expect((await workersOf(s.org.id)).map((w) => w.id)).toEqual([
      ...before.map((w) => w.id),
      added,
    ]);
    const mine = await instructions(s.org.id, added);
    expect(mine.copies.map((c) => c.path)).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "skills/record-research-node/SKILL.md",
    ]);
    for (const copy of mine.copies)
      expect(copy.content).toBe(library(copy.source));
    const theirs = await instructions(s.org.id, before[0]!.id);
    expect(mine.bundleVersion).toBe(theirs.bundleVersion);
    const ids = new Set(theirs.copies.map((c) => c.id));
    expect(mine.copies.some((c) => ids.has(c.id))).toBe(false);

    const events = await eventsOf(s.org.id);
    expect(events.find((e) => e.type === "worker.added")?.payload).toEqual({
      runId: expect.any(String),
      agentId: s.org.lead.id,
      workerAgentId: added,
      role: "researcher",
    });
    expect(
      events.filter(
        (e) =>
          e.type === "approval.requested" && e.payload.kind === "add_worker"
      )
    ).toEqual([]);
    expect(await inbox()).toEqual([]);
  });

  it("with the policy on, files an approval request instead and creates the worker only when the owner approves, waking the Lead", async () => {
    const s = await leadSession("정책 켜짐 조직");
    expect((await setPolicy(s.org.id, { addWorker: true })).status).toBe(200);
    const before = await workersOf(s.org.id);

    const res = await s.addWorker();
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "pending_approval",
      approval: {
        organizationId: s.org.id,
        kind: "add_worker",
        status: "pending",
        requestedByAgentId: s.org.lead.id,
      },
    });
    const approvalId = res.body.approval.id as string;
    await s.finish();

    expect(await workersOf(s.org.id)).toEqual(before);
    const org = await organization(s.org.id);
    expect(org.stage).toBe("researching");
    const pending = await approval(s.org.id, approvalId);
    expect(pending).toMatchObject({
      kind: "add_worker",
      proposal: { role: "researcher", label: "연구원" },
    });
    expect(
      (await inbox()).map((i) => i.kind === "approval" && i.approval.id)
    ).toEqual([approvalId]);

    const decided = await decide(s.org.id, approvalId, { decision: "approve" });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: "approved" });
    await t!.drain();

    const after = await workersOf(s.org.id);
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((w) => !before.some((b) => b.id === w.id))!;
    expect(added.name).toBe("연구원 3");
    expect(
      (await instructions(s.org.id, added.id)).copies.map((c) => c.content)
    ).toEqual(
      pending.kind === "add_worker"
        ? pending.proposal.files.map((f) => f.content)
        : []
    );
    expect((await organization(s.org.id)).stage).toBe("researching");
    expect(workerDecisions(s.agents.of(s.org.lead.id))).toEqual([
      expect.objectContaining({
        approvalId,
        decision: "approve",
        note: null,
      }),
    ]);
    const decidedEvent = (await eventsOf(s.org.id)).find(
      (e) =>
        e.type === "approval.decided" && e.payload.approvalId === approvalId
    );
    expect(decidedEvent?.payload).toMatchObject({
      kind: "add_worker",
      decision: "approve",
      stage: "researching",
      createdAgentIds: [added.id],
      wokenAgentId: s.org.lead.id,
    });
    expect(await inbox()).toEqual([]);
  });

  it("rejecting creates no worker and wakes the Lead with the reason; a worker addition has no change request", async () => {
    const s = await leadSession("반려 조직");
    await setPolicy(s.org.id, { addWorker: true });
    const before = await workersOf(s.org.id);
    const res = await s.addWorker();
    const approvalId = res.body.approval.id as string;
    await s.finish();

    const changes = await decide(s.org.id, approvalId, {
      decision: "request_changes",
      note: "다른 Role로",
    });
    expect(changes.status).toBe(422);
    expect(changes.body).toMatchObject({
      error: { code: "decision_not_allowed" },
    });
    expect(
      (await decide(s.org.id, approvalId, { decision: "reject" })).status
    ).toBe(422);

    const rejected = await decide(s.org.id, approvalId, {
      decision: "reject",
      note: "지금은 인원이 충분합니다",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: "rejected",
      decisionNote: "지금은 인원이 충분합니다",
    });
    await t!.drain();

    expect(await workersOf(s.org.id)).toEqual(before);
    expect((await organization(s.org.id)).stage).toBe("researching");
    expect(workerDecisions(s.agents.of(s.org.lead.id))).toEqual([
      expect.objectContaining({
        approvalId,
        decision: "reject",
        note: "지금은 인원이 충분합니다",
      }),
    ]);
    expect(
      (await decide(s.org.id, approvalId, { decision: "approve" })).status
    ).toBe(409);
    expect(await workersOf(s.org.id)).toEqual(before);
  });

  it("still decides a waiting request after the research stage has moved on, keeping that stage", async () => {
    const s = await leadSession("단계 이동 조직");
    await setPolicy(s.org.id, { addWorker: true });
    const before = await workersOf(s.org.id);
    const approvalId = (await s.addWorker()).body.approval.id as string;
    // 요청이 기다리는 사이 Lead가 결과를 제출해 결과 검토 중이 된다.
    const lead = s.capture.tokenOf(s.org.lead.id);
    const task = await t!.tool(lead, "POST", orgToolPaths.create_task, {
      title: "정리",
      assigneeAgentId: s.org.lead.id,
    });
    const artifact = await t!.tool(lead, "POST", orgToolPaths.record_artifact, {
      taskId: task.body.id,
      title: "메모",
      format: "markdown",
      content: "# 메모",
    });
    const submitted = await t!.tool(lead, "POST", orgToolPaths.submit_result, {
      summary: "정리했다",
      artifactIds: [artifact.body.id],
    });
    expect(submitted.status).toBe(201);
    await s.finish();
    expect((await organization(s.org.id)).stage).toBe("result_review");

    const decided = await decide(s.org.id, approvalId, { decision: "approve" });
    expect(decided.status).toBe(200);
    await t!.drain();
    expect(await workersOf(s.org.id)).toHaveLength(before.length + 1);
    expect((await organization(s.org.id)).stage).toBe("result_review");
    expect(workerDecisions(s.agents.of(s.org.lead.id))).toEqual([
      expect.objectContaining({ approvalId, decision: "approve" }),
    ]);
  });

  it("decides a waiting request while the organization is paused without resuming it, and the Lead hears it after the resume", async () => {
    const s = await leadSession("일시정지 중 작업자 결정");
    await setPolicy(s.org.id, { addWorker: true });
    const before = await workersOf(s.org.id);
    const approvalId = (await s.addWorker()).body.approval.id as string;
    await s.finish();
    expect(
      (await t!.request("POST", `/api/organizations/${s.org.id}/pause`, {}))
        .status
    ).toBe(200);

    const decided = await decide(s.org.id, approvalId, { decision: "approve" });
    expect(decided.status).toBe(200);
    await t!.drain();
    expect(await workersOf(s.org.id)).toHaveLength(before.length + 1);
    expect(await organization(s.org.id)).toMatchObject({
      stage: "paused",
      pausedFrom: "researching",
    });
    expect(
      (await eventsOf(s.org.id)).filter(
        (e) => e.type === "organization.resumed"
      )
    ).toEqual([]);
    expect(workerDecisions(s.agents.of(s.org.lead.id))).toEqual([]);

    await t!.request("POST", `/api/organizations/${s.org.id}/resume`, {});
    await t!.drain();
    expect(workerDecisions(s.agents.of(s.org.lead.id))).toEqual([
      expect.objectContaining({ approvalId, decision: "approve" }),
    ]);
  });

  it("keeps each call a separate request, and leaves waiting requests in place when the policy is turned off", async () => {
    const s = await leadSession("여러 요청 조직");
    await setPolicy(s.org.id, { addWorker: true });
    const first = await s.addWorker();
    const second = await s.addWorker();
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.body.approval.id).not.toBe(second.body.approval.id);

    expect((await setPolicy(s.org.id, { addWorker: false })).status).toBe(200);
    const third = await s.addWorker();
    expect(third.status).toBe(201);
    await s.finish();

    expect(
      (await inbox()).map((i) => i.kind === "approval" && i.approval.id)
    ).toEqual([first.body.approval.id, second.body.approval.id]);
    for (const id of [first.body.approval.id, second.body.approval.id])
      expect((await decide(s.org.id, id, { decision: "approve" })).status).toBe(
        200
      );
    await t!.drain();
    expect((await workersOf(s.org.id)).map((w) => w.name)).toEqual([
      "연구원 1",
      "연구원 2",
      "연구원 3",
      "연구원 4",
      "연구원 5",
    ]);
  });

  it("applies one of several concurrent decisions once, creating at most one worker and one Lead wake", async () => {
    const s = await leadSession("동시 결정 조직");
    await setPolicy(s.org.id, { addWorker: true });
    const before = await workersOf(s.org.id);
    const approvalId = (await s.addWorker()).body.approval.id as string;
    await s.finish();

    const results = await Promise.all([
      decide(s.org.id, approvalId, { decision: "approve" }),
      decide(s.org.id, approvalId, { decision: "reject", note: "아니오" }),
      decide(s.org.id, approvalId, { decision: "approve" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    await t!.drain();
    const winner = approvalSchema.parse(
      results.find((r) => r.status === 200)!.body
    );
    expect(await workersOf(s.org.id)).toHaveLength(
      before.length + (winner.status === "approved" ? 1 : 0)
    );
    expect(workerDecisions(s.agents.of(s.org.lead.id))).toHaveLength(1);
    expect(
      (await eventsOf(s.org.id)).filter((e) => e.type === "approval.decided")
    ).toHaveLength(2); // 초기 연구 승인 하나와 이 요청 하나
  });

  it("decides each call by the policy at the moment it is stored, even when a policy change races it", async () => {
    const s = await leadSession("정책 경합 조직");
    const results = await Promise.all([
      s.addWorker(),
      setPolicy(s.org.id, { addWorker: true }),
      s.addWorker(),
    ]);
    await s.finish();
    const [first, , last] = results;
    // 정책 Event 앞에 저장된 호출은 곧바로, 뒤에 저장된 호출은 승인 요청이 된다.
    const events = await eventsOf(s.org.id);
    const changedAt = events.find(
      (e) => e.type === "organization.approval_policy_changed"
    )!.id;
    for (const res of [first!, last!]) {
      const id =
        res.body.status === "added" ? res.body.agent.id : res.body.approval.id;
      const event = events.find((e) =>
        e.type === "worker.added"
          ? e.payload.workerAgentId === id
          : e.type === "approval.requested" && e.payload.approvalId === id
      )!;
      expect(res.status).toBe(event.id < changedAt ? 201 : 202);
      expect(event.type).toBe(
        event.id < changedAt ? "worker.added" : "approval.requested"
      );
    }
  });

  it("changes the policy only by the owner's control command, recording each change as an Event", async () => {
    const s = await leadSession("정책 변경 조직");
    const stream = await t!.subscribe({
      kind: "organization",
      organizationId: s.org.id,
    });

    // 정책을 바꾸는 조직 도구는 없다. 도구 입력으로 정책을 실어 보내도 받지 않는다.
    expect(orgToolNames.some((name) => /polic/.test(name))).toBe(false);
    const lead = s.capture.tokenOf(s.org.lead.id);
    for (const method of ["GET", "PUT", "POST", "PATCH"])
      expect(
        (
          await t!.tool(
            lead,
            method,
            "/approval-policy",
            method === "GET" ? undefined : { addWorker: true }
          )
        ).status
      ).toBe(404);
    expect(
      (await s.addWorker({ role: "researcher", addWorker: true })).status
    ).toBe(422);
    expect(
      (await s.addWorker({ role: "researcher", organizationId: s.org.id }))
        .status
    ).toBe(422);

    expect((await setPolicy(s.org.id, { addWorker: "yes" })).status).toBe(422);
    expect(
      (await setPolicy(s.org.id, { addWorker: true, other: true })).status
    ).toBe(422);
    expect(
      (
        await setPolicy("00000000-0000-4000-8000-000000000000", {
          addWorker: true,
        })
      ).status
    ).toBe(404);
    expect((await organization(s.org.id)).approvalPolicy).toEqual({
      addWorker: false,
    });

    const on = await setPolicy(s.org.id, { addWorker: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({
      id: s.org.id,
      approvalPolicy: { addWorker: true },
    });
    const changed = await stream.next();
    expect(changed).toMatchObject({
      organizationId: s.org.id,
      type: "organization.approval_policy_changed",
      payload: {
        by: "owner",
        previous: { addWorker: false },
        policy: { addWorker: true },
      },
    });
    // 같은 값은 아무것도 남기지 않는다.
    expect((await setPolicy(s.org.id, { addWorker: true })).status).toBe(200);
    await s.finish();
    const policyEvents = (await eventsOf(s.org.id)).filter(
      (e) => e.type === "organization.approval_policy_changed"
    );
    expect(policyEvents).toHaveLength(1);
  });

  it("keeps the policy and worker approvals inside their organization", async () => {
    const s = await leadSession("경계 조직 A");
    const other = organizationDetailSchema.parse(
      (await t!.request("POST", "/api/organizations", { name: "경계 조직 B" }))
        .body
    );
    await setPolicy(s.org.id, { addWorker: true });
    expect((await organization(other.id)).approvalPolicy).toEqual({
      addWorker: false,
    });
    const res = await s.addWorker();
    const approvalId = res.body.approval.id as string;
    await s.finish();

    expect(
      (await decide(other.id, approvalId, { decision: "approve" })).status
    ).toBe(404);
    expect(
      (
        await t!.request(
          "GET",
          `/api/organizations/${other.id}/approvals/${approvalId}`
        )
      ).status
    ).toBe(404);
    expect((await organization(other.id)).agents).toHaveLength(1);
    expect((await eventsOf(other.id)).map((e) => e.type)).toEqual([
      "organization.created",
    ]);
  });

  it("lets the demo Lead add a worker when the owner asks, following the policy", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "데모 작업자 추가");
    const before = await workersOf(org.id);
    await say(org.id, "작업자 추가: researcher");
    await t.drain();
    expect(await workersOf(org.id)).toHaveLength(before.length + 1);

    await setPolicy(org.id, { addWorker: true });
    await say(org.id, "작업자 추가: researcher");
    await t.drain();
    expect(await workersOf(org.id)).toHaveLength(before.length + 1);
    const [item] = await inbox();
    expect(item).toMatchObject({
      kind: "approval",
      approval: { kind: "add_worker", organizationId: org.id },
    });
    const replies = (await get(`/api/organizations/${org.id}/messages`)).filter(
      (m: { author: string }) => m.author === "agent"
    );
    expect(replies.at(-1).body).toContain("승인을 요청했습니다");
  });
});
