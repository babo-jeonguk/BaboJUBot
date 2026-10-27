import fs from "node:fs";
import path from "node:path";
import {
  agentInstructionsSchema,
  approvalSchema,
  approvalSummaryListSchema,
  eventListSchema,
  flowTemplateCopySchema,
  inboxSchema,
  needsAttention,
  organizationDetailSchema,
  runDetailSchema,
  runSummaryListSchema,
  type RequestInitialApprovalInput,
  type RunRequest,
} from "@babojubot/contracts";
import {
  createScriptedRuntime,
  leadReplyScript,
  type Script,
  type ScriptState,
} from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const harnessDir = path.resolve(import.meta.dirname, "../../../harness");
const library = (file: string) =>
  fs.readFileSync(path.join(harnessDir, file), "utf8");

const goal = {
  goal: "음성 인식 오류율을 절반으로 줄인다",
  completionCriteria: "공개 평가셋 WER 10% 이하",
};
const proposal: RequestInitialApprovalInput = {
  plan: "# 계획\n오류 유형을 분류하고 가설별로 검증한다.",
  environment: "# 연구 환경\n로컬 GPU 1장, 공개 평가셋",
  team: [{ role: "researcher", count: 2 }],
  template: "basic-research",
};

/** Lead가 목표를 기록하고 곧바로 초기 연구 승인을 요청하는 시나리오. */
const proposeScript: Script = {
  steps: [
    { do: "call", tool: "record_goal", input: () => goal },
    { do: "call", tool: "request_initial_approval", input: () => proposal },
  ],
};

/**
 * Lead 실행 시도마다 앞에서부터 시나리오를 하나씩 쓰고, 다 쓰면 기본 답장 시나리오를 쓰는 가짜 실행기.
 * 받은 요청과 시나리오 상태를 기록한다.
 */
function leadRuns(...scripts: Script[]) {
  const requests: RunRequest[] = [];
  const states: ScriptState[] = [];
  const queue = [...scripts];
  const keep = (script: Script): Script => ({
    ...script,
    summary: (state) => {
      states.push(state);
      return script.summary?.(state) ?? "끝";
    },
  });
  const inner = createScriptedRuntime({
    select: () => keep(queue.shift() ?? leadReplyScript),
  });
  return {
    requests,
    states,
    runtime: {
      execute: (
        request: RunRequest,
        control: Parameters<typeof inner.execute>[1]
      ) => {
        requests.push(request);
        return inner.execute(request, control);
      },
    },
  };
}

async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name });
  expect(res.status).toBe(201);
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}
const get = async (path: string) => {
  const res = await t!.request("GET", path);
  expect(res.status, path).toBe(200);
  return res.body;
};
const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));
const approvals = async (orgId: string) =>
  approvalSummaryListSchema.parse(
    await get(`/api/organizations/${orgId}/approvals`)
  );
const approval = async (orgId: string, approvalId: string) =>
  approvalSchema.parse(
    await get(`/api/organizations/${orgId}/approvals/${approvalId}`)
  );
const instructions = async (orgId: string, agentId: string) =>
  agentInstructionsSchema.parse(
    await get(`/api/organizations/${orgId}/agents/${agentId}/instructions`)
  );
const events = async (orgId: string) =>
  eventListSchema.parse(await get(`/api/organizations/${orgId}/events`));
const decide = (
  orgId: string,
  approvalId: string,
  body: Record<string, unknown>
) =>
  t!.request(
    "POST",
    `/api/organizations/${orgId}/approvals/${approvalId}/decision`,
    body
  );
const say = async (orgId: string, body: string) => {
  const res = await t!.request("POST", `/api/organizations/${orgId}/messages`, {
    body,
  });
  expect(res.status).toBe(201);
};

/** 새 조직의 Lead가 목표를 기록하고 초기 연구 승인을 요청한 상태까지. */
async function awaitingApproval(name: string) {
  const org = await createOrganization(name);
  await say(org.id, "목표를 정했어요");
  await t!.drain();
  const [pending] = await approvals(org.id);
  expect(pending).toMatchObject({ status: "pending" });
  return { org, approvalId: pending!.id };
}

