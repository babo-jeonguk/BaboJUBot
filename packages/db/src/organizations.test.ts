import { randomUUID } from "node:crypto";
import { defaultAgentAppearance } from "@babojubot/contracts";
import { planOrganizationCreation } from "@babojubot/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findOrganization,
  insertOrganizationCreation,
  listOrganizationEvents,
  listOrganizations,
} from "./organizations.ts";
import { migrateDatabase } from "./client.ts";
import { updateAgentProfile } from "./agents.ts";
import { findAgentInstructions } from "./harness.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";
import { listAgentsWithPendingWakes } from "./runs.ts";
import { agents, organizations, wakes } from "./schema.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.close();
});

const plan = (name: string, completionCriteria?: string) =>
  planOrganizationCreation(
    { name, goal: `${name}의 목표`, completionCriteria },
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
      stage: "planning",
      goal: "조직 A의 목표",
      completionCriteria: null,
    });
    expect(detail?.agents.map((a) => a.role)).toEqual(["lead"]);
    expect(
      await listOrganizationEvents(t.db, creation.organization.id)
    ).toEqual([event]);
    expect((await listOrganizations(t.db)).map((o) => o.id)).toContain(
      creation.organization.id
    );
  });

  it("stores the owner's criteria and queues one creation wake for the Lead", async () => {
    const creation = plan("조직 깨우기", "WER 10% 이하");
    await insertOrganizationCreation(t.db, creation);
    expect(
      await findOrganization(t.db, creation.organization.id)
    ).toMatchObject({ completionCriteria: "WER 10% 이하" });
    const lead = creation.agents[0]!;
    expect(await listAgentsWithPendingWakes(t.db)).toContain(lead.id);
    // 조직 생성은 깨우기 하나만 만든다.
    await expect(
      t.db.insert(wakes).values({
        ...creation.wake,
        id: randomUUID(),
        createdAt: new Date(),
      })
    ).rejects.toThrow();
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

  it("changes an agent's name and face inside its own organization only", async () => {
    const a = plan("이름 조직 A");
    const b = plan("이름 조직 B");
    await insertOrganizationCreation(t.db, a);
    await insertOrganizationCreation(t.db, b);
    const leadA = a.agents[0]!;
    const leadB = b.agents[0]!;
    const orgA = a.organization.id;
    const face = {
      color: "mint",
      eyes: "oval",
      mouth: "flat",
      accessory: "sprout",
    } as const;

    // 다른 조직의 에이전트는 없는 에이전트와 같다.
    expect(
      await updateAgentProfile(t.db, orgA, leadB.id, { name: "가로채기" })
    ).toEqual({ kind: "not_found" });
    const changed = await updateAgentProfile(t.db, orgA, leadA.id, {
      name: "총괄",
      appearance: face,
    });
    expect(changed).toMatchObject({
      kind: "changed",
      event: {
        organizationId: orgA,
        type: "agent.profile_changed",
        payload: {
          agentId: leadA.id,
          name: { from: leadA.name, to: "총괄" },
          appearance: face,
        },
      },
    });
    expect(
      await updateAgentProfile(t.db, orgA, leadA.id, { appearance: face })
    ).toEqual({ kind: "unchanged" });
    expect((await findOrganization(t.db, orgA))?.agents[0]).toMatchObject({
      name: "총괄",
      appearance: face,
    });
    expect(
      (await findOrganization(t.db, b.organization.id))?.agents[0]
    ).toMatchObject({
      name: leadB.name,
      appearance: defaultAgentAppearance(leadB.id),
    });
  });

  it("shows the default face when the stored face is not a current preset", async () => {
    const creation = plan("옛 얼굴 조직");
    await insertOrganizationCreation(t.db, creation);
    const lead = creation.agents[0]!;
    await t.db
      .update(agents)
      .set({ appearance: { color: "neon" } as never })
      .where(eq(agents.id, lead.id));
    expect(
      (await findOrganization(t.db, creation.organization.id))?.agents[0]
        ?.appearance
    ).toEqual(defaultAgentAppearance(lead.id));
  });
});
