import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAgentAppearance } from "@babojubot/contracts";
import { planOrganizationCreation } from "@babojubot/core";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
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
    const created = await insertOrganizationCreation(t.db, creation);
    if (created.kind !== "ok") throw new Error(created.reason);
    expect(created.value).toMatchObject({
      id: creation.organization.id,
      agents: [{ role: "lead" }],
    });
    expect(created.after.woken).toEqual([creation.wake.agentId]);
    const [event] = created.after.events;

    expect(event).toMatchObject({
      organizationId: creation.organization.id,
      type: "organization.created",
    });
    expect(event!.id).toBeGreaterThan(0);
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
      t.db.insert(agents).values({
        ...lead,
        id: randomUUID(),
        name: "두 번째 Lead",
        createdAt: new Date(),
      })
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
    ).toEqual({ kind: "refused", reason: "not_found" });
    const changed = await updateAgentProfile(t.db, orgA, leadA.id, {
      name: "총괄",
      appearance: face,
    });
    expect(changed).toMatchObject({
      kind: "ok",
      value: { id: leadA.id, name: "총괄", appearance: face },
      after: {
        events: [
          {
            organizationId: orgA,
            type: "agent.profile_changed",
            payload: {
              agentId: leadA.id,
              name: { from: leadA.name, to: "총괄" },
              appearance: face,
            },
          },
        ],
      },
    });
    expect(
      await updateAgentProfile(t.db, orgA, leadA.id, { appearance: face })
    ).toMatchObject({
      kind: "ok",
      value: { name: "총괄" },
      after: { events: [] },
    });
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

