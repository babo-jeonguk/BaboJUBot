import {
  artifactContentMaxLength,
  artifactSchema,
  taskCommentSchema,
  type WakeReason,
} from "@babojubot/contracts";
import type { Script } from "@babojubot/runtime";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { jsonBodyLimitBytes } from "../src/app.ts";
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

const { get, say, tasksOf, taskDetail, eventsOf, researching } = serverHelpers(
  () => t!
);

describe("tasks and worker runs", () => {
  it("the Lead creates a task, the worker's run records an artifact and a linked research node and completes it, and the Lead wakes for the completed task", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "협력 조직");
    const [w1] = org.workers;
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: {
          title: "오류 유형 분류",
          description: "평가셋 오류를 유형별로 나눈다",
          assigneeAgentId: w1!.id,
        },
      })
    );
    await say(org.id, "작업을 나눠 주세요");
    await t.drain();

    // 담당 작업자는 할당 사유로 깨어나 기본 시나리오로 착수·산출물 기록·완료를 했다.
    const [task] = await tasksOf(org.id);
    const workerRun = agents.of(w1!.id)[0]!;
    expect(workerRun.request.wakeReasons).toEqual([
      expect.objectContaining({
        kind: "task_assigned",
        taskId: task!.id,
        title: "오류 유형 분류",
      }),
    ]);
    expect(workerRun.state.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["get_task", true],
      ["start_task", true],
      ["record_artifact", true],
      ["create_research_node", true],
      ["link_task_research_node", true],
      ["complete_task", true],
    ]);
    const workerRunId = workerRun.request.identity.runId;
    const node = ok(workerRun.state.calls[3]);
    expect(task).toMatchObject({
      status: "completed",
      researchNodeId: node.id,
      assigneeAgentId: w1!.id,
      parentTaskId: null,
      createdByAgentId: org.lead.id,
      startedAt: expect.any(String),
      report: {
        summary: expect.stringContaining("오류 유형 분류"),
        agentId: w1!.id,
        runId: workerRunId,
      },
    });

    // 산출물은 작업·작성 에이전트·실행 시도 출처와 함께 단건으로 열린다.
    const detail = await taskDetail(org.id, task!.id);
    expect(detail.artifacts).toEqual([
      expect.objectContaining({
        taskId: task!.id,
        format: "markdown",
        createdByAgentId: w1!.id,
        createdByRunId: workerRunId,
      }),
    ]);
    const artifact = artifactSchema.parse(
      await get(
        `/api/organizations/${org.id}/artifacts/${detail.artifacts[0]!.id}`
      )
    );
    expect(artifact.content).toContain("# 오류 유형 분류 메모");

    // 부모 작업이 없으므로 작업을 만든 Lead가 하위 작업 완료 사유로 깨어난다.
    const leadWoken = agents.of(org.lead.id).at(-1)!;
    expect(leadWoken.request.wakeReasons).toEqual([
      {
        kind: "task_completed",
        wakeId: expect.any(String),
        taskId: task!.id,
        title: "오류 유형 분류",
        summary: task!.report!.summary,
        completedByAgentId: w1!.id,
      },
    ]);
    // 다른 작업자는 깨어나지 않는다.
    expect(agents.of(org.workers[1]!.id)).toEqual([]);

    const types = (await eventsOf(org.id)).filter(
      (e) => e.type.startsWith("task.") || e.type === "artifact.recorded"
    );
    expect(types.map((e) => [e.type, e.payload])).toEqual([
      [
        "task.created",
        expect.objectContaining({
          agentId: org.lead.id,
          assigneeAgentId: w1!.id,
          wokenAgentId: w1!.id,
        }),
      ],
      ["task.started", expect.objectContaining({ agentId: w1!.id })],
      ["artifact.recorded", expect.objectContaining({ taskId: task!.id })],
      [
        "task.completed",
        expect.objectContaining({
          agentId: w1!.id,
          runId: workerRunId,
          wokenAgentId: org.lead.id,
        }),
      ],
    ]);
  });

  it("wakes the parent task's assignee when a subtask completes, without waiting for its siblings, and completes a task once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "부모 작업 조직");
    const [w1, w2] = org.workers;
    // 부모 작업은 연구원 1이, 하위 작업 둘은 연구원 2가 맡는다. 연구원 1은 받은 할당을 읽기만 한다.
    agents.queue(w1!.id, idle);
    agents.queue(org.lead.id, {
      steps: [
        {
          do: "call",
          tool: "create_task",
          input: () => ({ title: "부모", assigneeAgentId: w1!.id }),
        },
        ...["하위 A", "하위 B"].map((title): Script["steps"][number] => ({
          do: "call",
          tool: "create_task",
          input: (state) => ({
            title,
            assigneeAgentId: w2!.id,
            parentTaskId: ok(state.calls[0]).id,
          }),
        })),
      ],
    });
    const childA = () =>
      tasksOf(org.id).then((x) => x.find((k) => k.title === "하위 A")!);
    // 연구원 2: 첫 실행 시도(하위 A 할당이 먼저 생기므로 늘 포함)에서 하위 A만 두 번 완료를 시도하고,
    // 하위 B 할당이 다음 실행 시도로 따로 오면 읽기만 한다.
    agents.queue(
      w2!.id,
      {
        steps: [
          { do: "read_context" },
          ...[0, 1].map((): Script["steps"][number] => ({
            do: "call",
            tool: "complete_task",
            input: (state) => ({
              taskId: state.request.wakeReasons.find(
                (r): r is Extract<WakeReason, { kind: "task_assigned" }> =>
                  r.kind === "task_assigned" && r.title === "하위 A"
              )!.taskId,
              summary: "하위 A를 끝냈습니다",
            }),
            allowRefusal: true,
          })),
        ],
      },
      idle
    );
    await say(org.id, "작업을 나눠 주세요");
    await t.drain();

    const a = await childA();
    expect(a.status).toBe("completed");
    expect(agents.of(w2!.id)[0]!.state.calls).toEqual([
      expect.objectContaining({ tool: "complete_task", ok: true }),
      {
        tool: "complete_task",
        ok: false,
        status: 409,
        code: "already_completed",
      },
    ]);
    // 부모 작업 담당자(연구원 1)가 하위 A 완료로 깨어난다. 하위 B는 아직 열려 있다.
    expect(
      reasons(agents.of(w1!.id)).filter((r) => r.kind === "task_completed")
    ).toEqual([
      expect.objectContaining({ taskId: a.id, completedByAgentId: w2!.id }),
    ]);
    expect(
      (await tasksOf(org.id)).find((k) => k.title === "하위 B")!.status
    ).toBe("open");
    // 부모가 있는 작업의 완료는 만든 Lead를 깨우지 않는다.
    expect(
      reasons(agents.of(org.lead.id)).filter((r) => r.kind === "task_completed")
    ).toEqual([]);
    const completed = (await eventsOf(org.id)).filter(
      (e) => e.type === "task.completed"
    );
    expect(completed.map((e) => e.payload)).toEqual([
      expect.objectContaining({ taskId: a.id, wokenAgentId: w1!.id }),
    ]);
  });

  it("applies the task rules: only the assignee starts, the assignee or the Lead completes, and other workers are refused", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "작업 규칙 조직");
    const [w1, w2] = org.workers;
    agents.queue(w1!.id, idle);
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "규칙", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업");
    await t.drain();
    const [task] = await tasksOf(org.id);
    const params = { taskId: task!.id };

    // 다른 작업자는 착수도 완료도 못 한다. 연구원 1에게 메시지로 깨어난 연구원 2가 시도한다.
    agents.queue(
      w2!.id,
      calls(
        { tool: "start_task", input: params },
        { tool: "complete_task", input: { ...params, summary: "남의 작업" } }
      )
    );
    agents.queue(
      w1!.id,
      calls({
        tool: "message_agent",
        input: { recipientAgentId: w2!.id, body: "제 작업을 봐 줄래요?" },
      }),
      idle
    );
    // Lead는 착수는 못 하지만 조정으로 완료할 수 있다.
    agents.queue(
      org.lead.id,
      calls(
        {
          tool: "message_agent",
          input: { recipientAgentId: w1!.id, body: "진행해 주세요" },
        },
        { tool: "start_task", input: params },
        {
          tool: "complete_task",
          input: { ...params, summary: "Lead가 정리했습니다" },
        },
        {
          tool: "message_agent",
          input: { recipientAgentId: org.lead.id, body: "나에게" },
        }
      )
    );
    await say(org.id, "확인");
    await t.drain();

    const leadCalls = agents.of(org.lead.id).at(-1)!.state.calls;
    expect(
      leadCalls.map((c) => (c.ok ? "ok" : `${c.status} ${c.code}`))
    ).toEqual(["ok", "403 not_assignee", "ok", "422 invalid_input"]);
    const workerCalls = agents
      .of(w2!.id)
      .flatMap((r) => r.state.calls)
      .map((c) => (c.ok ? "ok" : `${c.status} ${c.code}`));
    expect(workerCalls).toEqual(["403 not_assignee", "403 not_assignee"]);
    expect(reasons(agents.of(w2!.id))).toEqual([
      expect.objectContaining({
        kind: "agent_to_agent_message",
        senderAgentId: w1!.id,
        body: "제 작업을 봐 줄래요?",
      }),
    ]);
    expect(await taskDetail(org.id, task!.id)).toMatchObject({
      status: "completed",
      startedAt: null,
      report: { summary: "Lead가 정리했습니다", agentId: org.lead.id },
    });
    // Lead가 만든 작업을 Lead가 완료하면 자기 자신을 깨우지 않는다.
    expect(
      reasons(agents.of(org.lead.id)).filter((r) => r.kind === "task_completed")
    ).toEqual([]);
  });

  it("skips the artifact and completion when the worker's start is refused because the Lead completed the task first, still handling its other wake reasons", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "조정 완료 조직");
    const [w1] = org.workers;
    // 연구원 1이 메시지로 깨어나 실행 중인 동안 Lead가 작업을 맡기고 곧바로 조정으로 완료한다.
    // 할당 사유는 연구원 1의 다음 실행 시도(기본 시나리오)로 간다.
    const workerBusy = createGate();
    const leadDone = createGate();
    agents.queue(w1!.id, {
      steps: [{ do: "read_context" }, { do: "hold", until: workerBusy.wait }],
    });
    agents.queue(org.lead.id, {
      steps: [
        {
          do: "call",
          tool: "message_agent",
          input: () => ({
            recipientAgentId: w1!.id,
            body: "잠시 기다려 주세요",
          }),
        },
        { do: "hold", until: () => workerBusy.reached },
        {
          do: "call",
          tool: "create_task",
          input: () => ({ title: "조정 작업", assigneeAgentId: w1!.id }),
        },
        {
          do: "call",
          tool: "complete_task",
          input: (state) => ({
            taskId: ok(state.calls[1]).id,
            summary: "Lead가 먼저 정리했습니다",
          }),
        },
        { do: "hold", until: leadDone.wait },
      ],
    });
    await say(org.id, "작업");
    await leadDone.reached;
    const [task] = await tasksOf(org.id);
    expect(task!.status).toBe("completed");
    const comment = await t.request(
      "POST",
      `/api/organizations/${org.id}/tasks/${task!.id}/comments`,
      { body: "왜 끝났나요?" }
    );
    expect(comment.status).toBe(201);
    leadDone.open();
    workerBusy.open();
    await t.drain();

    const next = agents.of(w1!.id).at(-1)!;
    expect(next.request.wakeReasons.map((r) => r.kind)).toEqual([
      "task_assigned",
      "task_comment",
    ]);
    expect(
      next.state.calls.map((c) => [
        c.tool,
        c.ok ? "ok" : `${c.status} ${c.code}`,
      ])
    ).toEqual([
      ["get_task", "ok"],
      ["start_task", "409 invalid_transition"],
      ["comment_task", "ok"],
    ]);
    // 산출물도 두 번째 완료도 없고 Lead의 자기 보고가 그대로 남는다.
    expect(await taskDetail(org.id, task!.id)).toMatchObject({
      status: "completed",
      startedAt: null,
      report: { summary: "Lead가 먼저 정리했습니다", agentId: org.lead.id },
      artifacts: [],
      comments: [
        expect.objectContaining({ author: "owner" }),
        expect.objectContaining({ author: "agent", agentId: w1!.id }),
      ],
    });
    const types = (await eventsOf(org.id)).map((e) => e.type);
    expect(types).not.toContain("artifact.recorded");
    expect(types.filter((x) => x === "task.completed")).toHaveLength(1);
  });

  it("records an artifact up to the contract's character limit regardless of its encoded size, and refuses longer or oversized bodies", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "큰 산출물 조직");
    const [w1] = org.workers;
    const contents = [
      "가".repeat(40_000),
      "가".repeat(artifactContentMaxLength),
      // JSON에서 한 글자가 6바이트(\u0001)로 늘어나는 가장 큰 본문.
      "\u0001".repeat(artifactContentMaxLength),
      "a".repeat(artifactContentMaxLength + 1),
    ];
    agents.queue(w1!.id, {
      steps: contents.map((content, i) => ({
        do: "call",
        tool: "record_artifact",
        input: (state) => ({
          taskId: (
            state.request.wakeReasons[0] as Extract<
              WakeReason,
              { kind: "task_assigned" }
            >
          ).taskId,
          title: `큰 산출물 ${i + 1}`,
          format: "text",
          content,
        }),
        allowRefusal: true,
      })),
    });
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "큰 산출물", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업");
    await t.drain();

    const run = agents.of(w1!.id)[0]!;
    expect(
      run.state.calls.map((c) => (c.ok ? "ok" : `${c.status} ${c.code}`))
    ).toEqual(["ok", "ok", "ok", "422 invalid_input"]);
    const [task] = await tasksOf(org.id);
    const { artifacts } = await taskDetail(org.id, task!.id);
    expect(artifacts).toHaveLength(3);
    for (const [i, summary] of artifacts.entries()) {
      const artifact = artifactSchema.parse(
        await get(`/api/organizations/${org.id}/artifacts/${summary.id}`)
      );
      expect(artifact.content).toBe(contents[i]);
    }

    // 상한을 넘는 본문은 토큰 확인·계약 검사 전에 413으로 거부한다.
    const tooLarge = await t.tool(
      run.request.access.token,
      "POST",
      "/artifacts",
      {
        taskId: task!.id,
        title: "너무 큼",
        format: "text",
        content: "a".repeat(jsonBodyLimitBytes),
      }
    );
    expect(tooLarge).toEqual({
      status: 413,
      body: { error: { code: "body_too_large" } },
    });
  });

  it("wakes the assignee with the owner's task comment, delivering it to the next run and keeping a completed task completed", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "댓글 조직");
    const [w1] = org.workers;
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "댓글 작업", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업");
    await t.drain();
    const [task] = await tasksOf(org.id);
    expect(task!.status).toBe("completed");

    const comment = (body: unknown, orgId = org.id, taskId = task!.id) =>
      t!.request(
        "POST",
        `/api/organizations/${orgId}/tasks/${taskId}/comments`,
        body
      );
    const res = await comment({ body: "근거를 보강해 주세요" });
    expect(res.status).toBe(201);
    const posted = taskCommentSchema.parse(res.body);
    expect(posted).toMatchObject({
      author: "owner",
      agentId: null,
      deliveredToRunId: null,
    });
    await t.drain();

    const woken = agents.of(w1!.id).at(-1)!;
    expect(woken.request.wakeReasons).toEqual([
      {
        kind: "task_comment",
        wakeId: expect.any(String),
        taskId: task!.id,
        commentId: posted.id,
        body: "근거를 보강해 주세요",
      },
    ]);
    // 작업자는 작업 댓글로 답하고, 댓글은 작업 상태를 바꾸지 않는다.
    const detail = await taskDetail(org.id, task!.id);
    expect(detail.status).toBe("completed");
    expect(detail.comments).toEqual([
      expect.objectContaining({
        id: posted.id,
        author: "owner",
        deliveredToRunId: woken.request.identity.runId,
      }),
      expect.objectContaining({
        author: "agent",
        agentId: w1!.id,
        runId: woken.request.identity.runId,
        body: expect.stringContaining("근거를 보강해 주세요"),
      }),
    ]);
    // 에이전트 댓글은 아무도 깨우지 않는다.
    expect(agents.of(w1!.id)).toHaveLength(2);
    expect(
      (await eventsOf(org.id))
        .filter((e) => e.type === "task.commented")
        .map((e) => e.payload)
    ).toEqual([
      expect.objectContaining({ author: "owner", wokenAgentId: w1!.id }),
      expect.objectContaining({ author: "agent", wokenAgentId: null }),
    ]);

    expect((await comment({ body: "  " })).status).toBe(422);
    expect((await comment({ body: "x", organizationId: org.id })).status).toBe(
      422
    );
    expect(
      (await comment({ body: "x" }, org.id, crypto.randomUUID())).status
    ).toBe(404);
    expect((await comment({ body: "x" }, org.id, "not-a-uuid")).status).toBe(
      404
    );
  });

  it("delivers task comments posted while the assignee is running to its next run, not the running one", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "실행 중 댓글 조직");
    const [w1] = org.workers;
    const gate = createGate();
    agents.queue(w1!.id, {
      steps: [{ do: "read_context" }, { do: "hold", until: gate.wait }],
    });
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "긴 작업", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업");
    await gate.reached;
    const [task] = await tasksOf(org.id);
    const post = async (body: string) => {
      const res = await t!.request(
        "POST",
        `/api/organizations/${org.id}/tasks/${task!.id}/comments`,
        { body }
      );
      expect(res.status).toBe(201);
      return taskCommentSchema.parse(res.body).id;
    };
    const first = await post("첫 댓글");
    const second = await post("둘째 댓글");
    expect(
      (await taskDetail(org.id, task!.id)).comments.map(
        (c) => c.deliveredToRunId
      )
    ).toEqual([null, null]);
    gate.open();
    await t.drain();

    const [held, next] = agents.of(w1!.id);
    expect(held!.request.wakeReasons.map((r) => r.kind)).toEqual([
      "task_assigned",
    ]);
    // 다음 실행 시도 하나가 두 댓글을 순서대로 받는다.
    expect(
      next!.request.wakeReasons.map(
        (r) => r.kind === "task_comment" && r.commentId
      )
    ).toEqual([first, second]);
    const delivered = (await taskDetail(org.id, task!.id)).comments.filter(
      (c) => c.author === "owner"
    );
    expect(delivered.map((c) => c.deliveredToRunId)).toEqual([
      next!.request.identity.runId,
      next!.request.identity.runId,
    ]);
  });

  it("refuses messages to, and reads or writes of tasks and artifacts in, another organization, changing nothing there", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const a = await researching(agents, "조직 A");
    const b = await researching(agents, "조직 B");
    // 조직 B: 기본 시나리오로 작업과 산출물을 만든다.
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
    const bArtifact = (await taskDetail(b.id, bTask!.id)).artifacts[0]!;
    const bEvents = (await eventsOf(b.id)).length;
    const bRuns = b.workers.map((w) => agents.of(w.id).length);

    const forged = { taskId: bTask!.id };
    agents.queue(
      a.lead.id,
      calls(
        {
          tool: "message_agent",
          input: { recipientAgentId: b.workers[0]!.id, body: "안녕" },
        },
        { tool: "get_task", input: forged },
        { tool: "start_task", input: forged },
        {
          tool: "complete_task",
          input: { ...forged, summary: "남의 조직" },
        },
        { tool: "comment_task", input: { ...forged, body: "남의 조직" } },
        {
          tool: "record_artifact",
          input: {
            taskId: bTask!.id,
            title: "x",
            format: "text",
            content: "x",
          },
        },
        { tool: "get_artifact", input: { artifactId: bArtifact.id } },
        {
          tool: "create_task",
          input: { title: "x", assigneeAgentId: b.workers[0]!.id },
        },
        {
          tool: "create_task",
          input: {
            title: "x",
            assigneeAgentId: a.workers[0]!.id,
            parentTaskId: bTask!.id,
          },
        },
        {
          tool: "create_task",
          input: {
            title: "x",
            assigneeAgentId: a.workers[0]!.id,
            organizationId: b.id,
          },
        },
        { tool: "list_tasks" }
      )
    );
    await say(a.id, "다른 조직을 건드려 봐");
    await t.drain();

    const outcomes = agents
      .of(a.lead.id)
      .at(-1)!
      .state.calls.map((c) => (c.ok ? c.output : `${c.status} ${c.code}`));
    expect(outcomes).toEqual([
      ...Array(9).fill("404 not_found"),
      "422 invalid_input",
      [],
    ]);
    // 조직 B에는 아무것도 남지 않았고 B의 에이전트는 깨어나지 않았다.
    expect((await eventsOf(b.id)).length).toBe(bEvents);
    expect(b.workers.map((w) => agents.of(w.id).length)).toEqual(bRuns);
    expect(await taskDetail(b.id, bTask!.id)).toMatchObject({
      comments: [],
      artifacts: [expect.objectContaining({ id: bArtifact.id })],
    });
    expect(await tasksOf(a.id)).toEqual([]);

    // 사용자 API도 다른 조직 경로로는 그 기록을 찾지 못한다.
    for (const path of [
      `/api/organizations/${a.id}/tasks/${bTask!.id}`,
      `/api/organizations/${a.id}/artifacts/${bArtifact.id}`,
    ])
      expect((await t.request("GET", path)).status).toBe(404);
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${a.id}/tasks/${bTask!.id}/comments`,
          { body: "x" }
        )
      ).status
    ).toBe(404);
  });
});
