import {
  resultArtifactsMax,
  resultSubmissionSchema,
  submitResultInputSchema,
  taskReportMaxLength,
  type RunRequest,
  type TaskDetail,
} from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  createScriptedRuntime,
  defaultScriptSelector,
  demoLeadScript,
  leadReplyScript,
  parseGoalMessage,
  type Script,
} from "./scripted.ts";
import { createGate } from "./testing.ts";

const ids = {
  organizationId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
};
const request: RunRequest = {
  identity: ids,
  access: { toolsBaseUrl: "http://tools.test", token: "secret-token" },
  wakeReasons: [
    {
      kind: "owner_message",
      wakeId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      body: "목표를 정하자",
    },
  ],
  context: {
    organization: {
      id: ids.organizationId,
      name: "조직",
      stage: "goal_setting",
      goal: null,
      completionCriteria: null,
    },
    agent: { id: ids.agentId, role: "lead", name: "Research Lead" },
    team: [{ id: ids.agentId, role: "lead", name: "Research Lead" }],
    conversation: [],
    researchFlow: null,
  },
  instructionsBundleVersion: null,
  instructions: [],
  workspace: null,
  previousSession: null,
};

/** 조직 도구 HTTP 호출을 기록하고 계약 모양으로 답한다. */
function toolServer(status = 200) {
  const calls: {
    method: string;
    url: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    init?.signal?.throwIfAborted();
    calls.push({
      method: init?.method ?? "GET",
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (status !== 200)
      return Response.json({ error: { code: "invalid_token" } }, { status });
    if (url.endsWith("/run-context"))
      return Response.json({
        identity: request.identity,
        wakeReasons: request.wakeReasons,
        context: request.context,
      });
    return Response.json(
      {
        id: crypto.randomUUID(),
        organizationId: ids.organizationId,
        agentId: ids.agentId,
        author: "agent",
        body: (calls.at(-1)!.body as { body: string }).body,
        delivery: null,
        sentByRunId: ids.runId,
        deliveredToRunId: null,
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    );
  };
  return { calls, fetch };
}

const control = () => {
  const emitted: unknown[] = [];
  return {
    emitted,
    controller: new AbortController(),
    emit: async (activity: unknown) => {
      emitted.push(activity);
    },
  };
};

describe("scripted runtime", () => {
  it("answers the Lead conversation through the organization tools with the run token", async () => {
    const tools = toolServer();
    const runtime = createScriptedRuntime({ fetch: tools.fetch });
    const c = control();

    const result = await runtime.execute(request, {
      signal: c.controller.signal,
      emit: c.emit,
    });

    expect(result).toMatchObject({ stopReason: "completed", error: null });
    expect(result.summary).toBeTruthy();
    expect(tools.calls.map((x) => [x.method, x.url, x.auth])).toEqual([
      ["GET", "http://tools.test/api/tools/run-context", "Bearer secret-token"],
      ["POST", "http://tools.test/api/tools/messages", "Bearer secret-token"],
    ]);
    expect(tools.calls[1]!.body).toEqual({
      body: expect.stringContaining("목표를 정하자"),
    });
    expect(c.emitted).toEqual([{ type: "progress", text: expect.any(String) }]);
  });

  it("stops at a held step when cancelled and settles as cancelled without further tool calls", async () => {
    const tools = toolServer();
    const gate = createGate();
    const runtime = createScriptedRuntime({
      fetch: tools.fetch,
      select: () => ({
        steps: [
          { do: "read_context" },
          { do: "hold", until: gate.wait },
          { do: "send_message", body: () => "늦은 답장" },
        ],
      }),
    });
    const c = control();

    const done = runtime.execute(request, {
      signal: c.controller.signal,
      emit: c.emit,
    });
    await gate.reached;
    c.controller.abort();

    expect(await done).toMatchObject({ stopReason: "cancelled" });
    expect(tools.calls.map((x) => x.method)).toEqual(["GET"]);
  });

  it("fails the run when an organization tool refuses the token", async () => {
    const tools = toolServer(401);
    const runtime = createScriptedRuntime({ fetch: tools.fetch });
    const c = control();

    const result = await runtime.execute(request, {
      signal: c.controller.signal,
      emit: c.emit,
    });

    expect(result).toMatchObject({ stopReason: "failed" });
    expect(result.error).toContain("401");
    expect(result.error).not.toContain("secret-token");
  });

  it("fails when no scenario matches the agent and wake", async () => {
    const runtime = createScriptedRuntime({
      fetch: toolServer().fetch,
      select: () => undefined,
    });
    const c = control();
    const result = await runtime.execute(
      {
        ...request,
        context: {
          ...request.context,
          agent: { ...request.context.agent, role: "worker" },
        },
      },
      { signal: c.controller.signal, emit: c.emit }
    );
    expect(result.stopReason).toBe("failed");
  });
});

describe("demo Lead scenario", () => {
  const calls = (script: Script) =>
    script.steps.flatMap((s) => (s.do === "call" ? [s.tool] : []));
  const at = (
    stage: RunRequest["context"]["organization"]["stage"],
    wakeReasons: RunRequest["wakeReasons"],
    goal: string | null = null
  ): RunRequest => ({
    ...request,
    wakeReasons,
    context: {
      ...request.context,
      organization: {
        ...request.context.organization,
        stage,
        goal,
        completionCriteria: goal && "기준",
      },
    },
  });
  const message = (body: string) => ({
    kind: "owner_message" as const,
    wakeId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    body,
  });

  it("reads a goal only from both `목표:` and `완료 기준:` lines", () => {
    expect(parseGoalMessage("목표: 오류 절반\n완료 기준：WER 10%")).toEqual({
      goal: "오류 절반",
      completionCriteria: "WER 10%",
    });
    expect(parseGoalMessage("오류를 줄이는 것이 목표입니다")).toBeUndefined();
    expect(parseGoalMessage("목표: 오류 절반")).toBeUndefined();
  });

  it("records the goal and requests approval, resubmits after changes are requested, and otherwise replies", () => {
    expect(
      calls(
        demoLeadScript(
          at("goal_setting", [message("목표: 오류 절반\n완료 기준: WER 10%")])
        )
      )
    ).toEqual(["record_goal", "request_initial_approval"]);
    expect(
      calls(demoLeadScript(at("goal_setting", [message("안녕")])))
    ).toEqual([]);
    const sentBack = {
      kind: "approval_decision" as const,
      wakeId: crypto.randomUUID(),
      approvalId: crypto.randomUUID(),
      approvalKind: "initial_research" as const,
      decision: "request_changes" as const,
      note: "줄여 주세요",
    };
    const resubmit = demoLeadScript(at("planning", [sentBack], "오류 절반"));
    expect(calls(resubmit)).toEqual(["request_initial_approval"]);
    const step = resubmit.steps.find((s) => s.do === "call");
    expect(
      step?.do === "call" &&
        (
          step.input?.({
            request,
            context: undefined,
            sent: [],
            calls: [],
          }) as {
            plan: string;
          }
        ).plan
    ).toContain("줄여 주세요");
    expect(demoLeadScript(at("researching", [message("진행 상황은?")]))).toBe(
      leadReplyScript
    );
  });

  it("hands one task to each worker after the initial research approval", () => {
    const workers = [crypto.randomUUID(), crypto.randomUUID()];
    const approved = at(
      "researching",
      [
        {
          kind: "approval_decision",
          wakeId: crypto.randomUUID(),
          approvalId: crypto.randomUUID(),
          approvalKind: "initial_research",
          decision: "approve",
          note: null,
        },
      ],
      "오류 절반"
    );
    approved.context.team = [
      ...request.context.team,
      ...workers.map((id, i) => ({
        id,
        role: "worker" as const,
        name: `연구원 ${i + 1}`,
      })),
    ];
    const script = demoLeadScript(approved);
    const state = {
      request: approved,
      context: undefined,
      sent: [],
      calls: [],
    };
    expect(
      script.steps.flatMap((s) =>
        s.do === "call"
          ? [
              [
                s.tool,
                (s.input?.(state) as { assigneeAgentId: string })
                  .assigneeAgentId,
              ],
            ]
          : []
      )
    ).toEqual(workers.map((id) => ["create_task", id]));
  });

  it("adds a worker when the owner asks, and only replies to a worker addition's decision", () => {
    const state = (r: RunRequest) => ({
      request: r,
      context: undefined,
      sent: [],
      calls: [],
    });
    const asked = at("researching", [message("작업자 추가: researcher")]);
    const script = demoLeadScript(asked);
    expect(calls(script)).toEqual(["add_worker"]);
    const step = script.steps.find((s) => s.do === "call");
    expect(step?.do === "call" && step.input?.(state(asked))).toEqual({
      role: "researcher",
    });
    const plain = demoLeadScript(
      at("researching", [message("작업자 추가해 주세요")])
    );
    const plainStep = plain.steps.find((s) => s.do === "call");
    expect(
      plainStep?.do === "call" &&
        plainStep.input?.(state(at("researching", [])))
    ).toEqual({ role: "researcher" });
    // 부정문·단순 언급은 부탁이 아니다.
    for (const body of [
      "작업자 추가하지 마세요",
      "작업자 추가는 나중에 합시다",
      "작업자 추가\n하지 마세요",
    ])
      expect(demoLeadScript(at("researching", [message(body)]))).toBe(
        leadReplyScript
      );
    // 작업자 추가는 연구 진행에서만 연다.
    expect(
      calls(demoLeadScript(at("result_review", [message("작업자 추가")])))
    ).toEqual([]);

    for (const decision of ["approve", "reject"] as const)
      expect(
        demoLeadScript(
          at(
            "researching",
            [
              {
                kind: "approval_decision",
                wakeId: crypto.randomUUID(),
                approvalId: crypto.randomUUID(),
                approvalKind: "add_worker",
                decision,
                note: decision === "reject" ? "충분합니다" : null,
              },
            ],
            "오류 절반"
          )
        )
      ).toBe(leadReplyScript);
  });

  it("fails the run when the owner asks for a failure drill in any stage, not when it is merely mentioned", () => {
    for (const stage of ["goal_setting", "researching"] as const)
      expect(
        demoLeadScript(at(stage, [message("실패 연습 해 주세요")])).steps
      ).toEqual([
        { do: "fail", error: "(가짜 실행기) 사용자가 부탁한 실패 연습입니다." },
      ]);
    expect(
      demoLeadScript(at("researching", [message("실패 연습은 하지 마세요")]))
    ).toBe(leadReplyScript);
  });

  it("holds the run until it is cancelled when the owner asks for a hold drill in any stage", async () => {
    for (const stage of ["goal_setting", "researching"] as const) {
      const { steps } = demoLeadScript(
        at(stage, [message("실행 유지 연습 해 주세요")])
      );
      expect(steps).toEqual([{ do: "hold", until: expect.any(Function) }]);
      const hold = steps[0] as Extract<(typeof steps)[number], { do: "hold" }>;
      const controller = new AbortController();
      const held = hold.until(controller.signal);
      controller.abort("cancel");
      await expect(held).rejects.toBe("cancel");
    }
    expect(
      demoLeadScript(
        at("researching", [message("실행 유지 연습은 하지 마세요")])
      )
    ).toBe(leadReplyScript);
  });

  it("submits a result only when the owner asks for it, not when the message merely mentions it", () => {
    for (const body of [
      "결과 제출 부탁해요",
      "결과를 제출해 주세요",
      "결과 제출을 시도해 주세요",
    ])
      expect(demoLeadScript(at("researching", [message(body)]))).not.toBe(
        leadReplyScript
      );
    for (const body of [
      "결과 제출하지 마세요",
      "결과 제출은 나중에 합시다",
      "결과 제출\n하지 마세요",
    ])
      expect(demoLeadScript(at("researching", [message(body)]))).toBe(
        leadReplyScript
      );
  });

  it("keeps the demo Lead's result submission within the contract's evidence and summary limits and says what it left out", async () => {
    const now = new Date().toISOString();
    const lead = ids.agentId;
    const researching: RunRequest = {
      ...request,
      wakeReasons: [
        {
          kind: "owner_message",
          wakeId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          body: "결과 제출 부탁해요",
        },
      ],
      context: {
        ...request.context,
        organization: {
          ...request.context.organization,
          stage: "researching",
          goal: "오류 유형을 정리한다",
          completionCriteria: "유형 목록",
        },
      },
    };
    // 상한보다 많은 완료 작업. 작업마다 산출물 하나와 가장 긴 자기 보고를 남겼다.
    const tasks: TaskDetail[] = Array.from(
      { length: resultArtifactsMax + 10 },
      (_, i) => ({
        id: crypto.randomUUID(),
        organizationId: ids.organizationId,
        title: `작업 ${i + 1}`,
        description: "",
        status: "completed",
        assigneeAgentId: lead,
        parentTaskId: null,
        researchNodeId: null,
        createdByAgentId: lead,
        createdByRunId: ids.runId,
        startedAt: now,
        report: {
          summary: "보".repeat(taskReportMaxLength),
          agentId: lead,
          runId: ids.runId,
          completedAt: now,
        },
        createdAt: now,
        comments: [],
        artifacts: [
          {
            id: crypto.randomUUID(),
            organizationId: ids.organizationId,
            taskId: crypto.randomUUID(),
            title: `메모 ${i + 1}`,
            format: "markdown",
            createdByAgentId: lead,
            createdByRunId: ids.runId,
            createdAt: now,
          },
        ],
      })
    );
    const submitted: unknown[] = [];
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/api/tools", "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === "/run-context")
        return Response.json({
          identity: researching.identity,
          wakeReasons: researching.wakeReasons,
          context: researching.context,
        });
      if (path === "/tasks")
        return Response.json(
          tasks.map(({ comments: _c, artifacts: _a, ...task }) => task)
        );
      if (path.startsWith("/tasks/"))
        return Response.json(tasks.find((t) => path.endsWith(t.id)));
      if (path === "/results") {
        submitted.push(body);
        // 서버처럼 계약 밖 입력은 422로 거부한다.
        const parsed = submitResultInputSchema.safeParse(body);
        if (!parsed.success)
          return Response.json(
            { error: { code: "invalid_input" } },
            { status: 422 }
          );
        return Response.json(
          resultSubmissionSchema.parse({
            id: crypto.randomUUID(),
            organizationId: ids.organizationId,
            status: "pending",
            submittedByAgentId: lead,
            submittedByRunId: ids.runId,
            previousSubmissionId: null,
            createdAt: now,
            decidedAt: null,
            summary: parsed.data.summary,
            goal: "오류 유형을 정리한다",
            completionCriteria: "유형 목록",
            artifacts: [],
            decisionNote: null,
          }),
          { status: 201 }
        );
      }
      if (path === "/messages") {
        sent.push(body.body);
        return Response.json(
          {
            id: crypto.randomUUID(),
            organizationId: ids.organizationId,
            agentId: lead,
            author: "agent",
            body: body.body,
            delivery: null,
            sentByRunId: ids.runId,
            deliveredToRunId: null,
            createdAt: now,
          },
          { status: 201 }
        );
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    };
    const c = control();

    const result = await createScriptedRuntime({ fetch }).execute(researching, {
      signal: c.controller.signal,
      emit: c.emit,
    });

    expect(result).toMatchObject({ stopReason: "completed", error: null });
    const [input] = submitted as { summary: string; artifactIds: string[] }[];
    expect(submitResultInputSchema.safeParse(input).success).toBe(true);
    // 근거는 앞에서부터 상한까지, 요약에는 들어간 자기 보고만 담고 생략한 수를 밝힌다.
    expect(input!.artifactIds).toEqual(
      tasks.slice(0, resultArtifactsMax).map((t) => t.artifacts[0]!.id)
    );
    expect(input!.summary).toMatch(
      /작업 \d+개의 자기 보고는 길이 제한으로 생략/
    );
    expect(sent).toEqual([
      expect.stringContaining(
        `근거 산출물 ${tasks.length}개 중 ${resultArtifactsMax}개`
      ),
    ]);
  });
});

describe("demo worker scenario", () => {
  const worker = (wakeReasons: RunRequest["wakeReasons"]): RunRequest => ({
    ...request,
    wakeReasons,
    context: {
      ...request.context,
      organization: { ...request.context.organization, stage: "researching" },
      agent: { ...request.context.agent, role: "worker", name: "연구원 1" },
      researchFlow: {
        nodeKinds: [{ name: "problem", label: "연구 문제" }],
        linkKinds: [],
      },
    },
  });

  it("starts an assigned task, records an artifact and a research node linked to the task, and completes it with a self-report, replying to comments on the task", () => {
    const taskId = crypto.randomUUID();
    const script = defaultScriptSelector(
      worker([
        {
          kind: "task_assigned",
          wakeId: crypto.randomUUID(),
          taskId,
          title: "자료 조사",
        },
        {
          kind: "task_comment",
          wakeId: crypto.randomUUID(),
          taskId,
          commentId: crypto.randomUUID(),
          body: "근거를 보강해 주세요",
        },
      ])
    )!;
    const state = { request, context: undefined, sent: [], calls: [] };
    expect(
      script.steps.flatMap((s) =>
        s.do === "call" ? [[s.tool, s.params?.(state)?.taskId]] : []
      )
    ).toEqual([
      ["get_task", taskId],
      ["start_task", taskId],
      ["record_artifact", undefined],
      ["create_research_node", undefined],
      ["link_task_research_node", taskId],
      ["complete_task", taskId],
      ["comment_task", taskId],
    ]);
    // 착수했으면 템플릿의 첫 종류로 작업 제목의 노드를 만들고, 만든 노드에 작업을 연결한다.
    const nodeId = crypto.randomUUID();
    const started = {
      ...state,
      calls: [
        {
          tool: "start_task" as const,
          ok: true as const,
          output: { id: taskId },
        },
        {
          tool: "create_research_node" as const,
          ok: true as const,
          output: { id: nodeId, title: "자료 조사" },
        },
      ],
    };
    const step = (tool: string) =>
      script.steps.find(
        (s): s is Extract<typeof s, { do: "call" }> =>
          s.do === "call" && s.tool === tool
      )!;
    expect(step("create_research_node").when!(started)).toBe(true);
    expect(step("create_research_node").input!(started)).toMatchObject({
      kind: "problem",
      title: "자료 조사",
    });
    expect(step("link_task_research_node").input!(started)).toEqual({
      researchNodeId: nodeId,
    });
    expect(step("link_task_research_node").when!(state)).toBe(false);
  });
});
