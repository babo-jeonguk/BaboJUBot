import { z } from "zod";
import {
  addWorkerInputSchema,
  addWorkerResultSchema,
  approvalSchema,
  recordGoalInputSchema,
  requestInitialApprovalInputSchema,
} from "./approval.ts";
import { harnessLibrarySchema } from "./harness.ts";
import { providerCatalogSchema } from "./provider.ts";
import {
  memoryEntryListSchema,
  memoryEntrySchema,
  recallMemoryInputSchema,
  writeMemoryInputSchema,
} from "./memory.ts";
import {
  conversationMessageSchema,
  sendAgentMessageInputSchema,
} from "./message.ts";
import {
  organizationSchema,
  type AgentRole,
  type LifecycleStage,
} from "./organization.ts";
import { resultSubmissionSchema, submitResultInputSchema } from "./result.ts";
import {
  addTaskCommentInputSchema,
  agentToAgentMessageSchema,
  artifactSchema,
  completeTaskInputSchema,
  createTaskInputSchema,
  recordArtifactInputSchema,
  sendAgentToAgentMessageInputSchema,
  startTaskInputSchema,
  taskCommentSchema,
  taskDetailSchema,
  taskListSchema,
  taskSchema,
} from "./task.ts";
import {
  addResearchLinkInputSchema,
  assignResearchNodeParentInputSchema,
  changeResearchNodeParentInputSchema,
  createResearchNodeInputSchema,
  emptyCommandInputSchema,
  linkTaskResearchNodeInputSchema,
  researchLinkSchema,
  researchMapSchema,
  researchNodeDetailSchema,
  researchNodeSchema,
  updateResearchNodeInputSchema,
} from "./research-map.ts";
import {
  runContextSchema,
  runIdentitySchema,
  wakeReasonSchema,
} from "./run.ts";

// Agent → Control Plane 조직 도구 계약. 모든 도구는 `Authorization: Bearer <실행 시도별 토큰>`으로 호출하고,
// 조직·에이전트·실행 시도는 토큰에서만 정한다. 도구 입력에는 조직을 고르는 값이 없다.
// 도구 하나의 사실(이름·모델이 읽을 영어 설명·입력·출력·HTTP 방식·열린 Role·생애주기 단계)은 아래 `orgTools`의 한 줄에 있다.
// 목록에 있거나 프로바이더에 보였다고 권한이 생기지 않는다. 판정은 core `checkToolCall` 한 곳이 이 줄의 Role·단계 데이터로 하고,
// 서버는 호출마다 다시 검사한다. 쓰기의 잠금 아래 재검사·조직별 승인 정책·조직 경계는 이 목록 밖에 있다.
// 승인 결정·최종 완료·승인 정책 변경은 사용자 제어 명령이며 조직 도구가 없다. Lead는 결과 제출까지만 한다.

export const orgToolsBasePath = "/api/tools";

/** 읽기 도구는 GET, 기록을 남기는 도구는 POST, 기존 기록의 일부 필드를 고치는 도구는 PATCH. 읽기/쓰기는 이 방식에서 정한다. */
export type OrgToolMethod = "GET" | "POST" | "PATCH";

/** 도구가 열리는 생애주기 단계. `any`면 모든 단계다. */
export type OrgToolStages = readonly LifecycleStage[] | "any";

/** 사용자에게 보이는 입력 칸의 설명 끝에 붙는 문장. 에이전트는 영어로 일하고 사용자가 보는 글만 한국어로 쓴다. */
export const ownerFacingFieldNote = "Write in Korean.";

/** 칸이 없는 본문(`z.object({})`)의 타입 `Record<string, never>`를 빈 객체로 본다. 경로 변수와 합칠 수 있게 한다. */
type NoIndex<T> = string extends keyof T ? Record<never, never> : T;

/** 경로(`/tasks/:taskId/complete`)의 경로 변수 이름. */
type PathParams<P extends string> = P extends `${string}:${infer N}/${infer R}`
  ? N | PathParams<`/${R}`>
  : P extends `${string}:${infer N}`
    ? N
    : never;

type OrgToolLine<
  P extends string,
  B extends z.ZodObject,
  O extends z.ZodType,