describe("agent names", () => {
  const withWorker = async (name: string, workerName: string) => {
    const creation = plan(name);
    await insertOrganizationCreation(t.db, creation);
    const worker = {
      id: randomUUID(),
      organizationId: creation.organization.id,
      role: "worker" as const,
      name: workerName,
      createdAt: new Date(),
    };
    await t.db.insert(agents).values(worker);
    return {
      orgId: creation.organization.id,
      lead: creation.agents[0]!,
      worker,
    };
  };
  const namesOf = async (orgId: string) =>
    (await findOrganization(t.db, orgId))?.agents.map((a) => a.name);

  it("refuses a second agent whose name differs only in case, but not in another organization", async () => {
    const { orgId } = await withWorker("이름 index 조직", "Analyst 1");
    await expect(
      t.db.insert(agents).values({
        id: randomUUID(),
        organizationId: orgId,
        role: "worker",
        name: "analyst 1",
        createdAt: new Date(),
      })
    ).rejects.toThrow();
    const other = await withWorker("다른 이름 index 조직", "analyst 1");
    expect(await namesOf(other.orgId)).toEqual(["Research Lead", "analyst 1"]);
  });

  it("gives one of two concurrent renames to the same name and refuses the other", async () => {
    const { orgId, lead, worker } = await withWorker(
      "이름 경합 조직",
      "Analyst 1"
    );
    const results = await Promise.all([
      updateAgentProfile(t.db, orgId, lead.id, { name: "Analyst 2" }),
      updateAgentProfile(t.db, orgId, worker.id, { name: "analyst 2" }),
    ]);
    expect(
      results.map((r) => (r.kind === "ok" ? r.kind : r.reason)).sort()
    ).toEqual(["name_taken", "ok"]);
    const names = (await namesOf(orgId))!.map((n) => n.toLowerCase());
    expect(names.filter((n) => n === "analyst 2")).toHaveLength(1);
  });

  it("answers name_taken when a write outside the organization lock takes the name first", async () => {
    const { orgId, lead, worker } = await withWorker(
      "잠금 밖 조직",
      "Analyst 1"
    );
    // 조직 행을 잠그지 않는 쓰기가 같은 이름을 먼저 잡고 아직 commit하지 않았다. 이름 변경은 그 이름을 보지 못한 채
    // 저장하다 unique index에서 기다리고, 그 쓰기가 commit하면 index 위반을 같은 name_taken으로 돌려준다.
    const other = new pg.Client({ connectionString: t.url });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("update agents set name = $1 where id = $2", [
        "Statistician",
        worker.id,
      ]);
      const renaming = updateAgentProfile(t.db, orgId, lead.id, {
        name: "statistician",
      });
      for (;;) {
        const { rows } = await t.db.execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
            where wait_event_type = 'Lock' and query like 'update "agents"%'`
        );
        if (rows[0]!.waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await other.query("commit");
      expect(await renaming).toEqual({ kind: "refused", reason: "name_taken" });
    } finally {
      await other.end();
    }
    expect(await namesOf(orgId)).toEqual(["Research Lead", "Statistician"]);
  });

  it("migration 0017 renames existing case-insensitive duplicates, keeping the oldest name", async () => {
    const migrations = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../migrations"
    );
    // 0017 직전까지만 적용한 DB를 같은 cluster에 따로 만든다.
    const before = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-mig-"));
    await fsp.cp(migrations, before, { recursive: true });
    const journalPath = path.join(before, "meta/_journal.json");
    const journal = JSON.parse(await fsp.readFile(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const index = journal.entries.findIndex(
      (e) => e.tag === "0017_agent_name_unique"
    );
    journal.entries = journal.entries.slice(0, index);
    await fsp.writeFile(journalPath, JSON.stringify(journal));

    const name = `dedupe_${randomUUID().replaceAll("-", "")}`;
    await t.db.execute(sql.raw(`create database ${name}`));
    const url = new URL(t.url);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: before });
      const orgA = randomUUID();
      const orgB = randomUUID();
      await pool.query(
        `insert into organizations (id, name, goal, stage, created_at) values
          ($1, 'A', '목표', 'researching', now()), ($2, 'B', '목표', 'researching', now())`,
        [orgA, orgB]
      );
      // A: Lead를 "연구원 1"로 바꾼 뒤 팀을 승인해 겹친 이름, 대소문자만 다른 이름, 붙일 이름 " 2"를 이미 쓰는 이름.
      // B: 다른 조직의 같은 이름은 그대로다.
      const agentsOf = [
        [orgA, "lead", "연구원 1", "2026-01-01T00:00:00Z"],
        [orgA, "worker", "연구원 1", "2026-01-02T00:00:00Z"],
        [orgA, "worker", "연구원 2", "2026-01-02T00:00:00.001Z"],
        [orgA, "worker", "Analyst", "2026-01-03T00:00:00Z"],
        [orgA, "worker", "analyst", "2026-01-04T00:00:00Z"],
        [orgA, "worker", "ANALYST", "2026-01-05T00:00:00Z"],
        [orgA, "worker", "analyst 2", "2026-01-06T00:00:00Z"],
        [orgB, "lead", "연구원 1", "2026-01-01T00:00:00Z"],
      ] as const;
      for (const [org, role, agentName, at] of agentsOf)
        await pool.query(
          `insert into agents (id, organization_id, role, name, created_at) values ($1, $2, $3, $4, $5)`,
          [randomUUID(), org, role, agentName, at]
        );

      await migrate(db, { migrationsFolder: migrations });

      const { rows } = await pool.query<{
        organization_id: string;
        name: string;
      }>(
        `select organization_id, name from agents order by organization_id = $1 desc, created_at`,
        [orgA]
      );
      expect(rows.map((r) => r.name)).toEqual([
        "연구원 1",
        "연구원 1 2",
        "연구원 2",
        "Analyst",
        "analyst 3",
        "ANALYST 4",
        "analyst 2",
        "연구원 1",
      ]);
      // index가 생겨 이제 겹치는 이름을 받지 않는다.
      await expect(
        pool.query(
          `insert into agents (id, organization_id, role, name, created_at) values ($1, $2, 'worker', 'ANALYST', now())`,
          [randomUUID(), orgA]
        )
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pool.end();
      await t.db.execute(sql.raw(`drop database ${name}`));
      await fsp.rm(before, { recursive: true, force: true });
    }
  });
});
