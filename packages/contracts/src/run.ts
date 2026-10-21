import { z } from "zod";
import { approvalDecisionSchema } from "./approval.ts";
import { flowKindSchema, instructionFileSchema } from "./harness.ts";
import { conversationMessageSchema } from "./message.ts";
import { agentRoleSchema, lifecycleStageSchema } from "./organization.ts";
import { researchMapOperationSchema } from "./research-map.ts";

// Control Plane → Agent Runtime 실행 시도 계약(docs/architecture.md).
// 요청 · 진행(공개 활동) · 종료 · 제어(취소)의 네 면을 따로 정의한다.

/** 실행 시도 상태. `running` 밖의 값은 모두 종료이며 종료 사유와 같은 말을 쓴다. */
export const runStatuses = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const runStatusSchema = z.enum(runStatuses);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runStopReasons = ["completed", "failed", "cancelled"] as const;
export const runStopReasonSchema = z.enum(runStopReasons);
export type RunStopReason = z.infer<typeof runStopReasonSchema>;

/** 에이전트 상태. 첫 판은 실행 중인 실행 시도가 있는지만 구별한다. */
export const agentStatuses = ["idle", "running"] as const;
export const agentStatusSchema = z.enum(agentStatuses);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** 실행 시도 하나로 묶인 깨우기 하나. 묶음의 순서는 깨우기가 생긴 순서다. */
export const wakeReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("owner_message"),
    wakeId: z.uuid(),
    messageId: z.uuid(),
    body: z.string(),
  }),
  /** 사용자가 승인 요청을 결정했다. 반려·수정 요청의 사유가 `note`에 있다. */
  z.object({
    kind: z.literal("approval_decision"),
    wakeId: z.uuid(),
    approvalId: z.uuid(),
    decision: approvalDecisionSchema,
    note: z.string().nullable(),
  }),
  /** 작업을 맡았다. */
  z.object({
    kind: z.literal("task_assigned"),
    wakeId: z.uuid(),
    taskId: z.uuid(),
    title: z.string(),
  }),
  /** 하위 작업(부모 작업 담당자에게) 또는 내가 만든 작업(부모가 없을 때)이 끝났다. `summary`는 완료한 에이전트의 자기 보고다. */
  z.object({
    kind: z.literal("task_completed"),
    wakeId: z.uuid(),
    taskId: z.uuid(),
    title: z.string(),
    summary: z.string(),
    completedByAgentId: z.uuid(),
  }),
  /** 사용자가 내가 맡은 작업에 댓글을 남겼다. */
  z.object({
    kind: z.literal("task_comment"),
    wakeId: z.uuid(),
    taskId: z.uuid(),
    commentId: z.uuid(),
    body: z.string(),
  }),
  /** 같은 조직의 에이전트가 메시지를 보냈다. */
  z.object({
    kind: z.literal("agent_to_agent_message"),
    wakeId: z.uuid(),
    messageId: z.uuid(),
    senderAgentId: z.uuid(),
    body: z.string(),
  }),
  /** 사용자가 연구 지도를 편집했다(Lead에게). `summary`는 무엇이 어떻게 바뀌었는지다. */
  z.object({
    kind: z.literal("research_map_edit"),
    wakeId: z.uuid(),
    editId: z.uuid(),
    operation: researchMapOperationSchema,
    nodeId: z.uuid().nullable(),
    summary: z.string(),
  }),
  /** 사용자가 제출한 결과에 수정을 요청했다(Lead에게). `note`가 사용자의 의견이다. */
  z.object({
    kind: z.literal("result_changes_requested"),
    wakeId: z.uuid(),
    submissionId: z.uuid(),
    note: z.string(),
  }),
]);
export type WakeReason = z.infer<typeof wakeReasonSchema>;
export type WakeKind = WakeReason["kind"];

export const runIdentitySchema = z.object({
  organizationId: z.uuid(),
  agentId: z.uuid(),
  runId: z.uuid(),
});
export type RunIdentity = z.infer<typeof runIdentitySchema>;

/**
 * 맥락 묶음. Lead 대화는 이 실행 시도까지 전달된 메시지만 담고,
 * 실행 중 도착해 다음 실행 시도를 기다리는 사용자 메시지는 담지 않는다.
 */
export const runContextSchema = z.object({
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    stage: lifecycleStageSchema,
    goal: z.string().nullable(),
    completionCriteria: z.string().nullable(),
  }),
  agent: z.object({ id: z.uuid(), role: agentRoleSchema, name: z.string() }),
  /** 같은 조직의 에이전트. 작업 담당·메시지 받는 에이전트를 고를 때 쓴다. */
  team: z.array(
    z.object({ id: z.uuid(), role: agentRoleSchema, name: z.string() })
  ),
  conversation: z.array(conversationMessageSchema),
  /** 조직 사본 흐름 템플릿이 선언한 연구 노드·보조 연결 종류. 초기 연구 승인 전에는 없다. */
  researchFlow: z
    .object({
      nodeKinds: z.array(flowKindSchema),
      linkKinds: z.array(flowKindSchema),
    })
    .nullable(),
});
export type RunContext = z.infer<typeof runContextSchema>;

