import { relayIdentityHeaders } from "@babojubot/runtime";
import { WorkspaceIdentityError, type Workspaces } from "./workspace.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  explicitProposedChoice,
  idempotencyKeyHeader,
  idempotencyKeySchema,
  isOrgToolRead,
  memoryRecallLimitDefault,
  orgToolErrorMessages,
  orgToolNames,
  orgTools,
  type OrgToolErrorCode,
  type OrgToolName,
  type OrgToolParsedInput,
  type AgentRecoveryBlockReason,
  type ArtifactFileRead,
  type IntentRequest,
  type PublicActivity,
  type ToolRefusalReason,
} from "@babojubot/contracts";
import { availableOrgTools, memoryScopeOf } from "@babojubot/core";
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
  recordRunToolCatalog,
  sendAgentToAgentMessage,
  startTask,
  submitResult,
  writeMemory,
  writeResearchMap,
  type ActiveRun,
  taskInOrganization,
  type Database,
  type MapCommand,
  acceptIntent,
  decodeIntentRequest,
  findIntent,
  findIntentByKey,
  IntentMismatchError,
  findActiveRun,
  type StoredIntent,
  type ToolCall,
  type ToolWrite,
} from "@babojubot/db";
import express from "express";
import { mcpRoutes } from "./mcp.ts";
import { applyAfterCommit } from "./after-commit.ts";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";
import { listHarnessLibrary, loadHarnessLibrary } from "./harness.ts";
import type { ProviderRegistry } from "./providers.ts";
import { digestRunToken } from "./run-token.ts";
import { problemResponses, type ToolProblem } from "./problems.ts";

