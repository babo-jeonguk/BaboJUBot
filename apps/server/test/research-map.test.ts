import {
  researchMapSchema,
  researchNodeDetailSchema,
  researchNodeSchema,
  type Event,
  type WakeReason,
} from "@babojubot/contracts";
import type { Script, ScriptState } from "@babojubot/runtime";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
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

const { get, create, say, tasksOf, eventsOf, researching } = serverHelpers(
  () => t!
);

const mapOf = async (orgId: string) =>
  researchMapSchema.parse(
    await get(`/api/organizations/${orgId}/research-map`)
  );
const nodeDetail = async (orgId: string, nodeId: string) =>
  researchNodeDetailSchema.parse(
    await get(`/api/organizations/${orgId}/research-nodes/${nodeId}`)
  );
const mapEvents = async (orgId: string) =>
  (await eventsOf(orgId)).filter(
    (e): e is Extract<Event, { type: "research_map.edited" }> =>
      e.type === "research_map.edited"
  );
/** 사용자 편집 요청. */
const edit = (method: string, orgId: string, path: string, body?: unknown) =>
  t!.request(method, `/api/organizations/${orgId}${path}`, body);
const outcome = (c: ScriptState["calls"][number]) =>
  c.ok ? "ok" : `${c.status} ${c.code}`;
const mapEdits = (runs: { request: { wakeReasons: WakeReason[] } }[]) =>
  reasons(runs).filter(
    (r): r is Extract<WakeReason, { kind: "research_map_edit" }> =>
      r.kind === "research_map_edit"
  );