describe("goal and initial research approval", () => {
  it("approving starts research with the proposed workers, their own library copies, the organization's template copy and a woken Lead", async () => {
    const lead = leadRuns(proposeScript);
    t = await startTestServer({ runtime: lead.runtime });
    const org = await createOrganization("승인 조직");
    await say(org.id, "목표: …");
    await t.drain();

    expect(await organization(org.id)).toMatchObject({
      stage: "awaiting_approval",
      ...goal,
    });
    const [summary] = await approvals(org.id);
    const requested = await approval(org.id, summary!.id);
    expect(requested).toMatchObject({
      kind: "initial_research",
      status: "pending",
      requestedByAgentId: org.lead.id,
      previousApprovalId: null,
      decisionNote: null,
      proposal: {
        ...goal,
        plan: proposal.plan,
        environment: proposal.environment,
        template: {
          name: "basic-research",
          source: "templates/basic-research/template.json",
        },
      },
    });
    if (requested.kind !== "initial_research") throw new Error(requested.kind);
    expect(requested.proposal.team).toEqual([
      expect.objectContaining({
        role: "researcher",
        label: "연구원",
        count: 2,
      }),
    ]);
    expect(
      inboxSchema
        .parse(await get("/api/inbox"))
        .map((i) => i.kind === "approval" && i.approval.id)
    ).toEqual([summary!.id]);

    const res = await decide(org.id, summary!.id, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(approvalSchema.parse(res.body)).toMatchObject({
      status: "approved",
      decidedAt: expect.any(String),
    });
    await t.drain();

    const after = await organization(org.id);
    expect(after.stage).toBe("researching");
    const workers = after.agents.filter((a) => a.role === "worker");
    expect(workers.map((w) => w.name)).toEqual(["연구원 1", "연구원 2"]);

    const libraryFiles = [
      ["AGENTS.md", "roles/researcher/AGENTS.md", "role"],
      ["SOUL.md", "roles/researcher/SOUL.md", "soul"],
      [
        "skills/record-research-node/SKILL.md",
        "skills/record-research-node/SKILL.md",
        "skill",
      ],
    ] as const;
    const [first, second] = await Promise.all(
      workers.map((w) => instructions(org.id, w.id))
    );
    for (const [worker, own] of [
      [workers[0]!, first!],
      [workers[1]!, second!],
    ] as const) {
      expect(own.copies.map((c) => [c.path, c.source, c.kind])).toEqual(
        libraryFiles
      );
      for (const copy of own.copies) {
        expect(copy.agentId).toBe(worker.id);
        expect(copy.content).toBe(library(copy.source));
      }
    }
    // 같은 Role의 두 작업자는 같은 내용의 서로 다른 사본을 가진다.
    const ids = [...first!.copies, ...second!.copies].map((c) => c.id);
    expect(new Set(ids).size).toBe(6);
    expect(first!.bundleVersion).toMatch(/^sha256:/);
    expect(first!.bundleVersion).toBe(second!.bundleVersion);

    const template = flowTemplateCopySchema.parse(
      await get(`/api/organizations/${org.id}/flow-template`)
    );
    expect(template).toMatchObject({
      organizationId: org.id,
      approvalId: summary!.id,
      name: "basic-research",
      ...JSON.parse(library("templates/basic-research/template.json")),
    });

    // Lead는 결정 사유로 깨어나 새 실행 시도를 받는다.
    const decisionRun = lead.requests.at(-1)!;
    expect(decisionRun.identity.agentId).toBe(org.lead.id);
    expect(decisionRun.wakeReasons).toEqual([
      expect.objectContaining({
        kind: "approval_decision",
        approvalId: summary!.id,
        decision: "approve",
        note: null,
      }),
    ]);
    expect(decisionRun.context.organization).toMatchObject({
      stage: "researching",
      ...goal,
    });

    // 결정은 제어 명령으로 Event log에 남는다.
    const decided = (await events(org.id)).filter(
      (e) => e.type === "approval.decided"
    );
    expect(decided).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        payload: {
          approvalId: summary!.id,
          kind: "initial_research",
          by: "owner",
          decision: "approve",
          note: null,
          stage: "researching",
          createdAgentIds: workers.map((w) => w.id),
          wokenAgentId: org.lead.id,
        },
      }),
    ]);
    // 결정한 요청은 결정 상태와 함께 Inbox에 남고 주의 필요가 아니다.
    const [kept] = inboxSchema.parse(await get("/api/inbox"));
    expect(kept).toMatchObject({
      kind: "approval",
      read: true,
      archived: false,
      approval: { id: summary!.id, status: "approved" },
    });
    expect(needsAttention(kept!)).toBe(false);
  });

  it("gives a new organization's Lead its own Role and Soul copies from the library and runs it with that bundle", async () => {
    const lead = leadRuns();
    t = await startTestServer({ runtime: lead.runtime });
    const a = await createOrganization("Lead 사본 A");
    const b = await createOrganization("Lead 사본 B");

    const own = await instructions(a.id, a.lead.id);
    expect(own.copies.map((c) => [c.path, c.source, c.kind])).toEqual([
      ["AGENTS.md", "roles/lead/AGENTS.md", "role"],
      ["SOUL.md", "roles/lead/SOUL.md", "soul"],
    ]);
    for (const copy of own.copies)
      expect(copy.content).toBe(library(copy.source));
    const other = await instructions(b.id, b.lead.id);
    expect(other.copies.map((c) => c.id)).not.toContain(own.copies[0]!.id);

    expect(
      await get(`/api/organizations/${a.id}/agents/${a.lead.id}`)
    ).toMatchObject({ instructionsBundleVersion: own.bundleVersion });
    await say(a.id, "안녕");
    await t.drain();
    expect(lead.requests[0]).toMatchObject({
      instructionsBundleVersion: own.bundleVersion,
      instructions: own.copies.map(({ path, content }) => ({ path, content })),
    });
    // 다른 조직의 에이전트 사본은 없는 것과 같다.
    expect(
      (
        await t.request(
          "GET",
          `/api/organizations/${a.id}/agents/${b.lead.id}/instructions`
        )
      ).status
    ).toBe(404);
  });

  it("refuses re-recording the goal, task creation and worker addition while planning, records each refusal and changes nothing", async () => {
    const lead = leadRuns({
      steps: [
        { do: "call", tool: "record_goal", input: () => goal },
        {
          do: "call",
          tool: "record_goal",
          input: () => ({ goal: "다른 목표", completionCriteria: "다른 기준" }),
          allowRefusal: true,
        },
        {
          do: "call",
          tool: "create_task",
          input: () => ({ title: "x" }),
          allowRefusal: true,
        },
        {
          do: "call",
          tool: "add_worker",
          input: () => ({ role: "researcher" }),
          allowRefusal: true,
        },
      ],
    });
    t = await startTestServer({ runtime: lead.runtime });
    const org = await createOrganization("계획 조직");
    await say(org.id, "시작");
    await t.drain();

    expect(lead.states[0]!.calls).toEqual([
      expect.objectContaining({ tool: "record_goal", ok: true }),
      { tool: "record_goal", ok: false, status: 409, code: "stage_closed" },
      { tool: "create_task", ok: false, status: 409, code: "stage_closed" },
      { tool: "add_worker", ok: false, status: 409, code: "stage_closed" },
    ]);
    const after = await organization(org.id);
    // 합의한 목표는 계획 수립에서 다시 기록해도 바뀌지 않는다.
    expect(after).toMatchObject({ stage: "planning", ...goal });
    expect(after.agents).toHaveLength(1);
    const [run] = runSummaryListSchema.parse(
      await get(`/api/organizations/${org.id}/runs`)
    );
    expect(run!.status).toBe("completed");
    const refusals = runDetailSchema
      .parse(await get(`/api/organizations/${org.id}/runs/${run!.id}`))
      .transcript.filter((e) => e.type === "tool.refused");
    expect(refusals.map((e) => e.payload)).toEqual([
      {
        runId: run!.id,
        agentId: org.lead.id,
        tool: "record_goal",
        stage: "planning",
        reason: "stage",
      },
      {
        runId: run!.id,
        agentId: org.lead.id,
        tool: "create_task",
        stage: "planning",
        reason: "stage",
      },
      {
        runId: run!.id,
        agentId: org.lead.id,
        tool: "add_worker",
        stage: "planning",
        reason: "stage",
      },
    ]);
  });

  it.each([
    ["reject", "rejected", "방향이 다릅니다"],
    ["request_changes", "changes_requested", "연구원을 한 명으로 줄여 주세요"],
  ] as const)(
    "%s returns the organization to planning and wakes the Lead with the reason, creating no team",
    async (decision, status, note) => {
      const lead = leadRuns(proposeScript, leadReplyScript, {
        steps: [
          {
            do: "call",
            tool: "request_initial_approval",
            input: () => ({
              ...proposal,
              team: [{ role: "researcher", count: 1 }],
            }),
          },
        ],
      });
      t = await startTestServer({ runtime: lead.runtime });
      const { org, approvalId } = await awaitingApproval("재계획 조직");

      const res = await decide(org.id, approvalId, { decision, note });
      expect(res.status).toBe(200);
      await t.drain();

      const after = await organization(org.id);
      expect(after.stage).toBe("planning");
      expect(after.agents).toHaveLength(1);
      expect(
        (await t.request("GET", `/api/organizations/${org.id}/flow-template`))
          .status
      ).toBe(404);
      expect(lead.requests.at(-1)!.wakeReasons).toEqual([
        expect.objectContaining({
          kind: "approval_decision",
          approvalId,
          decision,
          note,
        }),
      ]);
      expect(
        (await events(org.id)).find((e) => e.type === "approval.decided")
          ?.payload
      ).toMatchObject({
        decision,
        note,
        stage: "planning",
        createdAgentIds: [],
      });

      // 다시 제출하면 새 요청이 직전 요청을 가리키고, 직전 요청의 내용과 결정은 그대로 남는다.
      await say(org.id, "다시 제출해 주세요");
      await t.drain();
      const [resubmitted, previous] = await approvals(org.id);
      expect(resubmitted).toMatchObject({
        status: "pending",
        previousApprovalId: approvalId,
      });
      expect(await approval(org.id, approvalId)).toMatchObject({
        status,
        decisionNote: note,
        proposal: { team: [expect.objectContaining({ count: 2 })] },
      });
      expect(previous!.id).toBe(approvalId);
      expect((await organization(org.id)).stage).toBe("awaiting_approval");
    }
  );

  it("refuses to decide a request twice, applying one of several concurrent decisions once", async () => {
    t = await startTestServer({ runtime: leadRuns(proposeScript).runtime });
    const { org, approvalId } = await awaitingApproval("한 번만 결정");

    const results = await Promise.all([
      decide(org.id, approvalId, { decision: "approve" }),
      decide(org.id, approvalId, { decision: "reject", note: "아니오" }),
      decide(org.id, approvalId, { decision: "request_changes", note: "수정" }),
      decide(org.id, approvalId, { decision: "approve" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    for (const r of results.filter((r) => r.status === 409))
      expect(r.body).toEqual({ error: { code: "already_decided" } });
    await t.drain();

    const winner = approvalSchema.parse(
      results.find((r) => r.status === 200)!.body
    );
    expect(await approval(org.id, approvalId)).toMatchObject({
      status: winner.status,
    });
    const decided = (await events(org.id)).filter(
      (e) => e.type === "approval.decided"
    );
    expect(decided).toHaveLength(1);
    const workers = (await organization(org.id)).agents.filter(
      (a) => a.role === "worker"
    );
    expect(workers).toHaveLength(winner.status === "approved" ? 2 : 0);

    // 같은 결정을 다시 보내도 거부한다.
    const again = await decide(org.id, approvalId, {
      decision: winner.status === "approved" ? "approve" : "reject",
      note: "다시",
    });
    expect(again.status).toBe(409);
  });

  it("has no setting that skips the initial research approval: the request always waits for the owner", async () => {
    const lead = leadRuns(proposeScript, {
      steps: [
        {
          do: "call",
          tool: "create_task",
          input: () => ({ title: "x" }),
          allowRefusal: true,
        },
      ],
    });
    t = await startTestServer({ runtime: lead.runtime });
    const { org } = await awaitingApproval("승인 고정");
    const detail = await organization(org.id);
    expect(Object.keys(detail).sort()).toEqual([
      "agents",
      "approvalPolicy",
      "completionCriteria",
      "createdAt",
      "goal",
      "id",
      "name",
      "pausedFrom",
      "stage",
    ]);
    // 승인 정책의 항목은 선택 행동뿐이고, 초기 연구 승인을 끄는 항목은 없다(ADR-0003).
    expect(Object.keys(detail.approvalPolicy)).toEqual(["addWorker"]);
    expect(
      (
        await t.request("PUT", `/api/organizations/${org.id}/approval-policy`, {
          initialResearch: false,
        })
      ).status
    ).toBe(422);
    // 승인 대기 중에도 작업 도구는 닫혀 있다.
    await say(org.id, "작업을 만들어 볼래?");
    await t.drain();
    expect(lead.states.at(-1)!.calls).toEqual([
      { tool: "create_task", ok: false, status: 409, code: "stage_closed" },
    ]);
    expect((await organization(org.id)).stage).toBe("awaiting_approval");
  });

  it("validates decisions and keeps approvals inside their organization", async () => {
    t = await startTestServer({ runtime: leadRuns(proposeScript).runtime });
    const { org, approvalId } = await awaitingApproval("결정 입력 조직");
    const other = await createOrganization("다른 조직");

    for (const body of [
      { decision: "reject" },
      { decision: "request_changes", note: "   " },
      { decision: "yes" },
      { decision: "approve", organizationId: other.id },
    ])
      expect(
        (await decide(org.id, approvalId, body)).status,
        JSON.stringify(body)
      ).toBe(422);
    for (const [orgId, id] of [
      [other.id, approvalId],
      [org.id, crypto.randomUUID()],
      [org.id, "not-a-uuid"],
    ]) {
      expect((await decide(orgId!, id!, { decision: "approve" })).status).toBe(
        404
      );
      expect(
        (await t.request("GET", `/api/organizations/${orgId}/approvals/${id}`))
          .status
      ).toBe(404);
    }
    expect(await approvals(other.id)).toEqual([]);
    expect((await approval(org.id, approvalId)).status).toBe("pending");
  });
});