> = {
  /** 모델이 읽을 설명: 하는 일, 돌려주는 것, 남기는 기록, 비슷한 도구와의 차이, 거부 조건과 회복 방법. */
  description: string;
  method: OrgToolMethod;
  path: P;
  /** 경로 변수마다 모델이 읽을 설명. 경로 변수는 그 조직 안의 기록 ID뿐이다. */
  params: { [K in PathParams<P>]: string };
  /** 본문(GET이면 query) 계약. 사용자 HTTP와 같은 계약을 쓴다. */
  body: B;
  /** 본문 칸마다 모델이 읽을 설명: 뜻, 형식, 선택 칸을 채우는 조건. */
  fields: { [K in keyof B["shape"]]: string };
  /** 사용자에게 보이는 칸. 설명 끝에 {@link ownerFacingFieldNote}가 붙는다. */
  ownerFacing?: readonly (keyof B["shape"] & string)[];
  output: O;
  roles: readonly AgentRole[];
  stages: OrgToolStages;
};

/**
 * 도구 한 줄. `input`은 경로 변수와 본문(GET이면 query) 칸을 합친 하나의 입력이며, 칸 설명이 붙어 있다.
 * 서버와 도구 client가 `params`의 이름으로 입력을 경로 변수와 나머지로 나눈다.
 */
function orgTool<P extends string, B extends z.ZodObject, O extends z.ZodType>(
  line: OrgToolLine<P, B, O>
) {
  const ownerFacing: readonly string[] = line.ownerFacing ?? [];
  const fields = Object.fromEntries(
    Object.entries<string>(line.fields).map(([name, text]) => [
      name,
      (line.body.shape[name] as z.ZodType).describe(
        ownerFacing.includes(name) ? `${text} ${ownerFacingFieldNote}` : text
      ),
    ])
  );
  const params = Object.fromEntries(
    Object.entries<string>(line.params).map(([name, text]) => [
      name,
      z.string().min(1).describe(text),
    ])
  );
  type Params = { [K in PathParams<P>]: string };
  const input = line.body.safeExtend({
    ...fields,
    ...params,
  }) as unknown as z.ZodType<
    NoIndex<z.output<B>> & Params,
    NoIndex<z.input<B>> & Params
  >;
  return {
    description: line.description,
    method: line.method,
    path: line.path,
    params: Object.keys(line.params) as PathParams<P>[],
    /** 본문(GET이면 query) 칸 이름. 경로 변수뿐인 읽기 도구는 비어 있다. */
    bodyFields: Object.keys(line.fields) as readonly string[],
    input,
    output: line.output,
    roles: line.roles,
    stages: line.stages,
    ownerFacing,
  };
}

const everyone = ["lead", "worker"] as const;
const leadOnly = ["lead"] as const;
const researching = ["researching"] as const;
/** 입력이 경로 변수뿐인 읽기 도구의 본문. query는 읽지 않는다. */
const noQuery = z.object({});

/** 내 실행 맥락 조회 응답: 실행 시도 요청과 같은 신원·깨우기 사유 묶음·맥락 묶음. */
export const runContextResponseSchema = z.object({
  identity: runIdentitySchema,
  wakeReasons: z.array(wakeReasonSchema),
  context: runContextSchema,
});
export type RunContextResponse = z.infer<typeof runContextResponseSchema>;

const nodeIdParam = { nodeId: "ID of the research node." } as const;
const taskIdParam = { taskId: "ID of the task." } as const;
const nodeTitle = "Node title.";
const nodeBody = "Node content in Markdown.";

/**
 * 조직 도구 목록. Role·단계 데이터: `목표 설정`·`계획 수립`·`승인 대기`에는 조회·메시지·계획 도구만 열리고,
 * 작업·산출물·연구 지도·에이전트 간 메시지 쓰기, 작업자 추가와 결과 제출은 `연구 진행`에서만 열린다. 작업·산출물·연구 지도 조회는 언제나 열린다.
 * 그래서 `결과 검토 중`·`최종 완료`에는 조회, Lead 대화 답장과 기억(쓰기 포함)만 남는다. 기억은 연구 기록이 아니라서 단계와 상관없이 열린다.
 * 공개 활동 요약은 처리 결과에 달려 있으므로 여기가 아니라 서버의 처리 함수에 있다.
 */