/** 실행기가 이어 갈 세션 상태. 내용은 실행기마다 다르고 Control Plane은 해석하지 않는다. */
export const sessionStateSchema = z.record(z.string(), z.json());
export type SessionState = z.infer<typeof sessionStateSchema>;

/** 실행 시도 요청. `access.token`은 이 실행 시도 동안만 유효하며 저장하거나 공개하지 않는다. */
export const runRequestSchema = z.object({
  identity: runIdentitySchema,
  access: z.object({ toolsBaseUrl: z.url(), token: z.string().min(1) }),
  wakeReasons: z.array(wakeReasonSchema).min(1),
  context: runContextSchema,
  /** 지침 bundle 버전. 에이전트의 Role·Soul·Skill 사본 내용에서 정하며, 사본이 없으면 없다. 바뀌면 이전 세션을 이어 가지 않는다. */
  instructionsBundleVersion: z.string().nullable(),
  /** 그 버전을 정한 사본 내용. 실행기가 자기 방식으로 주입한다. */
  instructions: z.array(instructionFileSchema),
  /** 연구 환경 workspace. 연구 환경 구성 전에는 없다. */
  workspace: z.object({ cwd: z.string() }).nullable(),
  previousSession: sessionStateSchema.nullable(),
});
export type RunRequest = z.infer<typeof runRequestSchema>;

/**
 * 실행기가 공개로 내는 활동. 허용한 종류·필드만 받으며 그 밖의 값(모델 내부 추론, stdout 등)은 공개 기록에 넣지 않는다.
 * 조직·에이전트·실행 시도 귀속은 Control Plane이 붙인다.
 */
export const runtimeActivitySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("progress"),
    text: z.string().trim().min(1).max(2_000),
  }),
  z.strictObject({
    type: z.literal("tool_use"),
    tool: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(2_000),
  }),
]);
export type RuntimeActivity = z.infer<typeof runtimeActivitySchema>;

/** 공개 활동 기록. 실행기 활동과 Control Plane이 기록한 조직 도구 호출 요약. */
export const publicActivitySchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("runtime"), activity: runtimeActivitySchema }),
  z.object({
    source: z.literal("control_plane"),
    activity: z.object({
      type: z.literal("org_tool"),
      tool: z.string(),
      summary: z.string(),
    }),
  }),
]);
export type PublicActivity = z.infer<typeof publicActivitySchema>;

export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

/** 종료. 실행기는 취소를 받아도 정리를 끝낸 뒤 `cancelled`로 한 번만 돌려준다. */
export const runResultSchema = z.strictObject({
  stopReason: runStopReasonSchema,
  /** 실패 사유. 공개 기록에 남으므로 비밀값을 넣지 않는다. */
  error: z.string().max(2_000).nullable(),
  summary: z.string().max(4_000).nullable(),
  usage: usageSchema.nullable(),
  /** 다음 세션 상태. `null`이면 세션을 초기화한다. */
  nextSession: sessionStateSchema.nullable(),
});
export type RunResult = z.infer<typeof runResultSchema>;

/**
 * 제어: 취소. Control Plane은 이 값을 `signal.reason`으로 전한다. 사용자 중단 제어(#59)가 사유를 더한다.
 * 취소는 요청일 뿐이고, 실행 시도는 실행기가 정리를 끝내고 결과를 돌려준 뒤에 끝난다.
 */
export const runCancelSchema = z.strictObject({
  type: z.literal("cancel"),
  reason: z.enum(["server_shutdown"]),
});
export type RunCancel = z.infer<typeof runCancelSchema>;

/**
 * 실행기 adapter. `signal`이 취소(`reason`은 {@link RunCancel})를 전하고, adapter는 진행 중인 일을 멈추고 정리한 뒤에 결과를 돌려준다.
 * `emit`은 공개 활동을 순서대로 기록하며, 돌아온 뒤에 다음 활동을 낸다.
 */
export type RuntimeAdapter = {
  execute(
    request: RunRequest,
    control: {
      signal: AbortSignal;
      emit: (activity: unknown) => Promise<void>;
    }
  ): Promise<RunResult>;
};

// ---------- Surface 조회 모양 ----------

export const runSummarySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  agentId: z.uuid(),
  status: runStatusSchema,
  wakeCount: z.number().int().positive(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
export const runSummaryListSchema = z.array(runSummarySchema);

export const agentDetailSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: agentRoleSchema,
  name: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  status: agentStatusSchema,
  /** 현재 사본에서 정한 지침 bundle 버전. 다음 실행 시도가 받는다. */
  instructionsBundleVersion: z.string().nullable(),
  recentRuns: z.array(runSummarySchema),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;
