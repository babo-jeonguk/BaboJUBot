import { createHash, randomUUID } from "node:crypto";
import {
  addResearchLinkInputSchema,
  addWorkerInputSchema,
  addTaskCommentInputSchema,
  assignResearchNodeParentInputSchema,
  changeResearchNodeParentInputSchema,
  completeTaskInputSchema,
  createResearchNodeInputSchema,
  emptyCommandInputSchema,
  idempotencyKeyHeader,
  idempotencyKeySchema,
  linkTaskResearchNodeInputSchema,
  memoryRecallLimitDefault,
  recallMemoryInputSchema,
  writeMemoryInputSchema,
  updateResearchNodeInputSchema,
  createTaskInputSchema,
  orgToolMethods,
  orgToolPaths,
  recordArtifactInputSchema,
  recordGoalInputSchema,
  requestInitialApprovalInputSchema,
  sendAgentMessageInputSchema,
  sendAgentToAgentMessageInputSchema,
  startTaskInputSchema,
  submitResultInputSchema,
  type OrgToolErrorCode,
  type OrgToolName,
  type PublicActivity,
  type ToolRefusalReason,
} from "@babojubot/contracts";
import { memoryScopeOf } from "@babojubot/core";
import {
  addWorker,
  appendRunActivity,
  authenticateRun,
  commentTask,
  completeTask,
  createTask,
  dbMemory,
  findArtifact,
  findMessage,
  findResearchNodeDetail,
  findTaskDetail,
  getResearchMap,
  gateToolCall,
  insertAgentMessage,
  insertInitialApprovalRequest,
  listTasks,
  loadRunContext,
  recordArtifact,
  recordGoal,
  sendAgentToAgentMessage,
  startTask,
  submitResult,
  writeMemory,
  writeResearchMap,
  type ActiveRun,
  type Database,
  type MapCommand,
  type ToolCall,
  type ToolOperation,
  type ToolWrite,
} from "@babojubot/db";
import express from "express";
import type { z } from "zod";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";
import { listHarnessLibrary, loadHarnessLibrary } from "./harness.ts";
import { digestRunToken } from "./run-token.ts";
import { problemResponses, type ToolProblem } from "./problems.ts";

const scopeLabel = {
  organization: "조직 기억",
  agent: "에이전트 기억",
} as const;

/** 공개 요약에 쓰는 글자 수. */
const chars = (text: string) => [...text].length;

const quote = (text: string) =>
  `“${chars(text) > 60 ? `${[...text].slice(0, 60).join("")}…` : text}”`;

/**
 * 조직 도구 HTTP. 사용자 API와 따로 실행 시도별 토큰으로만 인증하고, 조직·에이전트·실행 시도는 토큰에서만 정한다.
 * 실행 중이 아닌 실행 시도의 토큰은 읽기까지 모두 거부한다. 모든 도구는 먼저 Role·생애주기 단계 규칙(core `checkToolCall`)을
 * 통과해야 하며, 거부한 호출은 Event log에 남는다. 성공한 호출은 그 실행 시도의 공개 활동에 요약을 남긴다.
 * 다른 에이전트를 깨운 쓰기는 commit 뒤 그 에이전트의 실행 시도를 촉진한다.
 */