export const orgTools = {
  get_run_context: orgTool({
    description:
      "Returns this run's identity, the wake reasons bundled into it, and its context: the organization (stage, goal, completion criteria), you, the team, the Lead conversations with their delivered messages, and the node and link kinds of the organization's research flow template. It holds what the run request held, read again now. Read it first to see what woke you and who is on the team.",
    method: "GET",
    path: "/run-context",
    params: {},
    body: noQuery,
    fields: {},
    output: runContextResponseSchema,
    roles: everyone,
    stages: "any",
  }),
  // 첫 판은 Lead만 사용자와 대화한다. 작업자는 작업 댓글로만 사용자와 이어진다(docs/features.md).
  send_message: orgTool({
    description:
      "Replies to the Owner in a Lead conversation, records the message there and returns it. Without `conversationId` the reply goes to the conversation of the Owner message this run received, or to the default conversation when the run woke without one. Refused with `invalid_input` when this run received Owner messages from several conversations and no `conversationId` is given, and with `not_found` when the conversation is not in this organization. To reach another agent use `message_agent`; to answer about a task use `comment_task`.",
    method: "POST",
    path: "/messages",
    params: {},
    body: sendAgentMessageInputSchema,
    fields: {
      body: "The reply.",
      conversationId:
        "ID of the conversation to reply in, from `conversations` in the run context. Required when this run received Owner messages from more than one conversation.",
    },
    ownerFacing: ["body"],
    output: conversationMessageSchema,
    roles: leadOnly,
    stages: "any",
  }),
  get_message: orgTool({
    description:
      "Returns one Lead conversation message of this organization. Messages of other organizations and unknown IDs are both `not_found`.",
    method: "GET",
    path: "/messages/:messageId",
    params: { messageId: "ID of the message." },
    body: noQuery,
    fields: {},
    output: conversationMessageSchema,
    roles: everyone,
    stages: "any",
  }),
  get_harness_library: orgTool({
    description:
      "Returns the Roles and research flow templates in the harness library, with each Role's label and Skills and each template's node and link kinds. Choose the team and template for `request_initial_approval`, or the Role for `add_worker`, from this list.",
    method: "GET",
    path: "/harness-library",
    params: {},
    body: noQuery,
    fields: {},
    output: harnessLibrarySchema,
    roles: leadOnly,
    stages: "any",
  }),
  list_providers: orgTool({
    description:
      "Returns the provider connections you can propose for workers, each with its ID, label and models, and the worker default used when you leave a worker's provider out. Read it before you propose workers in `request_initial_approval` or `add_worker`. The Owner can change any proposed provider or model before approving.",
    method: "GET",
    path: "/providers",
    params: {},
    body: noQuery,
    fields: {},
    output: providerCatalogSchema,
    roles: leadOnly,
    stages: "any",
  }),
  // 합의한 목표·완료 기준의 변경은 승인 정책 항목이다(ADR-0003, #58). 그 전에는 목표 설정에서만 기록한다.
  // 새 조직은 생성 때 목표를 받아 계획 수립에서 시작하므로, 이 도구는 목표 없이 만든 예전 조직에만 열린다.
  record_goal: orgTool({
    description:
      "Records the research goal and completion criteria of an organization that was created without a goal, moves it from goal setting to planning, and returns the organization. Organizations created with a goal start in planning and never need it.",
    method: "POST",
    path: "/goal",
    params: {},
    body: recordGoalInputSchema,
    fields: {
      goal: "The research goal the Owner agreed to.",
      completionCriteria:
        "What the result must show for the Owner to accept the research as done.",
    },
    ownerFacing: ["goal", "completionCriteria"],
    output: organizationSchema,
    roles: leadOnly,
    stages: ["goal_setting"],
  }),
  request_initial_approval: orgTool({
    description:
      "Submits the initial research plan, team, research environment specification and research flow template as one approval request to the Owner, moves the organization to awaiting approval, and returns the pending request. Nothing is created before the Owner approves; on approval the team is hired and the template copied to the organization exactly as submitted. When the Owner rejects or requests changes you are woken in planning with their note and submit a new request. Refused with `invalid_input` when a Role or the template is not in the harness library (see `get_harness_library`), and with `unknown_provider` or `unknown_model` when a proposed provider or model is not in `list_providers`.",
    method: "POST",
    path: "/initial-approval",
    params: {},
    body: requestInitialApprovalInputSchema,
    fields: {
      plan: "The research plan in Markdown: the problems, the hypotheses or ideas, how each will be verified, and how the work is split.",
      completionCriteria:
        "Completion criteria you propose. Required when the organization has none (refused with `completion_criteria_required`); leave it out when the organization already has them (refused with `completion_criteria_set`). Becomes the organization's completion criteria once the Owner approves.",
      environment:
        "The research environment specification in Markdown: compute, data, tools, and anything the Owner has to prepare.",
      team: "Workers to hire: each worker Role from the harness library at most once, with how many (1-10), and optionally the `provider` connection ID and `model` ID for those workers from `list_providers`. Leave `provider` out to use the worker default; give `provider` without `model` (or `model: null`) for that provider's default model. `model` needs `provider`.",
      template: "Name of the research flow template in the harness library.",
    },
    ownerFacing: ["plan", "completionCriteria", "environment"],
    output: approvalSchema,
    roles: leadOnly,
    stages: ["planning"],
  }),
  create_task: orgTool({
    description:
      "Creates a task assigned to an agent of this organization, wakes the assignee unless it is you, and returns the task. A task can be a subtask of another task and can be linked to a research node when created. Refused with `not_found` when the assignee, parent task or research node is not in this organization, and with `node_discarded` when the research node is discarded.",
    method: "POST",
    path: "/tasks",
    params: {},
    body: createTaskInputSchema,
    fields: {
      title: "Short task title.",
      description: "What to do and what to hand back. May be empty.",
      assigneeAgentId:
        "ID of the agent to assign, from `team` in the run context.",
      parentTaskId: "ID of the parent task when this is a subtask.",
      researchNodeId: "ID of the research node this task works on.",
    },
    ownerFacing: ["title", "description"],
    output: taskSchema,
    roles: everyone,
    stages: researching,
  }),
  list_tasks: orgTool({
    description:
      "Returns every task of this organization with its status, assignee and completion report. Use `get_task` for the comments and artifacts of one task.",
    method: "GET",
    path: "/tasks",
    params: {},
    body: noQuery,
    fields: {},
    output: taskListSchema,
    roles: everyone,
    stages: "any",
  }),
  get_task: orgTool({
    description:
      "Returns one task with its comments, artifacts and completion report. Tasks of other organizations and unknown IDs are both `not_found`.",
    method: "GET",
    path: "/tasks/:taskId",
    params: taskIdParam,
    body: noQuery,
    fields: {},
    output: taskDetailSchema,
    roles: everyone,
    stages: "any",
  }),
  start_task: orgTool({
    description:
      "Marks an open task assigned to you as in progress and returns the task. Refused with `not_assignee` when you are not the assignee and with `invalid_transition` when the task is no longer open.",
    method: "POST",
    path: "/tasks/:taskId/start",
    params: taskIdParam,
    body: startTaskInputSchema,
    fields: {},
    output: taskSchema,
    roles: everyone,
    stages: researching,
  }),
  complete_task: orgTool({
    description:
      "Completes a task with a self-report, wakes the assignee of its parent task, or the agent that created it when it has no parent (never you), and returns the task. The assignee or the Lead can complete it (`not_assignee` otherwise); a completed task is refused with `already_completed`. The self-report is your account of the work, not a verified result.",
    method: "POST",
    path: "/tasks/:taskId/complete",
    params: taskIdParam,
    body: completeTaskInputSchema,
    fields: {
      summary:
        "Self-report: what was done, what was found, and which artifacts hold the evidence.",
    },
    ownerFacing: ["summary"],
    output: taskSchema,
    roles: everyone,
    stages: researching,
  }),
  // 작업 댓글은 작업자가 사용자에게 답하는 통로다.
  comment_task: orgTool({
    description:
      "Adds a comment to a task and returns the comment. Comments are how a worker answers the Owner about a task; an agent's comment wakes no one and does not change the task's status. Refused with `not_found` when the task is not in this organization.",
    method: "POST",
    path: "/tasks/:taskId/comments",
    params: taskIdParam,
    body: addTaskCommentInputSchema,
    fields: { body: "The comment." },
    ownerFacing: ["body"],
    output: taskCommentSchema,
    roles: everyone,
    stages: researching,
  }),
  record_artifact: orgTool({
    description:
      "Records an artifact on a task of this organization and returns it. Artifacts hold the evidence that `complete_task` reports and `submit_result` cites. Refused with `not_found` when the task is not in this organization.",
    method: "POST",
    path: "/artifacts",
    params: {},
    body: recordArtifactInputSchema,
    fields: {
      taskId: "ID of the task the artifact belongs to.",
      title: "Artifact title.",
      format: "`markdown` or `text`. The content is stored as is.",
      content: "The full artifact content.",
    },
    ownerFacing: ["title", "content"],
    output: artifactSchema,
    roles: everyone,
    stages: researching,
  }),
  get_artifact: orgTool({
    description:
      "Returns one artifact of this organization with its content. Artifacts of other organizations and unknown IDs are both `not_found`.",
    method: "GET",
    path: "/artifacts/:artifactId",
    params: { artifactId: "ID of the artifact." },
    body: noQuery,
    fields: {},
    output: artifactSchema,
    roles: everyone,
    stages: "any",
  }),
  message_agent: orgTool({
    description:
      "Sends a message to another agent of this organization, wakes it, and returns the message. Use it to coordinate with other agents; the Owner is answered with `send_message` or `comment_task` instead. Refused with `invalid_input` when the recipient is you and with `not_found` when the recipient is not in this organization.",
    method: "POST",
    path: "/agent-messages",
    params: {},
    body: sendAgentToAgentMessageInputSchema,
    fields: {
      recipientAgentId:
        "ID of the receiving agent, from `team` in the run context.",
      body: "The message.",
    },
    output: agentToAgentMessageSchema,
    roles: everyone,
    stages: researching,
  }),
  add_worker: orgTool({
    description:
      "Adds one worker with a worker Role from the harness library and returns the outcome. When the organization's approval policy covers adding workers, the outcome is `pending_approval` with the request, and the worker joins only after the Owner approves; otherwise it is `added` with the new agent. Refused with `invalid_input` when the Role is not a worker Role in the harness library (see `get_harness_library`), and with `unknown_provider` or `unknown_model` when the provider or model is not in `list_providers`.",
    method: "POST",
    path: "/workers",
    params: {},
    body: addWorkerInputSchema,
    fields: {
      role: "Name of the worker Role in the harness library.",
      provider:
        "Provider connection ID from `list_providers`. Leave it out to use the worker default.",
      model:
        "Model ID of that provider from `list_providers`. Leave it out or null for the provider's default model. Needs `provider`.",
    },
    output: addWorkerResultSchema,
    roles: leadOnly,
    stages: researching,
  }),
  get_research_map: orgTool({
    description:
      "Returns the research map of this organization: every research node with its kind, status and primary parent, and the secondary links between nodes. Use `get_research_node` for the tasks, artifacts and edit history of one node.",
    method: "GET",
    path: "/research-map",
    params: {},
    body: noQuery,
    fields: {},
    output: researchMapSchema,
    roles: everyone,
    stages: "any",
  }),
  get_research_node: orgTool({
    description:
      "Returns one research node with its linked tasks, their artifacts, and its edit history. Nodes of other organizations and unknown IDs are both `not_found`.",
    method: "GET",
    path: "/research-nodes/:nodeId",
    params: nodeIdParam,
    body: noQuery,
    fields: {},
    output: researchNodeDetailSchema,
    roles: everyone,
    stages: "any",
  }),
  create_research_node: orgTool({
    description:
      "Creates a research node, optionally under a primary parent, records the edit in the map's edit history, and returns the node. The kind must be one the organization's research flow template declares (`researchFlow.nodeKinds` in the run context), otherwise `unknown_kind`. Refused with `not_found` when the parent is not in this organization and with `node_discarded` when it is discarded.",
    method: "POST",
    path: "/research-nodes",
    params: {},
    body: createResearchNodeInputSchema,
    fields: {
      kind: "Node kind name from `researchFlow.nodeKinds`.",
      title: nodeTitle,
      body: `${nodeBody} May be empty.`,
      parentNodeId: "ID of the primary parent node.",
    },
    ownerFacing: ["title", "body"],
    output: researchNodeSchema,
    roles: everyone,
    stages: researching,
  }),
  update_research_node: orgTool({
    description:
      "Changes the title, body or work status of a research node and returns the node; send at least one. Each change is recorded in the map's edit history; sending only the current values records nothing. A discarded node is refused with `node_discarded`; restore it with `restore_research_node` first.",
    method: "PATCH",
    path: "/research-nodes/:nodeId",
    params: nodeIdParam,
    body: updateResearchNodeInputSchema,
    fields: {
      title: nodeTitle,
      body: nodeBody,
      status:
        "Work status: `proposed`, `in_progress`, `done` or `rejected`. Use `discard_research_node` to discard a node.",
    },
    ownerFacing: ["title", "body"],
    output: researchNodeSchema,
    roles: everyone,
    stages: researching,
  }),
  assign_research_node_parent: orgTool({
    description:
      "Sets the primary parent of a node that has none and returns the node. Refused with `primary_parent_exists` when the node already has one (use `change_research_node_parent`), with `primary_cycle` when the parent is the node itself or one of its descendants, and with `node_discarded` when either node is discarded.",
    method: "POST",
    path: "/research-nodes/:nodeId/parent",
    params: nodeIdParam,
    body: assignResearchNodeParentInputSchema,
    fields: { parentNodeId: "ID of the primary parent node." },
    output: researchNodeSchema,
    roles: everyone,
    stages: researching,
  }),
  change_research_node_parent: orgTool({
    description:
      "Replaces or removes the primary parent of a node and returns the node. Refused with `primary_cycle` when the new parent is the node itself or one of its descendants, and with `node_discarded` when either node is discarded.",
    method: "POST",
    path: "/research-nodes/:nodeId/parent/change",
    params: nodeIdParam,
    body: changeResearchNodeParentInputSchema,
    fields: {
      parentNodeId: "ID of the new primary parent node, or null to remove it.",
    },
    output: researchNodeSchema,
    roles: everyone,
    stages: researching,
  }),
  add_research_link: orgTool({
    description:
      "Adds a secondary link from one research node to another and returns the link. The kind must be one the template declares (`researchFlow.linkKinds` in the run context), otherwise `unknown_kind`. Secondary links have no count limit and no cycle check, and the same two nodes can have several; a link from a node to itself is refused with `invalid_input`, and a link to a discarded node with `node_discarded`.",
    method: "POST",
    path: "/research-links",
    params: {},
    body: addResearchLinkInputSchema,
    fields: {
      sourceNodeId: "ID of the node the link starts from.",
      targetNodeId: "ID of the node the link points to.",
      kind: "Link kind name from `researchFlow.linkKinds`.",
    },
    output: researchLinkSchema,
    roles: everyone,
    stages: researching,
  }),
  discard_research_node: orgTool({
    description:
      "Discards a research node instead of deleting it and returns the node. Its children, links and linked tasks stay, and its status before discarding is kept so `restore_research_node` can bring it back; until then the node cannot be edited or linked to. Discarding a discarded node changes nothing.",
    method: "POST",
    path: "/research-nodes/:nodeId/discard",
    params: nodeIdParam,
    body: emptyCommandInputSchema,
    fields: {},
    output: researchNodeSchema,
    roles: everyone,
    stages: researching,
  }),
  restore_research_node: orgTool({
    description:
      "Restores a discarded research node to the status it had before it was discarded and returns the node. Restoring a node that is not discarded changes nothing.",
    method: "POST",
    path: "/research-nodes/:nodeId/restore",
    params: nodeIdParam,
    body: emptyCommandInputSchema,
    fields: {},
    output: researchNodeSchema,
    roles: everyone,
    stages: researching,
  }),
  link_task_research_node: orgTool({
    description:
      "Links a task to a research node and returns the task. A task links to at most one node: refused with `task_already_linked` when it already has one (use `relink_task_research_node`), and with `node_discarded` when the node is discarded.",
    method: "POST",
    path: "/tasks/:taskId/research-node",
    params: taskIdParam,
    body: linkTaskResearchNodeInputSchema,
    fields: { researchNodeId: "ID of the research node." },
    output: taskSchema,
    roles: everyone,
    stages: researching,
  }),
  relink_task_research_node: orgTool({
    description:
      "Links a task to another research node, replacing its current link if it has one, and returns the task. Refused with `node_discarded` when the new node is discarded.",
    method: "POST",
    path: "/tasks/:taskId/research-node/relink",
    params: taskIdParam,
    body: linkTaskResearchNodeInputSchema,
    fields: { researchNodeId: "ID of the new research node." },
    output: taskSchema,
    roles: everyone,
    stages: researching,
  }),
  unlink_task_research_node: orgTool({
    description:
      "Removes a task's research node link and returns the task. The node itself stays; a task with no link is returned unchanged. To move the task to another node use `relink_task_research_node` instead.",
    method: "POST",
    path: "/tasks/:taskId/research-node/unlink",
    params: taskIdParam,
    body: emptyCommandInputSchema,
    fields: {},
    output: taskSchema,
    roles: everyone,
    stages: researching,
  }),
  // 결과 제출은 Lead의 판단이다. 최종 완료는 사용자 결정뿐이라 도구가 없다.
  submit_result: orgTool({
    description:
      "Submits the research result for the Owner's review once you judge the completion criteria met, moves the organization to result review, and returns the submission. The Owner either requests changes (you are woken with their note and research resumes) or completes the research; only the Owner can complete it. Refused with `not_found` when an artifact is not in this organization.",
    method: "POST",
    path: "/results",
    params: {},
    body: submitResultInputSchema,
    fields: {
      summary:
        "Result summary: how the completion criteria are met, pointing at the evidence.",
      artifactIds:
        "IDs of the evidence artifacts of this organization, in the order to show them, each at most once.",
    },
    ownerFacing: ["summary"],
    output: resultSubmissionSchema,
    roles: leadOnly,
    stages: researching,
  }),
  // 기억은 연구 기록이 아니라 에이전트가 다시 꺼내 쓰는 맥락이다. 단계와 상관없이 자기 조직·자기 에이전트 범위에서만 쓴다.
  write_memory: orgTool({
    description:
      "Saves a memory entry for later runs and returns it. `organization` memory is shared with every agent of this organization; `agent` memory is yours alone. Memory is context to recall, not a research record: record research in tasks, artifacts and research nodes.",
    method: "POST",
    path: "/memories",
    params: {},
    body: writeMemoryInputSchema,
    fields: {
      scope: "`organization` or `agent`.",
      content: "What to remember.",
    },
    output: memoryEntrySchema,
    roles: everyone,
    stages: "any",
  }),
  recall_memory: orgTool({
    description:
      "Returns the memory entries of one scope that you can read, newest first, optionally filtered by text.",
    method: "GET",
    path: "/memories",
    params: {},
    body: recallMemoryInputSchema,
    fields: {
      scope: "`organization` or `agent`.",
      query:
        "Case-insensitive text the entry must contain, taken literally (`%` and `_` are plain characters). Empty matches every entry.",
      limit: "Maximum number of entries, 1-50. Defaults to 20.",
    },
    output: memoryEntryListSchema,
    roles: everyone,
    stages: "any",
  }),
};

