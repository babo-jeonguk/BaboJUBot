import { organizationDetailSchema } from "@babojubot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t?.close();
});

const create = async (name: string) => {
  const res = await t.request("POST", "/api/organizations", { name });
  expect(res.status).toBe(201);
  return organizationDetailSchema.parse(res.body);
};

describe("creating an organization", () => {
  it("starts in goal setting with exactly one Research Lead", async () => {
    const created = await create("  음성 인식 오류 분석 ");

    const res = await t.request("GET", `/api/organizations/${created.id}`);
    expect(res.status).toBe(200);
    const org = organizationDetailSchema.parse(res.body);
    expect(org).toMatchObject({
      id: created.id,
      name: "음성 인식 오류 분석",
      stage: "goal_setting",
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
      stage: "goal_setting",
      createdAt: org.createdAt,
    });
  });

  it("publishes an Event carrying the organization ID", async () => {
    const all = await t.subscribe({ kind: "all" });

    const org = await create("조직 이벤트");

    const event = await all.next();
    expect(event).toMatchObject({
      organizationId: org.id,
      type: "organization.created",
      payload: {
        name: "조직 이벤트",
        stage: "goal_setting",
        leadAgentId: org.agents[0]!.id,
      },
    });
    const log = await t.request("GET", `/api/organizations/${org.id}/events`);
    expect(log.body).toEqual([event]);
    all.close();
  });

  it("rejects input other than a name and writes nothing", async () => {
    const all = await t.subscribe({ kind: "all" });
    const before = (await t.request("GET", "/api/organizations")).body.length;

    for (const body of [
      { name: "   " },
      { name: "x", stage: "researching" },
      { name: "x", id: crypto.randomUUID() },
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
});