export function orgToolsRouter({
  db,
  hub,
  dispatcher,
  now,
  harnessDir,
}: {
  db: Database;
  hub: EventHub;
  dispatcher: RunDispatcher;
  now: () => Date;
  harnessDir: string;
}): express.Router {
  const router = express.Router();
  const refuse = (
    res: express.Response,
    status: number,
    code: OrgToolErrorCode
  ) => res.status(status).json({ error: { code } });
  const toolActivity = (
    tool: OrgToolName,
    summary: string
  ): PublicActivity => ({
    source: "control_plane",
    activity: { type: "org_tool", tool, summary },
  });
  /** 읽기 도구의 요약을 남긴다. 그 사이 실행 시도가 끝났으면 false. */
  const recordRead = async (
    run: ActiveRun,
    tool: OrgToolName,
    summary: string
  ) => {
    const event = await appendRunActivity(
      db,
      run.id,
      toolActivity(tool, summary)
    );
    if (event) hub.publish(event);
    return event !== undefined;
  };

  router.use(async (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const token = /^Bearer (\S+)$/.exec(header)?.[1];
    const run = token && (await authenticateRun(db, digestRunToken(token)));
    if (!run) return refuse(res, 401, "invalid_token");
    res.locals.run = run;
    next();
  });

  /** 도구 handler 앞의 Role·단계 검사. 거부는 Event로 남기고 알린다. */
  const tool =
    (
      name: OrgToolName,
      handler: (
        req: express.Request,
        res: express.Response,
        run: ActiveRun
      ) => Promise<unknown>
    ): express.RequestHandler =>
    async (req, res) => {
      const run = res.locals.run as ActiveRun;
      const gate = await gateToolCall(db, run, name);
      if (!gate) return refuse(res, 401, "invalid_token");
      if (!gate.ok) {
        hub.publish(gate.event);
        return refuseByRule(res, gate.reason);
      }
      if (orgToolMethods[name] !== "GET") {
        const operation = operationOf(req);
        if (operation === false) return refuse(res, 422, "invalid_input");
        res.locals.operation = operation;
      }
      await handler(req, res, run);
    };
  const refuseByRule = (res: express.Response, reason: ToolRefusalReason) =>
    reason === "role"
      ? refuse(res, 403, "forbidden")
      : refuse(res, 409, "stage_closed");
  /**
   * 쓰기 도구의 `Idempotency-Key` header. 없으면 `undefined`, 계약 밖이면 `false`.
   * 같은 키에 다른 입력이 오는지는 경로 변수와 본문의 digest로 가린다.
   */
  const operationOf = (
    req: express.Request
  ): ToolOperation | undefined | false => {
    const header = req.headers[idempotencyKeyHeader];
    if (header === undefined) return undefined;
    const key = idempotencyKeySchema.safeParse(header);
    if (!key.success) return false;
    return {
      key: key.data,
      digest: createHash("sha256")
        .update(JSON.stringify({ params: req.params, body: req.body ?? null }))
        .digest("hex"),
    };
  };
  /** 쓰기 도구 호출 하나: 공개 활동 요약과 그 요청의 같은 호출 키. */
  const callOf = (
    res: express.Response,
    tool: OrgToolName,
    summary: string
  ): ToolCall => ({
    activity: toolActivity(tool, summary),
    operation: res.locals.operation as ToolOperation | undefined,
  });
  /**
   * 조직 도구 쓰기 결과를 응답으로. 저장 때 단계가 바뀌어 거부됐어도 그 거부를 알린다.
   * 도구 규칙의 거부는 `problemResponses`의 응답 코드로 옮긴다.
   */
  const respondWrite = <T, P extends ToolProblem>(
    res: express.Response,
    result: ToolWrite<T, P>,
    status = 201
  ) => {
    switch (result.kind) {
      case "ok":
        hub.publish(...result.events);
        for (const agentId of result.woken ?? []) dispatcher.kick(agentId);
        return res.status(status).json(result.value);
      case "run_finished":
        return refuse(res, 401, "invalid_token");
      case "refused":
        hub.publish(...result.events);
        return refuseByRule(res, result.reason);
      case "invalid": {
        const [code, httpStatus] = problemResponses[result.problem];
        return refuse(res, httpStatus, code);
      }
    }
  };
  const source = { newId: randomUUID, now };
  const param = (req: express.Request, name: string) =>
    String(req.params[name]);

  router.get(
    orgToolPaths.get_run_context,
    tool("get_run_context", async (_req, res, run) => {
      const context = await loadRunContext(db, run.id);
      if (!context) return refuse(res, 401, "invalid_token");
      const recorded = await recordRead(
        run,
        "get_run_context",
        `실행 맥락 조회: 깨우기 ${context.wakeReasons.length}개, 대화 ${context.context.conversation.length}개`
      );
      if (!recorded) return refuse(res, 401, "invalid_token");
      res.json(context);
    })
  );

  router.get(
    orgToolPaths.get_message,
    tool("get_message", async (req, res, run) => {
      const message = await findMessage(
        db,
        run.organizationId,
        String(req.params.messageId)
      );
      // 다른 조직의 메시지와 없는 메시지는 같은 응답이다.
      if (!message) return refuse(res, 404, "not_found");
      if (!(await recordRead(run, "get_message", "메시지 하나 조회")))
        return refuse(res, 401, "invalid_token");
      res.json(message);
    })
  );

  router.post(
    orgToolPaths.send_message,
    tool("send_message", async (req, res, run) => {
      const input = sendAgentMessageInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await insertAgentMessage(db, run, input.data.body, {
          source,
          ...callOf(
            res,
            "send_message",
            `Lead 대화에 답장 (${chars(input.data.body)}자)`
          ),
        })
      );
    })
  );

  router.get(
    orgToolPaths.get_harness_library,
    tool("get_harness_library", async (_req, res, run) => {
      const library = listHarnessLibrary(await loadHarnessLibrary(harnessDir));
      const recorded = await recordRead(
        run,
        "get_harness_library",
        `하네스 라이브러리 조회: Role ${library.roles.length}개, 템플릿 ${library.templates.length}개`
      );
      if (!recorded) return refuse(res, 401, "invalid_token");
      res.json(library);
    })
  );

  router.post(
    orgToolPaths.record_goal,
    tool("record_goal", async (req, res, run) => {
      const input = recordGoalInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await recordGoal(
          db,
          run,
          input.data,
          callOf(res, "record_goal", "연구 목표와 완료 기준 기록")
        )
      );
    })
  );

  router.post(
    orgToolPaths.request_initial_approval,
    tool("request_initial_approval", async (req, res, run) => {
      const input = requestInitialApprovalInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      const heads = input.data.team.reduce((n, m) => n + m.count, 0);
      respondWrite(
        res,
        await insertInitialApprovalRequest(db, run, input.data, {
          library: await loadHarnessLibrary(harnessDir),
          source: { newId: randomUUID, now },
          ...callOf(
            res,
            "request_initial_approval",
            `초기 연구 승인 요청: 작업자 ${heads}명, 템플릿 ${input.data.template}`
          ),
        })
      );
    })
  );

  router.post(
    orgToolPaths.create_task,
    tool("create_task", async (req, res, run) => {
      const input = createTaskInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await createTask(db, run, input.data, {
          source,
          ...callOf(
            res,
            "create_task",
            `작업 생성: ${quote(input.data.title)}${input.data.parentTaskId ? " (하위 작업)" : ""}${input.data.researchNodeId ? " (연구 노드 연결)" : ""}`
          ),
        })
      );
    })
  );

  router.get(
    orgToolPaths.list_tasks,
    tool("list_tasks", async (_req, res, run) => {
      const list = await listTasks(db, run.organizationId);
      if (
        !(await recordRead(
          run,
          "list_tasks",
          `작업 목록 조회: ${list.length}개`
        ))
      )
        return refuse(res, 401, "invalid_token");
      res.json(list);
    })
  );

  router.get(
    orgToolPaths.get_task,
    tool("get_task", async (req, res, run) => {
      const task = await findTaskDetail(
        db,
        run.organizationId,
        param(req, "taskId")
      );
      // 다른 조직의 작업과 없는 작업은 같은 응답이다.
      if (!task) return refuse(res, 404, "not_found");
      if (
        !(await recordRead(run, "get_task", `작업 조회: ${quote(task.title)}`))
      )
        return refuse(res, 401, "invalid_token");
      res.json(task);
    })
  );

  router.post(
    orgToolPaths.start_task,
    tool("start_task", async (req, res, run) => {
      if (!startTaskInputSchema.safeParse(req.body ?? {}).success)
        return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await startTask(db, run, param(req, "taskId"), {
          source,
          ...callOf(res, "start_task", "작업 착수"),
        }),
        200
      );
    })
  );

  router.post(
    orgToolPaths.complete_task,
    tool("complete_task", async (req, res, run) => {
      const input = completeTaskInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await completeTask(db, run, param(req, "taskId"), input.data.summary, {
          source,
          ...callOf(
            res,
            "complete_task",
            `작업 완료와 자기 보고 (${chars(input.data.summary)}자)`
          ),
        }),
        200
      );
    })
  );

  router.post(
    orgToolPaths.comment_task,
    tool("comment_task", async (req, res, run) => {
      const input = addTaskCommentInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await commentTask(db, run, param(req, "taskId"), input.data.body, {
          source,
          ...callOf(
            res,
            "comment_task",
            `작업 댓글 (${chars(input.data.body)}자)`
          ),
        })
      );
    })
  );

  router.post(
    orgToolPaths.record_artifact,
    tool("record_artifact", async (req, res, run) => {
      const input = recordArtifactInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await recordArtifact(db, run, input.data, {
          source,
          ...callOf(
            res,
            "record_artifact",
            `산출물 기록: ${quote(input.data.title)} (${input.data.format}, ${chars(input.data.content)}자)`
          ),
        })
      );
    })
  );

  router.get(
    orgToolPaths.get_artifact,
    tool("get_artifact", async (req, res, run) => {
      const artifact = await findArtifact(
        db,
        run.organizationId,
        param(req, "artifactId")
      );
      if (!artifact) return refuse(res, 404, "not_found");
      if (
        !(await recordRead(
          run,
          "get_artifact",
          `산출물 조회: ${quote(artifact.title)}`
        ))
      )
        return refuse(res, 401, "invalid_token");
      res.json(artifact);
    })
  );

  router.post(
    orgToolPaths.message_agent,
    tool("message_agent", async (req, res, run) => {
      const input = sendAgentToAgentMessageInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await sendAgentToAgentMessage(db, run, input.data, {
          source,
          ...callOf(
            res,
            "message_agent",
            `같은 조직 에이전트에게 메시지 (${chars(input.data.body)}자)`
          ),
        })
      );
    })
  );

  router.get(
    orgToolPaths.get_research_map,
    tool("get_research_map", async (_req, res, run) => {
      const map = await getResearchMap(db, run.organizationId);
      const recorded = await recordRead(
        run,
        "get_research_map",
        `연구 지도 조회: 노드 ${map.nodes.length}개, 보조 연결 ${map.links.length}개`
      );
      if (!recorded) return refuse(res, 401, "invalid_token");
      res.json(map);
    })
  );

  router.get(
    orgToolPaths.get_research_node,
    tool("get_research_node", async (req, res, run) => {
      const node = await findResearchNodeDetail(
        db,
        run.organizationId,
        param(req, "nodeId")
      );
      // 다른 조직의 노드와 없는 노드는 같은 응답이다.
      if (!node) return refuse(res, 404, "not_found");
      if (
        !(await recordRead(
          run,
          "get_research_node",
          `연구 노드 조회: ${quote(node.title)}`
        ))
      )
        return refuse(res, 401, "invalid_token");
      res.json(node);
    })
  );

  /** 연구 지도 쓰기 도구 하나: 입력 계약 → 명령 → 저장. 공개 요약은 명령으로 정한다. */
  const mapTool = <S extends z.ZodType>(
    name: OrgToolName,
    schema: S,
    command: (input: z.infer<S>, req: express.Request) => MapCommand,
    summary: (input: z.infer<S>) => string,
    status = 200
  ) =>
    tool(name, async (req, res, run) => {
      const input = schema.safeParse(req.body ?? {});
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await writeResearchMap(db, run, command(input.data, req), {
          source,
          ...callOf(res, name, summary(input.data)),
        }),
        status
      );
    });
  const nodeId = (req: express.Request) => param(req, "nodeId");
  const taskId = (req: express.Request) => param(req, "taskId");

  router.post(
    orgToolPaths.create_research_node,
    mapTool(
      "create_research_node",
      createResearchNodeInputSchema,
      (input) => ({ op: "create_node", input }),
      (input) =>
        `연구 노드 생성: ${input.kind} ${quote(input.title)}${input.parentNodeId ? " (주 부모 지정)" : ""}`,
      201
    )
  );
  router.patch(
    orgToolPaths.update_research_node,
    mapTool(
      "update_research_node",
      updateResearchNodeInputSchema,
      (input, req) => ({ op: "update_node", nodeId: nodeId(req), input }),
      (input) => `연구 노드 수정: ${Object.keys(input).join(", ")}`
    )
  );
  router.post(
    orgToolPaths.assign_research_node_parent,
    mapTool(
      "assign_research_node_parent",
      assignResearchNodeParentInputSchema,
      (input, req) => ({
        op: "assign_parent",
        nodeId: nodeId(req),
        parentNodeId: input.parentNodeId,
      }),
      () => "연구 노드 주 부모 지정"
    )
  );
  router.post(
    orgToolPaths.change_research_node_parent,
    mapTool(
      "change_research_node_parent",
      changeResearchNodeParentInputSchema,
      (input, req) => ({
        op: "change_parent",
        nodeId: nodeId(req),
        parentNodeId: input.parentNodeId,
      }),
      (input) =>
        input.parentNodeId ? "연구 노드 주 부모 변경" : "연구 노드 주 부모 없앰"
    )
  );
  router.post(
    orgToolPaths.add_research_link,
    mapTool(
      "add_research_link",
      addResearchLinkInputSchema,
      (input) => ({ op: "add_link", input }),
      (input) => `보조 연결 추가: ${input.kind}`,
      201
    )
  );
  for (const [name, op, summary] of [
    ["discard_research_node", "discard_node", "연구 노드 폐기"],
    ["restore_research_node", "restore_node", "연구 노드 폐기 취소"],
  ] as const)
    router.post(
      orgToolPaths[name],
      mapTool(
        name,
        emptyCommandInputSchema,
        (_input, req) => ({ op, nodeId: nodeId(req) }),
        () => summary
      )
    );
  for (const [name, op, summary] of [
    ["link_task_research_node", "link_task", "작업을 연구 노드에 연결"],
    [
      "relink_task_research_node",
      "relink_task",
      "작업을 다른 연구 노드로 재연결",
    ],
  ] as const)
    router.post(
      orgToolPaths[name],
      mapTool(
        name,
        linkTaskResearchNodeInputSchema,
        (input, req) => ({
          op,
          taskId: taskId(req),
          researchNodeId: input.researchNodeId,
        }),
        () => summary
      )
    );
  router.post(
    orgToolPaths.unlink_task_research_node,
    mapTool(
      "unlink_task_research_node",
      emptyCommandInputSchema,
      (_input, req) => ({ op: "unlink_task", taskId: taskId(req) }),
      () => "작업의 연구 노드 연결 해제"
    )
  );

  // 승인 정책이 꺼져 있으면 곧바로 작업자를 만들고(201), 켜져 있으면 승인 요청만 남긴다(202).
  router.post(
    orgToolPaths.add_worker,
    tool("add_worker", async (req, res, run) => {
      const input = addWorkerInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      const result = await addWorker(db, run, input.data, {
        library: await loadHarnessLibrary(harnessDir),
        source,
        ...callOf(res, "add_worker", `작업자 추가: ${input.data.role}`),
      });
      respondWrite(
        res,
        result,
        result.kind === "ok" && result.value.status === "pending_approval"
          ? 202
          : 201
      );
    })
  );

  router.post(
    orgToolPaths.submit_result,
    tool("submit_result", async (req, res, run) => {
      const input = submitResultInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await submitResult(db, run, input.data, {
          source,
          ...callOf(
            res,
            "submit_result",
            `결과 제출: 요약 ${chars(input.data.summary)}자, 근거 산출물 ${input.data.artifactIds.length}개`
          ),
        })
      );
    })
  );

  // 기억 범위의 조직·에이전트와 출처는 토큰의 실행 시도에서만 정한다. 입력은 조직 기억인지 자기 에이전트 기억인지뿐이다.
  router.post(
    orgToolPaths.write_memory,
    tool("write_memory", async (req, res, run) => {
      const input = writeMemoryInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await writeMemory(db, run, input.data, {
          source,
          ...callOf(
            res,
            "write_memory",
            `${scopeLabel[input.data.scope]} 쓰기 (${chars(input.data.content)}자)`
          ),
        })
      );
    })
  );

  router.get(
    orgToolPaths.recall_memory,
    tool("recall_memory", async (req, res, run) => {
      const input = recallMemoryInputSchema.safeParse(req.query);
      if (!input.success) return refuse(res, 422, "invalid_input");
      const { scope, query, limit } = input.data;
      const found = await dbMemory(db, source).recall(
        memoryScopeOf(run, scope),
        { text: query, limit }
      );
      const summary = `${scopeLabel[scope]} 회수: ${found.length}개${query ? `, 검색어 ${chars(query)}자` : ""}${limit === memoryRecallLimitDefault ? "" : `, 최대 ${limit}개`}`;
      if (!(await recordRead(run, "recall_memory", summary)))
        return refuse(res, 401, "invalid_token");
      res.json(found);
    })
  );

  router.use((_req, res) => refuse(res, 404, "not_found"));
  return router;
}
