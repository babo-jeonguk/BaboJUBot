import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentInstructionsSchema,
  instructionCopySchema,
  instructionMaxBytes,
  instructionRevisionSchema,
  instructionRevisionSummarySchema,
  orgToolNames,
  orgTools,
  resultSubmissionSummaryListSchema,
  type Event,
  type InstructionCopy,
  type RunRequest,
  type WakeReason,
} from "@babojubot/contracts";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  calls,
  idle,
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

const leadOf = (org: { agents: { id: string; role: string }[] }) =>
  org.agents.find((a) => a.role === "lead")!.id;
const { get, create, say, tasksOf, eventsOf, researching } = serverHelpers(
  () => t!
);

const harnessDir = path.resolve(import.meta.dirname, "../../../harness");
const library = (file: string) =>
  fs.readFileSync(path.join(harnessDir, file), "utf8");

const base = (orgId: string, agentId: string) =>
  `/api/organizations/${orgId}/agents/${agentId}/instructions`;
const instructions = async (orgId: string, agentId: string) =>
  agentInstructionsSchema.parse(await get(base(orgId, agentId)));
const copyAt = async (orgId: string, agentId: string, filePath: string) =>
  (await instructions(orgId, agentId)).copies.find((c) => c.path === filePath)!;
const revisions = async (orgId: string, agentId: string, copyId: string) =>
  z
    .array(instructionRevisionSummarySchema)
    .parse(await get(`${base(orgId, agentId)}/${copyId}/revisions`));
const revisionAt = async (
  orgId: string,
  agentId: string,
  copyId: string,
  number: number
) =>
  instructionRevisionSchema.parse(
    await get(`${base(orgId, agentId)}/${copyId}/revisions/${number}`)
  );
const save = (orgId: string, agentId: string, copyId: string, body: unknown) =>
  t!.request("PUT", `${base(orgId, agentId)}/${copyId}`, body);
const editEvents = async (orgId: string) =>
  (await eventsOf(orgId)).filter(
    (e): e is Extract<Event, { type: "instruction_copy.edited" }> =>
      e.type === "instruction_copy.edited"
  );
const instructionEdits = (runs: { request: { wakeReasons: WakeReason[] } }[]) =>
  reasons(runs).filter(
    (r): r is Extract<WakeReason, { kind: "instruction_edit" }> =>
      r.kind === "instruction_edit"
  );
const filesOf = (copies: InstructionCopy[]) =>
  copies.map(({ path, content }) => ({ path, content }));

