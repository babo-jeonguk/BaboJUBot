import { createHash, randomUUID } from "node:crypto";
import {
  idempotencyKeyHeader,
  idempotencyKeySchema,
  isOrgToolRead,
  memoryRecallLimitDefault,
  orgToolNames,
  orgTools,
  type OrgToolErrorCode,
  type OrgToolName,
  type OrgToolParsedInput,
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
import { applyAfterCommit } from "./after-commit.ts";
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

/** 처리 함수가 검사를 통과한 호출 하나에 쓰는 응답 수단. */
type ToolReply = {
  run: ActiveRun;
  /** 거부 응답. */
  refuse: (status: number, code: OrgToolErrorCode) => void;
  /** 읽기 도구의 공개 요약을 남기고 값을 돌려준다. 그 사이 실행 시도가 끝났으면 401. */
  read: (summary: string, value: unknown) => Promise<void>;
  /** 쓰기 도구 호출 하나: 공개 활동 요약과 그 요청의 같은 호출 키. */
  call: (summary: string) => ToolCall;
  /** 쓰기 결과를 응답으로. */
  write: <T, P extends ToolProblem>(
    result: ToolWrite<T, P>,
    status?: number
  ) => Promise<void>;
};

/** 도구별 처리 함수. 입력 검사와 Role·단계 검사를 통과한 입력만 받는다. 공개 활동 요약은 처리 결과에 달려 있어 여기서 정한다. */
type ToolHandlers = {
  [T in OrgToolName]: (
    input: OrgToolParsedInput<T>,
    reply: ToolReply
  ) => Promise<void>;
};

/**
 * 조직 도구 HTTP. 사용자 API와 따로 실행 시도별 토큰으로만 인증하고, 조직·에이전트·실행 시도는 토큰에서만 정한다.
 * 경로는 도구 목록(contracts `orgTools`)에서 만든다. 실행 중이 아닌 실행 시도의 토큰은 읽기까지 모두 거부한다.
 * 모든 도구는 먼저 Role·생애주기 단계 규칙(core `checkToolCall`)을 통과해야 하며, 거부한 호출은 Event log에 남는다.
 * 그다음 같은 호출 키와 입력(경로 변수와 본문/query를 합친 하나)을 검사하고 도구별 처리 함수에 넘긴다.
 * 성공한 호출은 그 실행 시도의 공개 활동에 요약을 남긴다. 다른 에이전트를 깨운 쓰기는 commit 뒤 그 에이전트의 실행 시도를 촉진한다.
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
    if (event) await applyAfterCommit({ hub, dispatcher }, { events: [event] });
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
  /**
   * 경로 변수와 본문(GET이면 query)을 도구 입력 하나로 합친다. 입력이 경로 변수뿐인 읽기 도구는 query를 읽지 않는다.
   * 본문이 객체가 아니거나 경로 변수와 같은 이름의 칸이 있으면 계약 밖이다(`undefined`).
   */
  const inputOf = (tool: OrgToolName, req: express.Request) => {
    const { params, bodyFields } = orgTools[tool];
    const names: readonly string[] = params;
    const rest: unknown = !isOrgToolRead(tool)
      ? (req.body ?? {})
      : bodyFields.length
        ? req.query
        : {};
    if (typeof rest !== "object" || rest === null || Array.isArray(rest))
      return undefined;
    if (Object.keys(rest).some((key) => names.includes(key))) return undefined;
    return { ...rest, ...req.params };
  };
  /**
   * 조직 도구 쓰기 결과를 응답으로. 저장 때 단계가 바뀌어 거부됐어도 그 거부의 Event를 같은 commit 뒤 할 일로 알린다.
   * 도구 규칙의 거부는 `problemResponses`의 응답 코드로 옮긴다.
   */
  const respondWrite = async <T, P extends ToolProblem>(
    res: express.Response,
    result: ToolWrite<T, P>,
    status = 201
  ) => {
    switch (result.kind) {
      case "ok":
        await applyAfterCommit({ hub, dispatcher }, result.after);
        return res.status(status).json(result.value);
      case "run_finished":
        return refuse(res, 401, "invalid_token");
      case "refused":
        await applyAfterCommit({ hub, dispatcher }, result.after);
        return refuseByRule(res, result.reason);
      case "invalid": {
        const [code, httpStatus] = problemResponses[result.problem];
        return refuse(res, httpStatus, code);
      }
    }
  };
  const source = { newId: randomUUID, now };

  /** 연구 지도 쓰기 하나. */
  const mapWrite = async (
    { run, call, write }: ToolReply,
    command: MapCommand,
    summary: string,
    status = 200
  ) =>
    write(
      await writeResearchMap(db, run, command, { source, ...call(summary) }),
      status
    );

  const handlers: ToolHandlers = {
    async get_run_context(_input, { run, refuse, read }) {
      const context = await loadRunContext(db, run.id);
      if (!context) return refuse(401, "invalid_token");
      await read(
        `실행 맥락 조회: 깨우기 ${context.wakeReasons.length}개, 대화 ${context.context.conversation.length}개`,
        context
      );
    },
    async get_message({ messageId }, { run, refuse, read }) {
      const message = await findMessage(db, run.organizationId, messageId);
      // 다른 조직의 메시지와 없는 메시지는 같은 응답이다.
      if (!message) return refuse(404, "not_found");
      await read("메시지 하나 조회", message);
    },
    async send_message(input, { run, call, write }) {
      await write(
        await insertAgentMessage(db, run, input, {
          source,
          ...call(`Lead 대화에 답장 (${chars(input.body)}자)`),
        })
      );
    },
    async get_harness_library(_input, { read }) {
      const library = listHarnessLibrary(await loadHarnessLibrary(harnessDir));
      await read(
        `하네스 라이브러리 조회: Role ${library.roles.length}개, 템플릿 ${library.templates.length}개`,
        library
      );
    },
    async record_goal(input, { run, call, write }) {
      await write(
        await recordGoal(db, run, input, call("연구 목표와 완료 기준 기록"))
      );
    },
    async request_initial_approval(input, { run, call, write }) {
      const heads = input.team.reduce((n, m) => n + m.count, 0);
      await write(
        await insertInitialApprovalRequest(db, run, input, {
          library: await loadHarnessLibrary(harnessDir),
          source: { newId: randomUUID, now },
          ...call(
            `초기 연구 승인 요청: 작업자 ${heads}명, 템플릿 ${input.template}${input.completionCriteria ? ", 완료 기준 제안" : ""}`
          ),
        })
      );
    },
    async create_task(input, { run, call, write }) {
      await write(
        await createTask(db, run, input, {
          source,
          ...call(
            `작업 생성: ${quote(input.title)}${input.parentTaskId ? " (하위 작업)" : ""}${input.researchNodeId ? " (연구 노드 연결)" : ""}`
          ),
        })
      );
    },
    async list_tasks(_input, { run, read }) {
      const list = await listTasks(db, run.organizationId);
      await read(`작업 목록 조회: ${list.length}개`, list);
    },
    async get_task({ taskId }, { run, refuse, read }) {
      const task = await findTaskDetail(db, run.organizationId, taskId);
      // 다른 조직의 작업과 없는 작업은 같은 응답이다.
      if (!task) return refuse(404, "not_found");
      await read(`작업 조회: ${quote(task.title)}`, task);
    },
    async start_task({ taskId }, { run, call, write }) {
      await write(
        await startTask(db, run, taskId, { source, ...call("작업 착수") }),
        200
      );
    },
    async complete_task({ taskId, summary }, { run, call, write }) {
      await write(
        await completeTask(db, run, taskId, summary, {
          source,
          ...call(`작업 완료와 자기 보고 (${chars(summary)}자)`),
        }),
        200
      );
    },
    async comment_task({ taskId, body }, { run, call, write }) {
      await write(
        await commentTask(db, run, taskId, body, {
          source,
          ...call(`작업 댓글 (${chars(body)}자)`),
        })
      );
    },
    async record_artifact(input, { run, call, write }) {
      await write(
        await recordArtifact(db, run, input, {
          source,
          ...call(
            `산출물 기록: ${quote(input.title)} (${input.format}, ${chars(input.content)}자)`
          ),
        })
      );
    },
    async get_artifact({ artifactId }, { run, refuse, read }) {
      const artifact = await findArtifact(db, run.organizationId, artifactId);
      if (!artifact) return refuse(404, "not_found");
      await read(`산출물 조회: ${quote(artifact.title)}`, artifact);
    },
    async message_agent(input, { run, call, write }) {
      await write(
        await sendAgentToAgentMessage(db, run, input, {
          source,
          ...call(`같은 조직 에이전트에게 메시지 (${chars(input.body)}자)`),
        })
      );
    },
    // 승인 정책이 꺼져 있으면 곧바로 작업자를 만들고(201), 켜져 있으면 승인 요청만 남긴다(202).
    async add_worker(input, { run, call, write }) {
      const result = await addWorker(db, run, input, {
        library: await loadHarnessLibrary(harnessDir),
        source,
        ...call(`작업자 추가: ${input.role}`),
      });
      await write(
        result,
        result.kind === "ok" && result.value.status === "pending_approval"
          ? 202
          : 201
      );
    },
    async get_research_map(_input, { run, read }) {
      const map = await getResearchMap(db, run.organizationId);
      await read(
        `연구 지도 조회: 노드 ${map.nodes.length}개, 보조 연결 ${map.links.length}개`,
        map
      );
    },
    async get_research_node({ nodeId }, { run, refuse, read }) {
      const node = await findResearchNodeDetail(db, run.organizationId, nodeId);
      // 다른 조직의 노드와 없는 노드는 같은 응답이다.
      if (!node) return refuse(404, "not_found");
      await read(`연구 노드 조회: ${quote(node.title)}`, node);
    },
    create_research_node: (input, reply) =>
      mapWrite(
        reply,
        { op: "create_node", input },
        `연구 노드 생성: ${input.kind} ${quote(input.title)}${input.parentNodeId ? " (주 부모 지정)" : ""}`,
        201
      ),
    update_research_node: ({ nodeId, ...input }, reply) =>
      mapWrite(
        reply,
        { op: "update_node", nodeId, input },
        `연구 노드 수정: ${Object.keys(input).join(", ")}`
      ),
    assign_research_node_parent: ({ nodeId, parentNodeId }, reply) =>
      mapWrite(
        reply,
        { op: "assign_parent", nodeId, parentNodeId },
        "연구 노드 주 부모 지정"
      ),
    change_research_node_parent: ({ nodeId, parentNodeId }, reply) =>
      mapWrite(
        reply,
        { op: "change_parent", nodeId, parentNodeId },
        parentNodeId ? "연구 노드 주 부모 변경" : "연구 노드 주 부모 없앰"
      ),
    add_research_link: (input, reply) =>
      mapWrite(
        reply,
        { op: "add_link", input },
        `보조 연결 추가: ${input.kind}`,
        201
      ),
    discard_research_node: ({ nodeId }, reply) =>
      mapWrite(reply, { op: "discard_node", nodeId }, "연구 노드 폐기"),
    restore_research_node: ({ nodeId }, reply) =>
      mapWrite(reply, { op: "restore_node", nodeId }, "연구 노드 폐기 취소"),
    link_task_research_node: ({ taskId, researchNodeId }, reply) =>
      mapWrite(
        reply,
        { op: "link_task", taskId, researchNodeId },
        "작업을 연구 노드에 연결"
      ),
    relink_task_research_node: ({ taskId, researchNodeId }, reply) =>
      mapWrite(
        reply,
        { op: "relink_task", taskId, researchNodeId },
        "작업을 다른 연구 노드로 재연결"
      ),
    unlink_task_research_node: ({ taskId }, reply) =>
      mapWrite(
        reply,
        { op: "unlink_task", taskId },
        "작업의 연구 노드 연결 해제"
      ),
    async submit_result(input, { run, call, write }) {
      await write(
        await submitResult(db, run, input, {
          source,
          ...call(
            `결과 제출: 요약 ${chars(input.summary)}자, 근거 산출물 ${input.artifactIds.length}개`
          ),
        })
      );
    },
    // 기억 범위의 조직·에이전트와 출처는 토큰의 실행 시도에서만 정한다. 입력은 조직 기억인지 자기 에이전트 기억인지뿐이다.
    async write_memory(input, { run, call, write }) {
      await write(
        await writeMemory(db, run, input, {
          source,
          ...call(
            `${scopeLabel[input.scope]} 쓰기 (${chars(input.content)}자)`
          ),
        })
      );
    },
    async recall_memory({ scope, query, limit }, { run, read }) {
      const found = await dbMemory(db, source).recall(
        memoryScopeOf(run, scope),
        { text: query, limit }
      );
      await read(
        `${scopeLabel[scope]} 회수: ${found.length}개${query ? `, 검색어 ${chars(query)}자` : ""}${limit === memoryRecallLimitDefault ? "" : `, 최대 ${limit}개`}`,
        found
      );
    },
  };

  for (const name of orgToolNames) {
    const { method, path, input: schema } = orgTools[name];
    const route: express.RequestHandler = async (req, res) => {
      const run = res.locals.run as ActiveRun;
      const gate = await gateToolCall(db, run, name);
      if (!gate) return refuse(res, 401, "invalid_token");
      if (!gate.ok) {
        await applyAfterCommit({ hub, dispatcher }, gate.after);
        return refuseByRule(res, gate.reason);
      }
      let operation: ToolOperation | undefined;
      if (!isOrgToolRead(name)) {
        const found = operationOf(req);
        if (found === false) return refuse(res, 422, "invalid_input");
        operation = found;
      }
      const input = schema.safeParse(inputOf(name, req));
      if (!input.success) return refuse(res, 422, "invalid_input");
      const handler = handlers[name] as (
        input: unknown,
        reply: ToolReply
      ) => Promise<void>;
      await handler(input.data, {
        run,
        refuse: (status, code) => void refuse(res, status, code),
        read: async (summary, value) => {
          if (!(await recordRead(run, name, summary)))
            return void refuse(res, 401, "invalid_token");
          res.json(value);
        },
        call: (summary) => ({
          activity: toolActivity(name, summary),
          operation,
        }),
        write: async (result, status) =>
          void (await respondWrite(res, result, status)),
      });
    };
    router[method.toLowerCase() as Lowercase<typeof method>](path, route);
  }

  router.use((_req, res) => refuse(res, 404, "not_found"));
  return router;
}