export type OrgToolName = keyof typeof orgTools;
export const orgToolNames = Object.keys(orgTools) as [
  OrgToolName,
  ...OrgToolName[],
];
export const orgToolNameSchema = z.enum(orgToolNames);

/** 도구 client가 보내는 입력(기본값을 채우기 전). */
export type OrgToolInput<T extends OrgToolName> = z.input<
  (typeof orgTools)[T]["input"]
>;
/** 서버가 검사를 통과시킨 입력. */
export type OrgToolParsedInput<T extends OrgToolName> = z.output<
  (typeof orgTools)[T]["input"]
>;
export type OrgToolOutput<T extends OrgToolName> = z.output<
  (typeof orgTools)[T]["output"]
>;

/** 읽기 도구인가. 읽기는 기록을 남기지 않고 같은 호출 키를 받지 않는다. */
export const isOrgToolRead = (tool: OrgToolName) =>
  orgTools[tool].method === "GET";

/**
 * 도구 입력 하나를 HTTP 요청으로 나눈다: 경로 변수를 채운 경로와, 본문(GET이면 query)으로 보낼 나머지 칸.
 * 서버는 같은 이름으로 둘을 다시 합친다.
 */
export function splitOrgToolInput(
  tool: OrgToolName,
  input: Record<string, unknown>
): { path: string; rest: Record<string, unknown> } {
  const { path, params } = orgTools[tool];
  const rest = { ...input };
  let filled: string = path;
  for (const name of params as readonly string[]) {
    filled = filled.replace(`:${name}`, encodeURIComponent(String(rest[name])));
    delete rest[name];
  }
  return { path: filled, rest };
}

