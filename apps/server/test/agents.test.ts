import {
  agentDetailSchema,
  agentNameMaxLength,
  defaultAgentAppearance,
  organizationDetailSchema,
  type AgentAppearance,
} from "@babojubot/contracts";
import { leadReplyScript } from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { calls, goal, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const { get, create, say, researching, eventsOf } = serverHelpers(() => t!);

const agentPath = (orgId: string, agentId: string) =>
  `/api/organizations/${orgId}/agents/${agentId}`;
const patch = (orgId: string, agentId: string, body: unknown) =>
  t!.request("PATCH", agentPath(orgId, agentId), body);
const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));

const owlFace: AgentAppearance = {
  color: "lilac",
  eyes: "sparkle",
  mouth: "grin",
  accessory: "glasses",
};

describe("agent profile", () => {
  it("renames an agent and changes its face, announces it and keeps it organization-scoped", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "이름 조직");
    const other = await researching(agents, "다른 조직");
    const [worker] = org.workers;

    // 고르지 않은 에이전트는 ID에서 정한 기본 얼굴이다.
    expect(
      (await organization(org.id)).agents.find((a) => a.id === worker!.id)
        ?.appearance
    ).toEqual(defaultAgentAppearance(worker!.id));

    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    const renamed = await patch(org.id, worker!.id, {
      name: "  통계 담당  ",
      appearance: owlFace,
    });
    expect(renamed.status).toBe(200);
    expect(agentDetailSchema.parse(renamed.body)).toMatchObject({
      id: worker!.id,
      name: "통계 담당",
      appearance: owlFace,
    });
    expect(await stream.next()).toMatchObject({
      type: "agent.profile_changed",
      organizationId: org.id,
      payload: {
        by: "owner",
        agentId: worker!.id,
        name: { from: worker!.name, to: "통계 담당" },
        appearance: owlFace,
      },
    });
    stream.close();

    // 저장된 이름·얼굴은 조직 상세에도 보이고, 다른 조직의 에이전트는 그대로다.
    const after = await organization(org.id);
    expect(after.agents.find((a) => a.id === worker!.id)).toMatchObject({
      name: "통계 담당",
      appearance: owlFace,
    });
    expect((await organization(other.id)).agents.map((a) => a.name)).toEqual([
      other.lead.name,
      ...other.workers.map((w) => w.name),
    ]);

    // 같은 값이면 아무것도 남기지 않는다.
    const before = (await eventsOf(org.id)).length;
    const same = await patch(org.id, worker!.id, { name: "통계 담당" });
    expect(same.status).toBe(200);
    expect(await eventsOf(org.id)).toHaveLength(before);

    // 다음 실행 시도의 팀 맥락에는 바꾼 이름이 간다.
    agents.queue(org.lead.id, leadReplyScript);
    await say(org.id, "팀 상황은 어때요?");
    await t.drain();
    const [lastRun] = agents.of(org.lead.id).slice(-1);
    expect(
      lastRun!.request.context.team.find((m) => m.id === worker!.id)?.name
    ).toBe("통계 담당");
  });

  it("answers 404 for an agent outside the organization and 409 for a name already in the team", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "경계 조직");
    const other = await researching(agents, "남의 조직");
    const [worker] = org.workers;

    expect(
      (await patch(org.id, other.workers[0]!.id, { name: "가로채기" })).status
    ).toBe(404);
    expect(
      (
        await patch(org.id, "00000000-0000-4000-8000-000000000000", {
          name: "없음",
        })
      ).status
    ).toBe(404);
    expect((await patch("not-a-uuid", worker!.id, { name: "x" })).status).toBe(
      404
    );
    expect(
      (await organization(other.id)).agents.find(
        (a) => a.id === other.workers[0]!.id
      )?.name
    ).toBe(other.workers[0]!.name);

    // 같은 조직의 다른 이름은 대소문자만 달라도 겹친다. 다른 조직의 이름은 상관없다.
    const taken = await patch(org.id, worker!.id, {
      name: org.lead.name.toUpperCase(),
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: { code: "name_taken" } });
    expect(
      (await patch(org.id, worker!.id, { name: other.workers[0]!.name })).status
    ).toBe(200);
  });

  it("names new workers apart from every agent in the organization, even after a rename", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const created = await create("이름 겹침 조직");
    const lead = created.agents[0]!;
    // 팀 승인 전에 Lead가 작업자 이름 모양을 가져도 새 팀은 그 이름을 피한다.
    expect(
      (await patch(created.id, lead.id, { name: "연구원 1" })).status
    ).toBe(200);
    agents.queue(
      lead.id,
      calls(),
      calls({ tool: "add_worker", input: { role: "researcher" } })
    );
    const [approval] = await get(`/api/organizations/${created.id}/approvals`);
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${created.id}/approvals/${approval.id}/decision`,
          { decision: "approve" }
        )
      ).status
    ).toBe(200);
    await t.drain();
    expect((await organization(created.id)).agents.map((a) => a.name)).toEqual([
      "연구원 1",
      "연구원 2",
      "연구원 3",
    ]);

    // 작업자 이름을 Lead가 다음에 받을 번호로 바꿔 두어도 작업자 추가는 그 이름을 피한다.
    const [, second] = (await organization(created.id)).agents;
    expect(
      (await patch(created.id, second!.id, { name: "연구원 4" })).status
    ).toBe(200);
    await say(created.id, "작업자를 하나 더 두세요");
    await t.drain();
    const names = (await organization(created.id)).agents.map((a) => a.name);
    expect(names).toEqual(["연구원 1", "연구원 4", "연구원 3", "연구원 5"]);
  });

  it("refuses invalid names and faces with 422", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const res = await t.request("POST", "/api/organizations", {
      name: "검증 조직",
      ...goal,
    });
    const org = organizationDetailSchema.parse(res.body);
    const lead = org.agents[0]!;
    for (const body of [
      {},
      { name: "   " },
      { name: "가".repeat(agentNameMaxLength + 1) },
      { name: "두 줄\n이름" },
      { name: 3 },
      { appearance: { ...owlFace, color: "neon" } },
      { appearance: { ...owlFace, hat: "top" } },
      { name: "Lead", role: "worker" },
    ]) {
      const refused = await patch(org.id, lead.id, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(refused.body).toMatchObject({ error: { code: "invalid_input" } });
    }
    expect((await organization(org.id)).agents[0]!.name).toBe(lead.name);
    expect(
      (await patch(org.id, lead.id, { name: "가".repeat(agentNameMaxLength) }))
        .status
    ).toBe(200);
  });
});