/** 사용자가 만든 기본 지도: P ← H ← E(주 연결), P ← D(폐기). */
async function seedMap(orgId: string) {
  const create = async (kind: string, title: string, parentNodeId?: string) => {
    const res = await edit("POST", orgId, "/research-nodes", {
      kind,
      title,
      parentNodeId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return researchNodeSchema.parse(res.body).id;
  };
  const P = await create("problem", "오류율이 높은 원인");
  const H = await create("hypothesis", "잡음이 많은 구간이 원인이다", P);
  const E = await create("experiment", "잡음 구간 제거 후 재평가", H);
  const D = await create("hypothesis", "버린 가설", P);
  expect(
    (await edit("POST", orgId, `/research-nodes/${D}/discard`)).status
  ).toBe(200);
  return { P, H, E, D };
}

describe("research map", () => {
  it("a worker's run creates nodes, assigns primary parents, adds secondary links and links its task, recording each edit without waking anyone", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "지도 조직");
    const [w1] = org.workers;
    const id = (i: number) => (state: ScriptState) => ok(state.calls[i]).id;
    const assignedTask = (state: ScriptState) =>
      (
        state.request.wakeReasons.find(
          (r) => r.kind === "task_assigned"
        ) as Extract<WakeReason, { kind: "task_assigned" }>
      ).taskId;
    const step = (
      tool: Extract<Script["steps"][number], { do: "call" }>["tool"],
      input?: (state: ScriptState) => Record<string, unknown>
    ): Script["steps"][number] => ({ do: "call", tool, input });
    agents.queue(w1!.id, {
      steps: [
        { do: "read_context" },
        step("create_research_node", () => ({
          kind: "problem",
          title: "오류율이 높은 원인",
        })),
        step("create_research_node", () => ({
          kind: "hypothesis",
          title: "잡음이 많은 구간이 원인이다",
          body: "평가셋 오류의 절반이 잡음 구간에 몰려 있다.",
        })),
        step("assign_research_node_parent", (s) => ({
          nodeId: id(1)(s),
          parentNodeId: id(0)(s),
        })),
        step("create_research_node", (s) => ({
          kind: "experiment",
          title: "잡음 구간 제거 후 재평가",
          parentNodeId: id(1)(s),
        })),
        // 같은 두 노드 사이 같은 종류의 연결도, 보조 연결의 순환도 따로 남는다.
        ...[
          ["3", "0", "supports"],
          ["3", "0", "supports"],
          ["0", "3", "relates"],
        ].map(([from, to, kind]) =>
          step("add_research_link", (s) => ({
            sourceNodeId: id(Number(from))(s),
            targetNodeId: id(Number(to))(s),
            kind,
          }))
        ),
        step("link_task_research_node", (s) => ({
          taskId: assignedTask(s),
          researchNodeId: id(1)(s),
        })),
        step("get_research_node", (s) => ({ nodeId: id(1)(s) })),
        step("get_research_map"),
      ],
    });
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "가설 세우기", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업을 맡겨 주세요");
    await t.drain();

    const run = agents.of(w1!.id)[0]!;
    expect(run.state.calls.map(outcome)).toEqual(Array(10).fill("ok"));
    const runId = run.request.identity.runId;
    const [P, H, E] = [0, 1, 3].map((i) => ok(run.state.calls[i]).id) as [
      string,
      string,
      string,
    ];
    const [task] = await tasksOf(org.id);
    expect(task!.researchNodeId).toBe(H);

    const map = await mapOf(org.id);
    const byWorker = { author: "agent", agentId: w1!.id, runId };
    expect(map.nodes).toEqual([
      expect.objectContaining({
        id: P,
        kind: "problem",
        status: "proposed",
        parentNodeId: null,
        createdBy: byWorker,
      }),
      expect.objectContaining({ id: H, parentNodeId: P, createdBy: byWorker }),
      expect.objectContaining({ id: E, parentNodeId: H }),
    ]);
    expect(
      map.links.map((l) => [l.sourceNodeId, l.targetNodeId, l.kind])
    ).toEqual([
      [E, P, "supports"],
      [E, P, "supports"],
      [P, E, "relates"],
    ]);
    expect(new Set(map.links.map((l) => l.id)).size).toBe(3);

    // 노드 상세(도구와 사용자 조회)에 연결 작업과 편집 기록이 보인다.
    const detail = await nodeDetail(org.id, H);
    expect(run.state.calls[8]).toMatchObject({ ok: true, output: detail });
    expect(detail.tasks.map((x) => x.id)).toEqual([task!.id]);
    expect(detail.edits.map((e) => [e.operation, e.editor])).toEqual([
      ["create_node", byWorker],
      ["assign_parent", byWorker],
      ["link_task", byWorker],
    ]);

    // 편집마다 Event 하나. 에이전트 편집은 아무도 깨우지 않는다.
    const events = await mapEvents(org.id);
    expect(events.map((e) => e.payload.operation)).toEqual([
      "create_node",
      "create_node",
      "assign_parent",
      "create_node",
      "add_link",
      "add_link",
      "add_link",
      "link_task",
    ]);
    for (const e of events)
      expect(e.payload).toMatchObject({
        author: "agent",
        agentId: w1!.id,
        runId,
        wokenAgentId: null,
      });
    expect(mapEdits(agents.of(org.lead.id))).toEqual([]);
    // 작업자의 다음 실행 맥락에 조직 사본 템플릿의 종류 선언이 들어 있다.
    expect(
      run.request.context.researchFlow?.nodeKinds.map((k) => k.name)
    ).toEqual(["problem", "hypothesis", "method", "experiment", "result"]);
  });

  it("refuses a second primary parent, primary cycles, undeclared kinds, a second task link, self links and edits of a discarded node, changing nothing", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "거부 조직");
    const [w1] = org.workers;
    const { P, H, E, D } = await seedMap(org.id);
    await t.drain();
    const before = await mapOf(org.id);
    const editsBefore = (await mapEvents(org.id)).length;

    const taskParams = (state: ScriptState) => ({
      taskId: (
        state.request.wakeReasons.find(
          (r) => r.kind === "task_assigned"
        ) as Extract<WakeReason, { kind: "task_assigned" }>
      ).taskId,
    });
    const tries: {
      tool: Extract<Script["steps"][number], { do: "call" }>["tool"];
      input:
        Record<string, unknown> | ((s: ScriptState) => Record<string, unknown>);
    }[] = [
      // 주 부모 두 개: 지정은 주 부모가 없는 노드에만.
      {
        tool: "assign_research_node_parent",
        input: () => ({ nodeId: H, parentNodeId: E }),
      },
      // 주 연결 순환: 자기 자신·후손(폐기된 노드를 거쳐도)을 주 부모로.
      {
        tool: "change_research_node_parent",
        input: () => ({ nodeId: P, parentNodeId: E }),
      },
      {
        tool: "change_research_node_parent",
        input: () => ({ nodeId: P, parentNodeId: P }),
      },
      // 템플릿에 없는 노드·연결 종류.
      { tool: "create_research_node", input: { kind: "theory", title: "x" } },
      {
        tool: "add_research_link",
        input: { sourceNodeId: E, targetNodeId: P, kind: "causes" },
      },
      // 자기 자신과의 보조 연결.
      {
        tool: "add_research_link",
        input: { sourceNodeId: P, targetNodeId: P, kind: "relates" },
      },
      // 작업의 두 번째 노드 연결은 거부하고, 재연결·해제는 명시해야 한다.
      {
        tool: "link_task_research_node",
        input: (s) => ({ ...taskParams(s), researchNodeId: H }),
      },
      {
        tool: "link_task_research_node",
        input: (s) => ({ ...taskParams(s), researchNodeId: H }),
      },
      {
        tool: "link_task_research_node",
        input: (s) => ({ ...taskParams(s), researchNodeId: E }),
      },
      {
        tool: "relink_task_research_node",
        input: (s) => ({ ...taskParams(s), researchNodeId: E }),
      },
      { tool: "unlink_task_research_node", input: taskParams },
      // 폐기된 노드는 폐기 취소만 받고 새 연결의 대상이 되지 않는다.
      {
        tool: "link_task_research_node",
        input: (s) => ({ ...taskParams(s), researchNodeId: D }),
      },
      {
        tool: "update_research_node",
        input: () => ({ nodeId: D, title: "다시 쓰기" }),
      },
      {
        tool: "create_research_node",
        input: { kind: "method", title: "x", parentNodeId: D },
      },
      {
        tool: "add_research_link",
        input: { sourceNodeId: E, targetNodeId: D, kind: "refutes" },
      },
      {
        tool: "change_research_node_parent",
        input: () => ({ nodeId: E, parentNodeId: D }),
      },
      {
        tool: "create_task",
        input: { title: "x", assigneeAgentId: w1!.id, researchNodeId: D },
      },
    ];
    agents.queue(w1!.id, {
      steps: tries.map((x) => ({
        do: "call",
        tool: x.tool,
        input: (s: ScriptState) =>
          typeof x.input === "function" ? x.input(s) : x.input,
        allowRefusal: true,
      })),
    });
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "검증 작업", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업");
    await t.drain();

    const run = agents.of(w1!.id)[0]!;
    expect(run.state.calls.map(outcome)).toEqual([
      "409 primary_parent_exists",
      "409 primary_cycle",
      "409 primary_cycle",
      "422 unknown_kind",
      "422 unknown_kind",
      "422 invalid_input",
      "ok",
      "ok",
      "409 task_already_linked",
      "ok",
      "ok",
      "409 node_discarded",
      "409 node_discarded",
      "409 node_discarded",
      "409 node_discarded",
      "409 node_discarded",
      "409 node_discarded",
    ]);
    // 지도는 그대로이고, 기록된 편집은 작업 연결·재연결·해제뿐이다(같은 노드 재연결은 편집이 아니다).
    expect(await mapOf(org.id)).toEqual(before);
    const added = (await mapEvents(org.id)).slice(editsBefore);
    expect(added.map((e) => e.payload.operation)).toEqual([
      "link_task",
      "relink_task",
      "unlink_task",
    ]);
    expect((await tasksOf(org.id)).map((x) => x.researchNodeId)).toEqual([
      null,
    ]);

    // 사용자 편집도 같은 규칙으로 거부한다.
    const refusals = [
      await edit("PATCH", org.id, `/research-nodes/${D}`, { status: "done" }),
      await edit("POST", org.id, `/research-nodes/${P}/parent`, {
        parentNodeId: E,
      }),
      await edit("POST", org.id, "/research-nodes", {
        kind: "theory",
        title: "x",
      }),
      await edit("POST", org.id, "/research-links", {
        sourceNodeId: H,
        targetNodeId: H,
        kind: "relates",
      }),
      await edit("POST", org.id, "/research-nodes", {
        kind: "problem",
        title: "x",
        organizationId: org.id,
      }),
    ];
    expect(refusals.map((r) => `${r.status} ${r.body.error.code}`)).toEqual([
      "409 node_discarded",
      "409 primary_cycle",
      "422 unknown_kind",
      "422 invalid_input",
      "422 invalid_input",
    ]);
    expect(await mapOf(org.id)).toEqual(before);
  });

  it("records the owner as editor of each map edit and wakes the Lead once per edit, discarding without losing children, links or tasks and restoring the previous status", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "사용자 편집 조직");
    // 작업자 실행 시도가 노드를 만들고 작업을 그 노드에 연결한다(기본 시나리오).
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "문제 정리", assigneeAgentId: org.workers[0]!.id },
      })
    );
    await say(org.id, "작업");
    await t.drain();
    const [task] = await tasksOf(org.id);
    const root = task!.researchNodeId!;
    expect((await mapOf(org.id)).nodes.map((n) => n.id)).toEqual([root]);
    const leadRunsBefore = agents.of(org.lead.id).length;
    const eventsBefore = (await mapEvents(org.id)).length;

    // Lead가 실행 중인 동안 받은 편집은 다음 실행 시도로 간다.
    const gate = createGate();
    agents.queue(org.lead.id, {
      steps: [{ do: "read_context" }, { do: "hold", until: gate.wait }],
    });
    const created = await edit("POST", org.id, "/research-nodes", {
      kind: "hypothesis",
      title: "사용자가 세운 가설",
      parentNodeId: root,
    });
    expect(created.status).toBe(201);
    const child = researchNodeSchema.parse(created.body);
    expect(child).toMatchObject({
      parentNodeId: root,
      status: "proposed",
      createdBy: { author: "owner" },
    });
    await gate.reached;
    const responses = [
      await edit("PATCH", org.id, `/research-nodes/${root}`, {
        title: "고친 문제 제목",
        status: "in_progress",
      }),
      await edit("POST", org.id, "/research-nodes", {
        kind: "problem",
        title: "두 번째 문제",
      }),
    ];
    const second = researchNodeSchema.parse(responses[1]!.body);
    responses.push(
      await edit("POST", org.id, `/research-nodes/${child.id}/parent`, {
        parentNodeId: second.id,
      }),
      await edit("POST", org.id, `/research-nodes/${child.id}/parent`, {
        parentNodeId: root,
      }),
      await edit("POST", org.id, "/research-links", {
        sourceNodeId: second.id,
        targetNodeId: root,
        kind: "relates",
      }),
      // 하위 노드·보조 연결·연결 작업이 있는 노드를 폐기한다.
      await edit("POST", org.id, `/research-nodes/${root}/discard`)
    );
    expect(responses.map((r) => r.status)).toEqual([
      200, 201, 200, 200, 201, 200,
    ]);
    const discarded = await nodeDetail(org.id, root);
    expect(discarded).toMatchObject({
      status: "discarded",
      statusBeforeDiscard: "in_progress",
      title: "고친 문제 제목",
      tasks: [expect.objectContaining({ id: task!.id })],
      artifacts: [expect.objectContaining({ taskId: task!.id })],
    });
    const kept = await mapOf(org.id);
    expect(kept.nodes.find((n) => n.id === child.id)!.parentNodeId).toBe(root);
    expect(kept.links).toEqual([
      expect.objectContaining({ sourceNodeId: second.id, targetNodeId: root }),
    ]);
    // 폐기된 노드를 다시 폐기하면 무변경 성공이다: 폐기 직전 상태를 덮지 않고 기록·Event·깨우기도 없다.
    const again = await edit("POST", org.id, `/research-nodes/${root}/discard`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      status: "discarded",
      statusBeforeDiscard: "in_progress",
      updatedAt: discarded.updatedAt,
    });

    const restored = await edit(
      "POST",
      org.id,
      `/research-nodes/${root}/restore`
    );
    expect(restored.body).toMatchObject({
      status: "in_progress",
      statusBeforeDiscard: null,
    });
    // 지금과 같은 값은 편집이 아니다: 기록·Event·깨우기가 없다.
    const unchanged = [
      await edit("PATCH", org.id, `/research-nodes/${root}`, {
        title: "고친 문제 제목",
      }),
      await edit("POST", org.id, `/research-nodes/${root}/restore`),
      await edit("POST", org.id, `/research-nodes/${child.id}/parent`, {
        parentNodeId: root,
      }),
    ];
    expect(unchanged.map((r) => r.status)).toEqual([200, 200, 200]);
    gate.open();
    await t.drain();

    const events = (await mapEvents(org.id)).slice(eventsBefore);
    expect(events.map((e) => e.payload.operation)).toEqual([
      "create_node",
      "update_node",
      "create_node",
      "change_parent",
      "change_parent",
      "add_link",
      "discard_node",
      "restore_node",
    ]);
    for (const e of events)
      expect(e.payload).toMatchObject({
        author: "owner",
        agentId: null,
        runId: null,
        wokenAgentId: org.lead.id,
      });
    // 실행 중이던 실행 시도는 첫 편집만 받고, 그 사이 편집은 다음 실행 시도 하나로 묶인다.
    const [held, next, ...rest] = agents.of(org.lead.id).slice(leadRunsBefore);
    expect(rest).toEqual([]);
    expect(mapEdits([held!]).map((r) => r.editId)).toEqual([
      events[0]!.payload.editId,
    ]);
    expect(mapEdits([next!])).toEqual(
      events.slice(1).map((e) =>
        expect.objectContaining({
          editId: e.payload.editId,
          operation: e.payload.operation,
          summary: expect.any(String),
        })
      )
    );
    expect(mapEdits([next!]).map((r) => r.summary)).toContain(
      `노드 “사용자가 세운 가설” 주 부모: “고친 문제 제목” → “두 번째 문제”`
    );

    // 편집 기록에 편집자가 남는다.
    const history = (await nodeDetail(org.id, root)).edits;
    expect(history.map((e) => [e.operation, e.editor.author])).toEqual([
      ["create_node", "agent"],
      ["link_task", "agent"],
      ["update_node", "owner"],
      // 이 노드로 들어오는 보조 연결의 추가도 이 노드의 기록에 보인다.
      ["add_link", "owner"],
      ["discard_node", "owner"],
      ["restore_node", "owner"],
    ]);
  });

  it("records a node link made at task creation as the creating agent's map edit", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "생성 연결 조직");
    const { H } = await seedMap(org.id);
    await t.drain();
    const editsBefore = (await mapEvents(org.id)).length;
    agents.queue(org.workers[0]!.id, idle);
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: {
          title: "가설 검증",
          assigneeAgentId: org.workers[0]!.id,
          researchNodeId: H,
        },
      })
    );
    await say(org.id, "작업");
    await t.drain();

    const [task] = await tasksOf(org.id);
    expect(task!.researchNodeId).toBe(H);
    const leadRun = agents.of(org.lead.id).at(-1)!.request.identity.runId;
    expect(
      (await mapEvents(org.id)).slice(editsBefore).map((e) => e.payload)
    ).toEqual([
      expect.objectContaining({
        operation: "link_task",
        author: "agent",
        agentId: org.lead.id,
        runId: leadRun,
        nodeId: H,
        taskId: task!.id,
        wokenAgentId: null,
      }),
    ]);
    expect((await nodeDetail(org.id, H)).edits.at(-1)).toMatchObject({
      operation: "link_task",
      taskId: task!.id,
    });
  });

  it("refuses map edits before the initial research approval and keeps the map empty", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const created = await create("승인 전");
    const orgId = created.id;
    const lead = created.agents[0]!.id;
    agents.queue(
      lead,
      calls(
        {
          tool: "create_research_node",
          input: { kind: "problem", title: "x" },
        },
        { tool: "get_research_map" }
      )
    );
    await say(orgId, "지도에 써 봐");
    await t.drain();
    expect(
      agents.of(lead)[0]!.state.calls.map((c) => (c.ok ? c.output : outcome(c)))
    ).toEqual(["409 stage_closed", { nodes: [], links: [] }]);
    expect(
      (await eventsOf(orgId))
        .filter((e) => e.type === "tool.refused")
        .map((e) => e.payload)
    ).toEqual([
      expect.objectContaining({
        tool: "create_research_node",
        reason: "stage",
      }),
    ]);
    const owner = await edit("POST", orgId, "/research-nodes", {
      kind: "problem",
      title: "x",
    });
    expect(owner).toEqual({
      status: 409,
      body: { error: { code: "stage_closed" } },
    });
    expect(await mapOf(orgId)).toEqual({ nodes: [], links: [] });
    expect(
      (await edit("GET", crypto.randomUUID(), "/research-map")).status
    ).toBe(404);
  });

  it("refuses reading or linking another organization's nodes and tasks, changing nothing there", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const a = await researching(agents, "조직 A");
    const b = await researching(agents, "조직 B");
    const bMap = await seedMap(b.id);
    agents.queue(
      b.lead.id,
      calls({
        tool: "create_task",
        input: { title: "B 작업", assigneeAgentId: b.workers[0]!.id },
      })
    );
    await say(b.id, "작업");
    await t.drain();
    const [bTask] = await tasksOf(b.id);
    const aMap = await seedMap(a.id);
    await t.drain();
    const bEvents = (await eventsOf(b.id)).length;
    const bState = await mapOf(b.id);
    const bLeadRuns = agents.of(b.lead.id).length;

    const foreign = bMap.H;
    agents.queue(
      a.lead.id,
      calls(
        { tool: "get_research_node", input: { nodeId: foreign } },
        {
          tool: "update_research_node",
          input: { nodeId: foreign, title: "x" },
        },
        {
          tool: "discard_research_node",
          input: { nodeId: foreign },
        },
        {
          tool: "create_research_node",
          input: { kind: "method", title: "x", parentNodeId: foreign },
        },
        {
          tool: "change_research_node_parent",
          input: { nodeId: aMap.E, parentNodeId: foreign },
        },
        {
          tool: "add_research_link",
          input: {
            sourceNodeId: aMap.E,
            targetNodeId: foreign,
            kind: "supports",
          },
        },
        {
          tool: "link_task_research_node",
          input: { taskId: bTask!.id, researchNodeId: aMap.H },
        },
        {
          tool: "create_task",
          input: {
            title: "x",
            assigneeAgentId: a.workers[0]!.id,
            researchNodeId: foreign,
          },
        },
        { tool: "get_research_map" }
      )
    );
    await say(a.id, "다른 조직 지도를 건드려 봐");
    await t.drain();
    const outcomes = agents
      .of(a.lead.id)
      .at(-1)!
      .state.calls.map((c) => (c.ok ? c.output : outcome(c)));
    expect(outcomes.slice(0, 8)).toEqual(Array(8).fill("404 not_found"));
    expect(
      researchMapSchema
        .parse(outcomes[8])
        .nodes.map((n) => n.id)
        .sort()
    ).toEqual(Object.values(aMap).sort());

    // 사용자 API도 다른 조직 경로로는 그 노드를 찾거나 잇지 못한다.
    const owner = [
      await edit("GET", a.id, `/research-nodes/${foreign}`),
      await edit("PATCH", a.id, `/research-nodes/${foreign}`, { title: "x" }),
      await edit("POST", a.id, `/research-nodes/${foreign}/discard`),
      await edit("POST", a.id, `/research-nodes/${aMap.E}/parent`, {
        parentNodeId: foreign,
      }),
      await edit("POST", a.id, "/research-links", {
        sourceNodeId: aMap.E,
        targetNodeId: foreign,
        kind: "supports",
      }),
      await edit("POST", a.id, "/research-nodes", {
        kind: "method",
        title: "x",
        parentNodeId: foreign,
      }),
    ];
    expect(owner.map((r) => r.status)).toEqual(Array(6).fill(404));

    expect((await eventsOf(b.id)).length).toBe(bEvents);
    expect(await mapOf(b.id)).toEqual(bState);
    expect(await tasksOf(b.id)).toEqual([bTask]);
    expect(agents.of(b.lead.id).length).toBe(bLeadRuns);
  });

  it("serializes concurrent primary parent changes so that crossing changes never store a cycle", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "동시 편집 조직");
    for (let round = 0; round < 3; round++) {
      const make = async (title: string) =>
        researchNodeSchema.parse(
          (
            await edit("POST", org.id, "/research-nodes", {
              kind: "problem",
              title,
            })
          ).body
        ).id;
      const [x, y] = [await make(`X${round}`), await make(`Y${round}`)];
      const results = await Promise.all([
        edit("POST", org.id, `/research-nodes/${x}/parent`, {
          parentNodeId: y,
        }),
        edit("POST", org.id, `/research-nodes/${y}/parent`, {
          parentNodeId: x,
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body).toEqual({
        error: { code: "primary_cycle" },
      });
      const nodes = (await mapOf(org.id)).nodes.filter(
        (n) => n.id === x || n.id === y
      );
      expect(nodes.filter((n) => n.parentNodeId !== null)).toHaveLength(1);
    }
    await t.drain();
  });
});