/**
 * 같은 효과를 한 번만 남기는 호출 키. GET이 아닌 모든 쓰기 도구는 `Idempotency-Key` header를 받으며, 그 에이전트의 같은 키는
 * 처음 저장한 결과를 그대로 돌려주고 기록·Event·깨우기를 다시 남기지 않는다. 서버 재시작 뒤 같은 깨우기를 다시 받은 실행 시도가
 * 이미 남긴 답장·작업·기억 등을 되풀이하지 않게 한다. 같은 키로 다른 도구나 다른 입력(경로 변수·본문)을 보내면 409 `idempotency_conflict`다.
 * 키는 효과 하나를 가리키도록 호출하는 쪽이 정하며, 실행 시도 ID처럼 다시 시도할 때 바뀌는 값으로 정하면 중복을 막지 못한다.
 * 키와 결과는 지우지 않는다. 외부 효과(조직 도구 밖의 일)의 중복은 막지 않는다.
 */
export const idempotencyKeyHeader = "idempotency-key";
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);

/** Role 또는 생애주기 단계 규칙이 도구 호출을 거부한 이유. */
export const toolRefusalReasons = ["role", "stage"] as const;
export const toolRefusalReasonSchema = z.enum(toolRefusalReasons);
export type ToolRefusalReason = z.infer<typeof toolRefusalReasonSchema>;