/** Transport-neutral invocation, retaining the original HTTP representation for existing receipts. */
export type ToolRequest = {
  params: Record<string, unknown>;
  body: unknown;
  query: unknown;
  key: unknown;
};
export type ToolResponse = { status: number; value: unknown };
export type ToolDispatch = (
  name: OrgToolName,
  run: ActiveRun,
  request: ToolRequest
) => Promise<ToolResponse>;

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
  /** 쓰기 도구: 실행 의도를 수락할 때 고정한 원본 자료(`record_artifact`의 파일 읽기 결과). 없으면 `undefined`. */
  source: unknown;
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
  providers,
  workspaces,
}: {
  db: Database;
  hub: EventHub;
  dispatcher: RunDispatcher;
  now: () => Date;
  harnessDir: string;
  providers: ProviderRegistry;
  workspaces: Workspaces;
}): { router: express.Router; settle: IntentSettler } {
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
    // 격리 실행의 중계는 요청에 그 실행 시도의 신원을 덮어써 넣는다(#149). 다른 실행 시도·조직의 토큰은 그 중계로 쓰지 못한다.
    const relayOrganization = req.headers[relayIdentityHeaders.organization];
    if (
      relayOrganization !== undefined &&
      (relayOrganization !== run.organizationId ||
        req.headers[relayIdentityHeaders.run] !== run.id)
    )
      return refuse(res, 401, "invalid_token");
    res.locals.run = run;
    next();
  });

  const failure = (status: number, code: OrgToolErrorCode): ToolResponse => ({
    status,
    value: {
      error: {
        code,
        ...(orgToolErrorMessages[code]
          ? { message: orgToolErrorMessages[code] }
          : {}),
      },
    },
  });
  const refuseByRule = (reason: ToolRefusalReason) =>
    reason === "role"
      ? failure(403, "forbidden")
      : failure(409, "stage_closed");
  /**
   * 쓰기 도구의 `Idempotency-Key` header. 없으면 `null`, 계약 밖이면 `false`.
   * 같은 키에 다른 입력이 오는지는 경로 변수와 본문의 JSON 표기(실행 의도가 고정하는 입력)의 digest로 가린다.
   */
  const keyOf = (req: ToolRequest): string | null | false => {
    if (req.key === undefined) return null;
    const key = idempotencyKeySchema.safeParse(req.key);
    return key.success ? key.data : false;
  };
  const digestOf = (request: string) =>
    createHash("sha256").update(request).digest("hex");
  /**
   * 경로 변수와 본문(GET이면 query)을 도구 입력 하나로 합친다. 입력이 경로 변수뿐인 읽기 도구는 query를 읽지 않는다.
   * 본문이 객체가 아니거나 경로 변수와 같은 이름의 칸이 있으면 계약 밖이다(`undefined`).
   */
  const inputOf = (tool: OrgToolName, req: ToolRequest) => {
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
    result: ToolWrite<T, P>,
    status = 201
  ): Promise<ToolResponse> => {
    switch (result.kind) {
      case "ok":
        await applyAfterCommit(
          { hub, dispatcher, ensureWorkspace: (id) => workspaces.ensure(id) },
          result.after
        );
        return { status, value: result.value };
      case "run_finished":
        return failure(401, "invalid_token");
      case "refused":
        await applyAfterCommit(
          { hub, dispatcher, ensureWorkspace: (id) => workspaces.ensure(id) },
          result.after
        );
        return refuseByRule(result.reason);
      case "invalid": {
        const [code, httpStatus] = problemResponses[result.problem];
        return failure(httpStatus, code);
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
    async list_providers(_input, { read }) {
      const catalog = await providers.catalog(db);
      await read(
        `프로바이더 목록 조회: 연결 ${catalog.providers.length}개`,
        catalog
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
          connections: await providers.modelsFor(
            input.team.flatMap((m) => explicitProposedChoice(m) ?? [])
          ),
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
    // 파일 경로 산출물은 실행 의도를 수락하기 전에 읽어 고정한 내용으로 기록한다(`prepare`). 그 뒤 경로의 파일이 바뀌거나 사라져도 다시 읽지 않는다.
    async record_artifact(input, { run, call, write, source: fixed }) {
      await write(
        await recordArtifact(db, run, input, {
          source,
          file: (fixed ?? null) as ArtifactFileRead | null,
          ...call(
            `산출물 기록: ${quote(input.title)} (${input.path ? "파일" : `${input.format}, ${chars(input.content!)}자`})`
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
    // Lead가 적은 프로바이더·모델은 하네스 라이브러리처럼 잠금 밖에서 받아 온 모델 목록으로 저장 규칙 안에서 확인한다.
    // 그래서 같은 호출 키의 재시도는 목록이 바뀌었어도 저장된 결과를 받는다(초기 연구 승인 요청도 같다).
    async add_worker(input, { run, call, write }) {
      const choice = explicitProposedChoice(input);
      const result = await addWorker(db, run, input, {
        library: await loadHarnessLibrary(harnessDir),
        connections: await providers.modelsFor(choice ? [choice] : []),
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

  /** 처리 함수 하나를 부른다. 쓰기 도구면 정산할 실행 의도와 그 원본 자료를 함께 넘긴다. */
  const handle = async (
    name: OrgToolName,
    run: ActiveRun,
    input: unknown,
    intent?: { id: string; source: unknown }
  ): Promise<ToolResponse> => {
    const handler = handlers[name] as (
      input: unknown,
      reply: ToolReply
    ) => Promise<void>;
    let response: ToolResponse | undefined;
    await handler(input, {
      run,
      source: intent?.source ?? undefined,
      refuse: (status, code) => {
        response = failure(status, code);
      },
      read: async (summary, value) => {
        response = (await recordRead(run, name, summary))
          ? { status: 200, value }
          : failure(401, "invalid_token");
      },
      call: (summary) => ({
        activity: toolActivity(name, summary),
        ...(intent ? { operation: { intentId: intent.id } } : {}),
      }),
      write: async (result, status) => {
        response = await respondWrite(result, status);
      },
    });
    if (!response) throw new Error("tool returned no response");
    return response;
  };

  /** 실행 의도가 고정한 입력을 도구 입력으로. 계약 밖이면 `undefined`. */
  const intentInput = (name: OrgToolName, request: IntentRequest) => {
    const { params, body } = request;
    const input = orgTools[name].input.safeParse(
      inputOf(name, { params, body, query: body, key: undefined })
    );
    return input.success ? input.data : undefined;
  };

  /**
   * 조직 도구 호출 하나. HTTP와 MCP가 같이 쓴다. 읽기는 Role·단계 검사 뒤 처리하고, 쓰기는 실행 의도(GLOSSARY)로 처리한다(`write`).
   */
  const dispatch: ToolDispatch = async (name, run, req) => {
    if (!isOrgToolRead(name)) return write(name, run, req);
    const gate = await gateToolCall(db, run, name);
    if (!gate) return failure(401, "invalid_token");
    if (!gate.ok) {
      await applyAfterCommit({ hub, dispatcher }, gate.after);
      return refuseByRule(gate.reason);
    }
    const input = orgTools[name].input.safeParse(inputOf(name, req));
    if (!input.success) return failure(422, "invalid_input");
    return handle(name, run, input.data);
  };

  /**
   * 쓰기 도구 호출 하나를 실행 의도로 처리한다. 순서는 이 함수만 정하며 전송(HTTP·MCP)은 조립하지 않는다.
   * 1. 같은 호출 키의 의도가 이미 있으면 도구·입력이 같은지만 보고(다르면 409 `idempotency_conflict`) 그 의도를 처리한다. 정산한 의도는
   *    지금 단계가 그 쓰기를 막아도 최초 결과를 돌려주고 아무것도 다시 남기지 않는다(새 쓰기가 아님). 처음 조회와 단계 검사 사이에 의도가
   *    정산되고 단계가 바뀌어도 마찬가지로 최초 결과를 받는다. 토큰은 언제나 지금 실행 시도의 것이어야 한다.
   * 2. 새 쓰기는 Role·단계와 입력, 도구별 사전 확인(`prepare`)을 통과해야 한다. 그다음 원본 자료(파일 경로 산출물이면 그 파일)를
   *    어떤 DB 잠금도 쥐지 않은 채 준비한다. 준비가 오래 걸려도 사용자 제어는 기다리지 않는다.
   * 3. 준비한 입력·원본 자료를 고정해 의도를 수락한다(commit). 그사이 실행 시도가 취소·종료됐으면 401이며 아무것도 남기지 않는다.
   *    같은 키를 다른 호출이 먼저 수락했으면 그 의도와 원본 자료를 쓴다.
   * 4. 효과와 최초 결과를 한 transaction으로 정산한다(db `toolWrite`). 그때 실행 시도·Role·단계·작업 소속 등을 잠금 아래에서 다시 본다.
   *    정산이 실패해도 수락한 의도와 원본 자료는 남아 같은 키의 재전송이나 서버 재시작 뒤 복구가 그것으로 정산한다.
   * 준비가 던지면(파일을 읽지 못한 서버 쪽 문제) 그 사이 같은 키의 의도를 다른 호출이 수락했는지 본다. 있으면 그 의도를 1처럼 처리하고,
   * 없으면 원래 오류를 그대로 던지며 의도를 남기지 않는다. 조직 폴더 표식 오류는 이렇게 합치지 않고 그대로 던진다.
   * 키 없이 온 쓰기도 의도로 남긴다. 서버 재시작 뒤 다음 실행 시도가 그 결과를 받지만, 키가 없으니 같은 호출의 재전송은 가리지 못한다.
   */
  const write = async (
    name: OrgToolName,
    run: ActiveRun,
    req: ToolRequest
  ): Promise<ToolResponse> => {
    const key = keyOf(req);
    if (key === false) return failure(422, "invalid_input");
    const fixed = { params: req.params, body: req.body ?? null };
    const request = JSON.stringify(fixed);
    const digest = digestOf(request);
    const settleIntent = async (intent: StoredIntent) => {
      // 충돌 응답보다 실행 신원이 먼저다. 취소·종료된 실행 시도는 같은 키에 무엇이 있는지도 받지 않는다.
      if (intent.tool !== name || intent.digest !== digest)
        return (await findActiveRun(db, run.id))
          ? failure(409, "idempotency_conflict")
          : failure(401, "invalid_token");
      // 이 기능 전에 남은 기록은 입력을 고정하지 않았다. digest가 같으므로 이번 입력과 같다. 저장된 표기를 읽을 수 없어도 마찬가지다.
      const input = intentInput(
        name,
        decodeIntentRequest(intent.request) ?? fixed
      );
      if (input === undefined) return failure(422, "invalid_input");
      return handle(name, run, input, intent);
    };
    const existing =
      key === null ? undefined : await findIntentByKey(db, run.agentId, key);
    if (existing) return settleIntent(existing);
    const gate = await gateToolCall(db, run, name, key);
    if (!gate) return failure(401, "invalid_token");
    if (!gate.ok) {
      await applyAfterCommit({ hub, dispatcher }, gate.after);
      return refuseByRule(gate.reason);
    }
    const input = orgTools[name].input.safeParse(inputOf(name, req));
    if (!input.success) return failure(422, "invalid_input");
    let prepared: Prepared;
    try {
      prepared = await prepare(name, run, input.data);
    } catch (error) {
      if (key === null || error instanceof WorkspaceIdentityError) throw error;
      const winner = await findIntentByKey(db, run.agentId, key);
      if (!winner) throw error;
      return settleIntent(winner);
    }
    if (prepared.kind === "refused") return prepared.response;
    const accepted = await acceptIntent(db, run, {
      key,
      tool: name,
      request,
      digest,
      source: prepared.source,
    });
    if (accepted.kind === "run_finished") return failure(401, "invalid_token");
    return settleIntent(accepted.intent);
  };

  /** 새 쓰기의 준비 결과: 수락할 때 고정할 원본 자료, 또는 의도 없이 돌려줄 거부. */
  type Prepared =
    | { kind: "ready"; source: unknown }
    | { kind: "refused"; response: ToolResponse };

  /**
   * 새 쓰기의 도구별 사전 확인과 원본 자료 준비. DB 잠금 밖에서 돈다. 산출물은 연결 작업이 이 조직의 것인지 먼저 보고(다른 조직의 작업과
   * 없는 작업은 같은 404이며 파일을 읽지 않는다), 파일 경로가 있으면 지금 경로의 파일을 경로 격리·변경 감지 규칙대로 읽는다.
   * 읽기의 거부는 고정할 수 있는 결과라 원본 자료가 되고, 정산이 효과 없는 확정 거절로 남긴다. 다른 도구는 원본 자료가 없다.
   */
  const prepare = async (
    name: OrgToolName,
    run: ActiveRun,
    input: unknown
  ): Promise<Prepared> => {
    if (name !== "record_artifact") return { kind: "ready", source: null };
    const artifact = input as OrgToolParsedInput<"record_artifact">;
    if (!(await taskInOrganization(db, run.organizationId, artifact.taskId))) {
      return {
        kind: "refused",
        response: await respondWrite({ kind: "invalid", problem: "not_found" }),
      };
    }
    return {
      kind: "ready",
      source:
        artifact.path === undefined
          ? null
          : await workspaces.readArtifact(run.organizationId, artifact.path),
    };
  };

  /**
   * 서버 재시작으로 끝난 실행 시도가 수락한 실행 의도를 새 실행 시도(`run`)로 정산한다. 모델을 부르기 전에 dispatcher가 부른다.
   * 지금 Role·단계·승인 규칙과 조직·에이전트 제어를 그대로 거치므로 막힌 쓰기는 효과 없이 확정 거절된다. 입력은 수락 때 고정한 것이고,
   * 파일 경로 산출물은 그때 읽은 내용이다. 고정한 입력을 읽을 수 없거나 원본 자료가 없거나 기록이 맞지 않으면 `blocked`이며 아무것도 하지 않는다.
   * 정산 중 실행 시도가 끝나면(사용자 제어 취소) `run_finished`다. 일시적 오류는 던지고 호출자가 다시 시도한다.
   */
  const settle: IntentSettler = async (intent, run) => {
    const name = intent.tool as OrgToolName;
    if (
      !orgToolNames.includes(name) ||
      isOrgToolRead(name) ||
      intent.organizationId !== run.organizationId ||
      intent.agentId !== run.agentId
    )
      return { kind: "blocked", reason: "inconsistent_record" };
    const fixed = decodeIntentRequest(intent.request);
    if (fixed === null)
      return { kind: "blocked", reason: "inconsistent_record" };
    const input = intentInput(name, fixed);
    if (input === undefined)
      return { kind: "blocked", reason: "inconsistent_record" };
    if (
      name === "record_artifact" &&
      (input as { path?: string }).path !== undefined &&
      (intent.source === null || intent.source === undefined)
    )
      return { kind: "blocked", reason: "missing_source" };
    try {
      await handle(name, run, input, intent);
    } catch (error) {
      if (error instanceof IntentMismatchError)
        return { kind: "blocked", reason: "inconsistent_record" };
      throw error;
    }
    const after = await findIntent(db, intent.id);
    if (after?.status !== "accepted") return { kind: "settled" };
    return (await findActiveRun(db, run.id))
      ? { kind: "blocked", reason: "inconsistent_record" }
      : { kind: "run_finished" };
  };

  mcpRoutes(router, dispatch, async (run) => {
    const org = await loadRunContext(db, run.id);
    const tools = org
      ? availableOrgTools({
          role: run.agentRole,
          stage: org.context.organization.stage,
        })
      : [];
    await recordRunToolCatalog(db, run.id, tools);
    return tools;
  });

  for (const name of orgToolNames) {
    const { method, path } = orgTools[name];
    router[method.toLowerCase() as Lowercase<typeof method>](
      path,
      async (req, res) => {
        const result = await dispatch(name, res.locals.run as ActiveRun, {
          params: req.params,
          body: req.body,
          query: req.query,
          key: req.headers[idempotencyKeyHeader],
        });
        res.status(result.status).json(result.value);
      }
    );
  }

  router.use((_req, res) => refuse(res, 404, "not_found"));
  return { router, settle };
}

/** 복구 정산 하나의 결과(`orgToolsRouter`의 `settle`). */
export type IntentSettlement =
  | { kind: "settled" }
  | { kind: "run_finished" }
  | { kind: "blocked"; reason: AgentRecoveryBlockReason };
export type IntentSettler = (
  intent: StoredIntent,
  run: ActiveRun
) => Promise<IntentSettlement>;
