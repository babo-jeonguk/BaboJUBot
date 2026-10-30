import {
  eventListSchema,
  organizationDetailSchema,
} from "@babojubot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t?.close();
});

const goal = "음성 인식 오류율을 절반으로 줄인다";
const create = async (
  name: string,
  input: { goal?: string; completionCriteria?: string } = {}
) => {
  const res = await t.request("POST", "/api/organizations", {
    name,
    goal,
    ...input,
  });
  expect(res.status).toBe(201);
  return organizationDetailSchema.parse(res.body);
};

describe("creating an organization", () => {
  it("starts in planning with the owner's goal and criteria and exactly one Research Lead", async () => {
    const created = await create("  음성 인식 오류 분석 ", {
      goal: `  ${goal}\n`,
      completionCriteria: " 공개 평가셋 WER 10% 이하 ",
    });

    expect(created.stage).toBe("planning");
    // 생성으로 깨어난 Lead가 초기 연구 승인을 요청하면 승인 대기로 넘어간다. 사용자의 목표·기준은 그대로다.
    await t.drain();
    const res = await t.request("GET", `/api/organizations/${created.id}`);
    expect(res.status).toBe(200);
    const org = organizationDetailSchema.parse(res.body);
    expect(org).toMatchObject({
      id: created.id,
      name: "음성 인식 오류 분석",
      goal,
      completionCriteria: "공개 평가셋 WER 10% 이하",
    });
    expect(org.agents).toHaveLength(1);
    expect(org.agents[0]).toMatchObject({
      role: "lead",
      organizationId: created.id,
    });

    const list = await t.request("GET", "/api/organizations");
    expect(list.body).toContainEqual({
      id: org.id,
      name: org.name,
      stage: "awaiting_approval",
      goal,
      completionCriteria: "공개 평가셋 WER 10% 이하",
      approvalPolicy: { addWorker: false, publishToGitHub: false },
      pausedFrom: null,
      createdAt: org.createdAt,
    });
  });

  it("leaves the completion criteria unset when the owner leaves them empty", async () => {
    for (const input of [{}, { completionCriteria: "   " }]) {
      const created = await create("기준 없는 조직", input);
      expect(created).toMatchObject({
        stage: "planning",
        goal,
        completionCriteria: null,
      });
    }
    await t.drain();
  });

  it("publishes an Event with the owner's goal and wakes the Lead, which drafts the initial research request", async () => {
    const all = await t.subscribe({ kind: "all" });

    const org = await create("조직 이벤트");
    const lead = org.agents[0]!;

    const event = await all.next();
    expect(event).toMatchObject({
      organizationId: org.id,
      type: "organization.created",
      payload: {
        name: "조직 이벤트",
        stage: "planning",
        leadAgentId: lead.id,
        goal,
        completionCriteria: null,
        wokenAgentId: lead.id,
      },
    });
    await t.drain();
    const log = eventListSchema.parse(
      (await t.request("GET", `/api/organizations/${org.id}/events`)).body
    );
    expect(log[0]).toEqual(event);
    const started = log.find((e) => e.type === "run.started");
    expect(started).toMatchObject({ payload: { agentId: lead.id } });
    expect(log.map((e) => e.type)).toContain("approval.requested");
    const runs = (await t.request("GET", `/api/organizations/${org.id}/runs`))
      .body as { wakeReasons?: unknown }[];
    expect(runs).toHaveLength(1);
    all.close();
  });

  it("rejects input other than a name, a goal and completion criteria and writes nothing", async () => {
    const all = await t.subscribe({ kind: "all" });
    const before = (await t.request("GET", "/api/organizations")).body.length;

    for (const body of [
      { name: "   ", goal },
      { name: "x" },
      { name: "x", goal: "  " },
      { name: "x", goal, stage: "researching" },
      { name: "x", goal, id: crypto.randomUUID() },
      {},
    ]) {
      const res = await t.request("POST", "/api/organizations", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(
      (await t.request("POST", "/api/organizations", "{not json")).status
    ).toBe(400);

    expect((await t.request("GET", "/api/organizations")).body).toHaveLength(
      before
    );
    await all.expectNoEvents();
    all.close();
  });

  it("answers 404 for an unknown organization", async () => {
    expect(
      (await t.request("GET", `/api/organizations/${crypto.randomUUID()}`))
        .status
    ).toBe(404);
    expect((await t.request("GET", "/api/organizations/nope")).status).toBe(
      404
    );
    expect(
      (
        await t.request(
          "GET",
          `/api/organizations/${crypto.randomUUID()}/events`
        )
      ).status
    ).toBe(404);
  });
});

describe("Event stream scopes", () => {
  it("delivers an organization's Events only to its own and the all-organizations subscribers", async () => {
    const a = await create("조직 A");
    const b = await create("조직 B");
    // 생성으로 깨어난 Lead의 실행 시도가 남긴 Event가 아래 구독에 섞이지 않게 끝까지 기다린다.
    await t.drain();
    const all = await t.subscribe({ kind: "all" });
    const onlyA = await t.subscribe({
      kind: "organization",
      organizationId: a.id,
    });
    const onlyB = await t.subscribe({
      kind: "organization",
      organizationId: b.id,
    });

    const c = await create("조직 C");

    expect((await all.next()).organizationId).toBe(c.id);
    await t.drain();
    expect(all.events.every((e) => e.organizationId === c.id)).toBe(true);
    await onlyA.expectNoEvents();
    await onlyB.expectNoEvents();
    for (const s of [all, onlyA, onlyB]) s.close();
  });

  it("refuses to subscribe to an unknown organization", async () => {
    await expect(
      t.subscribe({ kind: "organization", organizationId: crypto.randomUUID() })
    ).rejects.toThrow(/404/);
    await expect(
      t.subscribe({ kind: "organization", organizationId: "nope" })
    ).rejects.toThrow(/404/);
  });

  it("refuses browser connections from another origin", async () => {
    await expect(
      t.subscribe({ kind: "all" }, { origin: "http://evil.example" })
    ).rejects.toThrow(/403/);
    const sameOrigin = await t.subscribe(
      { kind: "all" },
      { origin: t.baseUrl }
    );
    sameOrigin.close();
  });
});
