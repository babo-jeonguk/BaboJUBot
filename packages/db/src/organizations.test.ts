import { randomUUID } from "node:crypto";
import { planOrganizationCreation } from "@babojubot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findOrganization,
  insertOrganizationCreation,
  listOrganizationEvents,
  listOrganizations,
} from "./organizations.ts";
import { migrateDatabase } from "./client.ts";
import { findAgentInstructions } from "./harness.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";
import { agents, organizations } from "./schema.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.close();
});

const plan = (name: string) =>
  planOrganizationCreation(
    { name },
    { files: leadFiles },
    {
      newId: randomUUID,
      now: () => new Date(),
    }
  );
const leadFiles = ["AGENTS.md", "SOUL.md"].map((path) => ({
  path,
  content: `${path} 내용`,
  source: `roles/lead/${path}`,
  sourceDigest: "d",
}));

describe("organization records", () => {
  it("re-running migrations is a no-op", async () => {
    await expect(migrateDatabase(t.db)).resolves.toBeUndefined();
  });

  it("stores the organization, its Lead and the Event together", async () => {
    const creation = plan("조직 A");
    const event = await insertOrganizationCreation(t.db, creation);

    expect(event).toMatchObject({
      organizationId: creation.organization.id,
      type: "organization.created",
    });
    expect(event.id).toBeGreaterThan(0);
    const detail = await findOrganization(t.db, creation.organization.id);
    expect(detail).toMatchObject({
      id: creation.organization.id,
      name: "조직 A",
      stage: "goal_setting",
    });
    expect(detail?.agents.map((a) => a.role)).toEqual(["lead"]);
    expect(
      await listOrganizationEvents(t.db, creation.organization.id)
    ).toEqual([event]);
    expect((await listOrganizations(t.db)).map((o) => o.id)).toContain(
      creation.organization.id
    );
  });

  it("rolls everything back when one write fails", async () => {
    const creation = plan("조직 B");
    // A second Lead in the same organization violates the one-Lead constraint.
    const lead = creation.agents[0]!;
    const broken = {
      ...creation,
      agents: [lead, { ...lead, id: randomUUID() }],
    };

    await expect(insertOrganizationCreation(t.db, broken)).rejects.toThrow();
    expect(
      await findOrganization(t.db, creation.organization.id)
    ).toBeUndefined();
    expect(
      await listOrganizationEvents(t.db, creation.organization.id)
    ).toEqual([]);
  });

  it("stores the Lead's own instruction copies with the organization or not at all", async () => {
    const creation = plan("조직 사본");
    const [role] = creation.instructionCopies;
    // 같은 에이전트의 같은 경로 사본은 둘일 수 없다.
    const broken = {
      ...creation,
      instructionCopies: [role!, { ...role!, id: randomUUID() }],
    };
    await expect(insertOrganizationCreation(t.db, broken)).rejects.toThrow();
    expect(
      await findOrganization(t.db, creation.organization.id)
    ).toBeUndefined();

    await insertOrganizationCreation(t.db, creation);
    const lead = creation.agents[0]!;
    expect(
      await findAgentInstructions(t.db, creation.organization.id, lead.id)
    ).toMatchObject({
      agentId: lead.id,
      bundleVersion: expect.stringMatching(/^sha256:/),
      copies: [
        { path: "AGENTS.md", kind: "role", source: "roles/lead/AGENTS.md" },
        { path: "SOUL.md", kind: "soul" },
      ],
    });
  });

  it("refuses a second Lead for an existing organization", async () => {
    const creation = plan("조직 C");
    await insertOrganizationCreation(t.db, creation);
    const lead = creation.agents[0]!;
    await expect(
      t.db
        .insert(agents)
        .values({ ...lead, id: randomUUID(), createdAt: new Date() })
    ).rejects.toThrow();
  });

  it("rejects a stage outside the lifecycle", async () => {
    const { organization } = plan("조직 D");
    await expect(
      t.db.insert(organizations).values({
        ...organization,
        stage: "unknown" as "planning",
        createdAt: new Date(),
      })
    ).rejects.toThrow();
  });

  it("treats a malformed organization ID as not found", async () => {
    expect(await findOrganization(t.db, "not-a-uuid")).toBeUndefined();
  });
});