/**
 * 도구 거부 응답. 토큰이 없거나 끝난 실행 시도의 것이면 401 `invalid_token`,
 * 다른 조직의 기록과 없는 기록은 똑같이 404 `not_found`, 입력이 계약 밖이면 422 `invalid_input`.
 * Role이 쓸 수 없는 도구는 403 `forbidden`, 지금 생애주기 단계에서 닫힌 도구는 409 `stage_closed`이며
 * 두 거부는 Event log에 남는다. 아직 구현하지 않은 도구는 501 `not_implemented`.
 * 작업자 추가는 곧바로 생긴 작업자면 201, 승인 정책 때문에 승인 요청이 되었으면 202다.
 * 작업 규칙의 거부: 담당자가 아닌 착수나 담당자·Lead가 아닌 완료는 403 `not_assignee`,
 * 완료된 작업의 다시 완료는 409 `already_completed`, 지금 상태에서 할 수 없는 착수는 409 `invalid_transition`.
 * 연구 지도 규칙의 거부: 조직 사본 템플릿에 없는 노드·연결 종류는 422 `unknown_kind`, 자기 자신과의 보조 연결은
 * 422 `invalid_input`, 주 연결 순환(자기 자신이나 후손을 주 부모로)은 409 `primary_cycle`, 이미 다른 주 부모가 있는 노드의
 * 주 부모 지정은 409 `primary_parent_exists`, 이미 다른 노드에 연결된 작업의 연결은 409 `task_already_linked`,
 * 폐기된 노드의 편집(폐기 취소 제외)·폐기된 노드로의 새 연결은 409 `node_discarded`.
 * 같은 `Idempotency-Key`로 다른 도구·입력을 보내면 409 `idempotency_conflict`({@link idempotencyKeyHeader}).
 * 답장(`send_message`)의 대화가 같은 조직에 없으면 404 `not_found`, 여러 대화의 사용자 메시지를 받은 실행 시도가 대화를 고르지 않으면 422 `invalid_input`.
 * 초기 연구 승인 요청의 완료 기준: 조직에 완료 기준이 없는데 제안하지 않으면 422 `completion_criteria_required`,
 * 조직에 이미 완료 기준이 있는데 완료 기준을 함께 내면 409 `completion_criteria_set`.
 */
export const orgToolErrorCodes = [
  "invalid_token",
  "not_found",
  "invalid_input",
  "forbidden",
  "stage_closed",
  "not_implemented",
  "not_assignee",
  "already_completed",
  "invalid_transition",
  "unknown_kind",
  "primary_cycle",
  "primary_parent_exists",
  "task_already_linked",
  "node_discarded",
  "idempotency_conflict",
  "completion_criteria_required",
  "completion_criteria_set",
  "unknown_provider",
  "unknown_model",
] as const;
export type OrgToolErrorCode = (typeof orgToolErrorCodes)[number];
export const orgToolErrorSchema = z.object({
  error: z.object({ code: z.enum(orgToolErrorCodes) }),
});