describe("Role·Soul·Skill copy editing", () => {
  it("saving a copy replaces its content, appends a revision by the owner, records an Event and wakes the Lead with the edit as the reason", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "사본 편집 조직");
    const [w1] = org.workers;
    const before = await copyAt(org.id, w1!.id, "AGENTS.md");
    expect(before.revision).toBe(1);
    const leadRunsBefore = agents.of(org.lead.id).length;
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const edited = "# 고친 연구원\n\n잡음 구간부터 확인한다.\n";
    const res = await save(org.id, w1!.id, before.id, {
      content: edited,
      expectedRevision: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(instructionCopySchema.parse(res.body)).toEqual({
      ...before,
      content: edited,
      revision: 2,
    });
    expect(await copyAt(org.id, w1!.id, "AGENTS.md")).toEqual({
      ...before,
      content: edited,
      revision: 2,
    });

    // revision 1은 복사로 생긴 처음 내용, revision 2는 사용자 편집이다. 시각은 서버가 정한다.
    const list = await revisions(org.id, w1!.id, before.id);
    expect(list.map((r) => [r.number, r.editor])).toEqual([
      [2, { author: "owner" }],
      [1, { author: "copy" }],
    ]);
    expect(list[1]!.createdAt).toBe(before.createdAt);
    expect(await revisionAt(org.id, w1!.id, before.id, 1)).toMatchObject({
      path: "AGENTS.md",
      content: before.content,
    });
    expect(await revisionAt(org.id, w1!.id, before.id, 2)).toMatchObject({
      id: list[0]!.id,
      content: edited,
      editor: { author: "owner" },
    });

    const payload = {
      by: "owner",
      agentId: w1!.id,
      copyId: before.id,
      path: "AGENTS.md",
      revisionId: list[0]!.id,
      revision: 2,
      wokenAgentId: org.lead.id,
    };
    expect(await stream.next()).toMatchObject({
      type: "instruction_copy.edited",
      payload,
    });
    stream.close();
    expect(await editEvents(org.id)).toEqual([
      expect.objectContaining({ organizationId: org.id, payload }),
    ]);

    await t.drain();
    const leadRuns = agents.of(org.lead.id).slice(leadRunsBefore);
    expect(instructionEdits(leadRuns)).toEqual([
      {
        kind: "instruction_edit",
        wakeId: expect.any(String),
        revisionId: list[0]!.id,
        agentId: w1!.id,
        copyId: before.id,
        path: "AGENTS.md",
        revision: 2,
      },
    ]);
  });

  it("a changed library reaches only organizations made after the change; existing copies stay as they were", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
    try {
      fs.cpSync(harnessDir, dir, { recursive: true });
      t = await startTestServer({ harnessDir: dir });
      const before = await create("바뀌기 전 조직");
      const original = await copyAt(before.id, leadOf(before), "AGENTS.md");
      fs.writeFileSync(
        path.join(dir, "roles/lead/AGENTS.md"),
        "# Research Lead\n\nRevised guidance.\n"
      );
      const after = await create("바뀐 뒤 조직");
      expect((await copyAt(after.id, leadOf(after), "AGENTS.md")).content).toBe(
        "# Research Lead\n\nRevised guidance.\n"
      );
      expect(await copyAt(before.id, leadOf(before), "AGENTS.md")).toEqual(
        original
      );
      expect(original.content).toBe(library("roles/lead/AGENTS.md"));
    } finally {
      await t?.close();
      t = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("editing one worker's copy leaves the other worker of the same Role and the harness library unchanged", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "사본 독립 조직");
    const [w1, w2] = org.workers;
    const otherBefore = await instructions(org.id, w2!.id);
    const libraryBefore = library("roles/researcher/AGENTS.md");
    const own = await copyAt(org.id, w1!.id, "AGENTS.md");

    const res = await save(org.id, w1!.id, own.id, {
      content: "# w1만의 연구원\n",
      expectedRevision: 1,
    });
    expect(res.status).toBe(200);

    expect(await instructions(org.id, w2!.id)).toEqual(otherBefore);
    expect(
      await revisions(org.id, w2!.id, otherBefore.copies[0]!.id)
    ).toHaveLength(1);
    expect(library("roles/researcher/AGENTS.md")).toBe(libraryBefore);
    // 복사 출처는 편집해도 그대로다.
    expect(await copyAt(org.id, w1!.id, "AGENTS.md")).toMatchObject({
      source: own.source,
      sourceDigest: own.sourceDigest,
    });
    expect((await instructions(org.id, w1!.id)).bundleVersion).not.toBe(
      otherBefore.bundleVersion
    );
  });

  it("the edited agent's next run gets the new bundle without the previous session; a run in progress keeps its own and other agents keep theirs", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "다음 실행 조직");
    const [w1, w2] = org.workers;
    agents.queue(
      org.lead.id,
      calls(
        {
          tool: "create_task",
          input: { title: "w1 작업", assigneeAgentId: w1!.id },
        },
        {
          tool: "create_task",
          input: { title: "w2 작업", assigneeAgentId: w2!.id },
        }
      )
    );
    await say(org.id, "작업을 나눠 주세요");
    await t.drain();
    const tasks = await tasksOf(org.id);
    const taskOf = (agentId: string) =>
      tasks.find((x) => x.assigneeAgentId === agentId)!;
    const lastRun = (agentId: string) => agents.of(agentId).at(-1)!.request;
    const w2Before = lastRun(w2!.id);

    // w1이 실행 중일 때 w1의 사본을 고친다. 진행 중 실행 시도는 시작할 때 받은 지침 그대로다.
    const gate = createGate();
    agents.queue(w1!.id, { steps: [{ do: "hold", until: gate.wait }] });
    const comment = (taskId: string, body: string) =>
      t!.request(
        "POST",
        `/api/organizations/${org.id}/tasks/${taskId}/comments`,
        { body }
      );
    expect((await comment(taskOf(w1!.id).id, "다시 봐 주세요")).status).toBe(
      201
    );
    await gate.reached;
    const before = await instructions(org.id, w1!.id);
    const soul = before.copies.find((c) => c.path === "SOUL.md")!;
    expect(
      (
        await save(org.id, w1!.id, soul.id, {
          content: "# 고친 Soul\n",
          expectedRevision: 1,
        })
      ).status
    ).toBe(200);
    gate.open();
    await t.drain();
    const heldRun = agents.of(w1!.id).at(-1)!.request;
    expect(heldRun.instructionsBundleVersion).toBe(before.bundleVersion);
    expect(heldRun.instructions).toEqual(filesOf(before.copies));

    const after = await instructions(org.id, w1!.id);
    expect(after.bundleVersion).not.toBe(before.bundleVersion);
    agents.queue(w1!.id, idle);
    agents.queue(w2!.id, idle);
    await comment(taskOf(w1!.id).id, "고친 지침으로 다시");
    await comment(taskOf(w2!.id).id, "그대로 다시");
    await t.drain();

    const next: RunRequest = lastRun(w1!.id);
    expect(next.instructionsBundleVersion).toBe(after.bundleVersion);
    expect(next.instructions).toEqual(filesOf(after.copies));
    expect(next.previousSession).toBeNull();

    const other = lastRun(w2!.id);
    expect(other).not.toBe(w2Before);
    expect(other.instructionsBundleVersion).toBe(
      w2Before.instructionsBundleVersion
    );
    expect(other.previousSession).not.toBeNull();
  });

  it("a stale save is refused without changes; a save of the same content still leaves a revision but keeps the bundle", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "충돌 조직");
    const role = await copyAt(org.id, org.lead.id, "AGENTS.md");

    const [first, second] = await Promise.all(
      ["# 탭 A\n", "# 탭 B\n"].map((content) =>
        save(org.id, org.lead.id, role.id, { content, expectedRevision: 1 })
      )
    );
    const statuses = [first!.status, second!.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first!.status === 409 ? first! : second!;
    expect(loser.body).toEqual({ error: { code: "revision_conflict" } });
    const winner = instructionCopySchema.parse(
      (first!.status === 200 ? first! : second!).body
    );
    expect(await copyAt(org.id, org.lead.id, "AGENTS.md")).toEqual(winner);
    expect(await revisions(org.id, org.lead.id, role.id)).toHaveLength(2);
    expect(await editEvents(org.id)).toHaveLength(1);

    const bundle = (await instructions(org.id, org.lead.id)).bundleVersion;
    const same = await save(org.id, org.lead.id, role.id, {
      content: winner.content,
      expectedRevision: 2,
    });
    expect(same.status).toBe(200);
    expect(instructionCopySchema.parse(same.body).revision).toBe(3);
    expect((await instructions(org.id, org.lead.id)).bundleVersion).toBe(
      bundle
    );
    expect(await editEvents(org.id)).toHaveLength(2);
  });

  it("rejects a Skill that would no longer load, oversized content and malformed input, keeping the copy unchanged", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "Skill 검사 조직");
    const [w1] = org.workers;
    const skill = await copyAt(
      org.id,
      w1!.id,
      "skills/record-research-node/SKILL.md"
    );

    const tries: [unknown, number, string][] = [
      [
        { content: "frontmatter 없음", expectedRevision: 1 },
        422,
        "invalid_skill",
      ],
      [
        {
          content: skill.content.replace(/^name: .*$/m, "name: other-skill"),
          expectedRevision: 1,
        },
        422,
        "invalid_skill",
      ],
      [
        { content: "a".repeat(instructionMaxBytes + 1), expectedRevision: 1 },
        422,
        "invalid_input",
      ],
      [{ content: "x" }, 422, "invalid_input"],
      [{ content: "x", expectedRevision: 0 }, 422, "invalid_input"],
      [
        { content: "x", expectedRevision: 1, path: "AGENTS.md" },
        422,
        "invalid_input",
      ],
    ];
    for (const [body, status, code] of tries) {
      const res = await save(org.id, w1!.id, skill.id, body);
      expect(
        [res.status, res.body.error?.code],
        JSON.stringify(body).slice(0, 80)
      ).toEqual([status, code]);
    }
    expect(await copyAt(org.id, w1!.id, skill.path)).toEqual(skill);
    expect(await revisions(org.id, w1!.id, skill.id)).toHaveLength(1);
    expect(await editEvents(org.id)).toEqual([]);

    const fixed = skill.content.replace(/\n---\n/, "\n---\n고친 본문 앞줄\n");
    const ok = await save(org.id, w1!.id, skill.id, {
      content: fixed,
      expectedRevision: 1,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("another organization's agents, copies and revisions are refused as if they did not exist", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const a = await researching(agents, "조직 A");
    const b = await researching(agents, "조직 B");
    const copy = await copyAt(a.id, a.lead.id, "AGENTS.md");
    const missing = "00000000-0000-4000-8000-000000000000";
    const workerOfA = a.workers[0]!.id;

    const refs: [string, string, string][] = [
      [b.id, a.lead.id, copy.id], // 다른 조직 경로의 A 에이전트·사본
      [b.id, b.lead.id, copy.id], // B 에이전트 경로의 A 사본
      [a.id, workerOfA, copy.id], // 같은 조직이지만 다른 에이전트의 사본
      [a.id, a.lead.id, missing],
      [a.id, a.lead.id, "not-a-uuid"],
    ];
    for (const [orgId, agentId, copyId] of refs) {
      const label = `${orgId}/${agentId}/${copyId}`;
      for (const [method, suffix, body] of [
        ["PUT", "", { content: "침범", expectedRevision: 1 }],
        ["GET", "/revisions", undefined],
        ["GET", "/revisions/1", undefined],
      ] as const) {
        const res = await t.request(
          method,
          `${base(orgId, agentId)}/${copyId}${suffix}`,
          body
        );
        expect([res.status, res.body], `${method} ${label}${suffix}`).toEqual([
          404,
          { error: { code: "not_found" } },
        ]);
      }
    }
    expect((await t.request("GET", base(b.id, a.lead.id))).status).toBe(404);
    expect(
      (
        await t.request(
          "GET",
          `${base(a.id, a.lead.id)}/${copy.id}/revisions/2`
        )
      ).status
    ).toBe(404);
    expect(await copyAt(a.id, a.lead.id, "AGENTS.md")).toEqual(copy);
    expect(await editEvents(a.id)).toEqual([]);
    expect(await editEvents(b.id)).toEqual([]);
  });

  it("refuses edits in a stopped or completed organization but still shows its copies and revisions", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const stopped = await researching(agents, "중단 조직");
    expect(
      (await t.request("POST", `/api/organizations/${stopped.id}/stop`, {}))
        .status
    ).toBe(200);

    // 결과를 제출하고 최종 완료한 조직.
    const done = await researching(agents, "완료 조직");
    agents.queue(
      done.lead.id,
      calls({
        tool: "create_task",
        input: { title: "근거 만들기", assigneeAgentId: done.workers[0]!.id },
      })
    );
    await say(done.id, "작업을 맡겨 주세요");
    await t.drain();
    const [task] = await tasksOf(done.id);
    const detail = await get(`/api/organizations/${done.id}/tasks/${task!.id}`);
    agents.queue(
      done.lead.id,
      calls({
        tool: "submit_result",
        input: { summary: "정리", artifactIds: [detail.artifacts[0].id] },
      })
    );
    await say(done.id, "결과를 정리해 주세요");
    await t.drain();
    const [pending] = resultSubmissionSummaryListSchema.parse(
      await get(`/api/organizations/${done.id}/results`)
    );
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${done.id}/results/${pending!.id}/decision`,
          { decision: "complete" }
        )
      ).status
    ).toBe(200);

    for (const org of [stopped, done]) {
      const copy = await copyAt(org.id, org.lead.id, "AGENTS.md");
      const res = await save(org.id, org.lead.id, copy.id, {
        content: copy.content,
        expectedRevision: 1,
      });
      expect([res.status, res.body]).toEqual([
        409,
        { error: { code: "organization_closed" } },
      ]);
      expect(await copyAt(org.id, org.lead.id, "AGENTS.md")).toEqual(copy);
      expect(await revisions(org.id, org.lead.id, copy.id)).toHaveLength(1);
      expect(await editEvents(org.id)).toEqual([]);
    }
  });

  it("organization tools have no way to edit a copy", async () => {
    expect(
      orgToolNames.filter((n) =>
        /instruction|copy|role|soul|skill|revision/.test(n)
      )
    ).toEqual([]);
    expect(
      Object.values(orgTools)
        .map((tool) => tool.path)
        .filter((p) => /instruction|copies|revision/.test(p))
    ).toEqual([]);
  });
});
