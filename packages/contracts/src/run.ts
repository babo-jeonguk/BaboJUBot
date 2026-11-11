import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { usageSchema } from "./usage.ts";
import { approvalDecisionSchema, approvalKindSchema } from "./approval.ts";
import { flowKindSchema, instructionFileSchema } from "./harness.ts";
import { agentAppearanceSchema } from "./agent-profile.ts";
import { agentHeartbeatSchema } from "./heartbeat.ts";
import { conversationMessageSchema, conversationSchema } from "./message.ts";
import {
  agentRoleSchema,
  approvalPolicySchema,
  lifecycleStageSchema,
} from "./organization.ts";
import { researchMapOperationSchema } from "./research-map.ts";
import {
  modelIdSchema,
  providerIdSchema,
  type ModelOption,
  type ProviderCapabilities,
  type ProviderReadinessCheck,
} from "./provider.ts";

// Control Plane → Agent Runtime 실행 시도 계약(docs/architecture.md).
// 요청 · 진행(공개 활동) · 종료 · 제어(취소)의 네 면을 따로 정의한다.

/**
 * 실행 시도 상태. `running` 밖의 값은 모두 종료이며 종료 사유와 같은 말을 쓴다.
 * `server_restart`는 프로바이더가 아니라 Control Plane이 정한다. 서버가 멈춰(종료·crash) 끝내지 못한 실행 시도이며,
 * 그 실행 시도가 받은 깨우기는 다시 대기해 다음 실행 시도가 받는다.
 */
export const runStatuses = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "server_restart",
] as const;
export const runStatusSchema = z.enum(runStatuses);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** 프로바이더가 돌려주는 종료 사유. */
export const runStopReasons = ["completed", "failed", "cancelled"] as const;
export const runStopReasonSchema = z.enum(runStopReasons);
export type RunStopReason = z.infer<typeof runStopReasonSchema>;

/** 저장한 실행 시도 종료 사유: 프로바이더의 종료 사유와 서버 재시작. */
export const runEndReasonSchema = runStatusSchema.exclude(["running"]);
export type RunEndReason = z.infer<typeof runEndReasonSchema>;

/** 에이전트 상태. 첫 판은 실행 중인 실행 시도가 있는지만 구별한다. */
export const agentStatuses = ["idle", "running"] as const;
export const agentStatusSchema = z.enum(agentStatuses);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * 실행 의도(GLOSSARY)의 정산 상태. `pending`은 수락해 입력·원본 자료를 고정했지만 아직 효과도 확정 거절도 없는 의도다.
 * `completed`는 효과와 최초 결과를 함께 저장했고, `refused`는 효과 없이 확정 거절했으며(`reason`은 도구 거부 코드),
 * `cancelled`는 사용자 제어가 그 실행 시도를 취소해 수행하지 않기로 한 의도다.
 */
export const intentOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("completed"), result: z.unknown() }),
  z.object({ status: z.literal("refused"), reason: z.string() }),
  z.object({ status: z.literal("cancelled") }),
]);
export type IntentOutcome = z.infer<typeof intentOutcomeSchema>;

/** 실행 의도가 수락 때 고정한 입력: 경로 변수 `params`와 본문 `body`. */
export const intentRequestSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  body: z.unknown(),
});
export type IntentRequest = z.infer<typeof intentRequestSchema>;

/**
 * 서버 재시작으로 끝난 실행 시도가 수락한 실행 의도 하나와 그 정산 결과. `tool`은 조직 도구 이름(contracts `orgToolNames`),
 * `request`는 수락 때 고정한 입력이고, 원래 입력을 알 수 없으면(이 기능 전 판이 남긴 기록이거나 저장된 표기를 읽을 수 없음)
 * `null`이다. 빈 입력으로 바꾸어 보이지 않는다.
 */
export const recoveredIntentSchema = z.object({
  intentId: z.uuid(),
  tool: z.string(),
  request: intentRequestSchema.nullable(),
  outcome: intentOutcomeSchema,
});
export type RecoveredIntent = z.infer<typeof recoveredIntentSchema>;

/** 실행 시도 하나로 묶인 깨우기 하나. 묶음의 순서는 깨우기가 생긴 순서다. */
export const wakeReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("owner_message"),
    wakeId: z.uuid(),
    messageId: z.uuid(),
    /** 메시지가 속한 대화. Lead는 이 대화로 답장한다. */
    conversationId: z.uuid(),
    body: z.string(),
  }),
  /** 사용자가 승인 요청을 결정했다. 반려·수정 요청의 사유가 `note`에 있다. */
  z.object({
    kind: z.literal("approval_decision"),
    wakeId: z.uuid(),
    approvalId: z.uuid(),
    approvalKind: approvalKindSchema,
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
  /**
   * 사용자가 에이전트 하나의 Role·Soul·Skill 사본을 편집해 저장했다(Lead에게). `agentId`는 사본을 가진 에이전트,
   * `revision`은 저장으로 생긴 revision 번호다. 그 에이전트의 다음 실행 시도가 새 내용을 받는다.
   */
  z.object({
    kind: z.literal("instruction_edit"),
    wakeId: z.uuid(),
    revisionId: z.uuid(),
    agentId: z.uuid(),
    copyId: z.uuid(),
    path: z.string(),
    revision: z.number().int().positive(),
  }),
  /** 사용자가 제출한 결과에 수정을 요청했다(Lead에게). `note`가 사용자의 의견이다. */
  z.object({
    kind: z.literal("result_changes_requested"),
    wakeId: z.uuid(),
    submissionId: z.uuid(),
    note: z.string(),
  }),
  /**
   * 사용자가 연구 목표를 적어 조직을 만들었다(Lead에게). 목표·완료 기준은 실행 맥락의 조직에 있다.
   * 조직마다 한 번뿐이며 가리키는 기록은 없다.
   */
  z.object({ kind: z.literal("organization_created"), wakeId: z.uuid() }),
  /** 켜 둔 heartbeat의 간격이 지났다. 가리키는 기록은 없다. */
  z.object({ kind: z.literal("heartbeat"), wakeId: z.uuid() }),
  /**
   * 서버 재시작으로 끝난 실행 시도(`interruptedRunId`)가 수락한 실행 의도와 그 정산 결과. 모델은 그 실행 시도의 세션을 잃었으므로
   * 이 결과로 이미 한 쓰기를 알고 다시 하지 않는다. 제품은 이 깨우기를 받은 실행 시도에서 모델을 부르기 전에 남은 의도를 정산하므로
   * 프로바이더가 받는 결과에는 `pending`이 없다. `taskId`는 끝난 실행 시도의 세션 자리(작업 세션이면 그 작업)다.
   */
  z.object({
    kind: z.literal("intent_recovery"),
    wakeId: z.uuid(),
    interruptedRunId: z.uuid(),
    taskId: z.uuid().nullable(),
    intents: z.array(recoveredIntentSchema),
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
 * `conversations`는 기본 대화와 이 실행 시도가 받은 사용자 메시지의 대화이고, `conversation`은 그 대화들의 최근 메시지다.
 */
export const runContextSchema = z.object({
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    stage: lifecycleStageSchema,
    goal: z.string().nullable(),
    completionCriteria: z.string().nullable(),
    /** 조직의 승인 정책. `GitHub에 올리기`처럼 에이전트 지침으로 지키는 항목도 여기서 읽는다. */
    approvalPolicy: approvalPolicySchema,
  }),
  agent: z.object({ id: z.uuid(), role: agentRoleSchema, name: z.string() }),
  /** 같은 조직의 에이전트. 작업 담당·메시지 받는 에이전트를 고를 때 쓴다. */
  team: z.array(
    z.object({ id: z.uuid(), role: agentRoleSchema, name: z.string() })
  ),
  conversations: z.array(conversationSchema.omit({ organizationId: true })),
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

/** 프로바이더가 이어 갈 세션 상태. 내용은 프로바이더마다 다르고 Control Plane은 해석하지 않는다. */
export const sessionStateSchema = z.record(z.string(), z.json());
export type SessionState = z.infer<typeof sessionStateSchema>;

/** 실행 시도 요청. `access.token`은 이 실행 시도 동안만 유효하며 저장하거나 공개하지 않는다. */
export const runRequestSchema = z.object({
  identity: runIdentitySchema,
  access: z.object({ toolsBaseUrl: z.url(), token: z.string().min(1) }),
  wakeReasons: z.array(wakeReasonSchema).min(1),
  context: runContextSchema,
  /**
   * 지침 bundle 버전. 에이전트의 Role·Soul·Skill 사본 내용에서 정하며, 사본이 없으면 없다. 이어 갈 세션을 만든 버전과 다르면
   * admission(core `planRunStart`)이 `previousSession`을 비워 넘기므로 프로바이더가 따로 가리지 않는다.
   */
  instructionsBundleVersion: z.string().nullable(),
  /** 그 버전을 정한 사본 내용. 프로바이더가 자기 방식으로 주입한다. */
  instructions: z.array(instructionFileSchema),
  /** 연구 환경 workspace. 연구 환경 구성 전에는 없다. */
  workspace: z
    .object({
      cwd: z.string(),
      organization: z.string().optional(),
      personal: z.string().optional(),
      peers: z
        .array(
          z.object({
            agentId: z.uuid(),
            path: z.string(),
            access: z.literal("read"),
          })
        )
        .optional(),
    })
    .nullable(),
  /** admission이 에이전트 설정에서 고정한 모델. 없으면 프로바이더가 기본 모델을 쓴다. */
  model: modelIdSchema.nullable(),
  /**
   * 이어 갈 세션. 세션은 (에이전트, 작업)마다 저장한다. 받은 깨우기가 모두 한 작업이면 그 작업의 세션, 섞였거나 작업이 없으면
   * 에이전트 세션이다(core `sessionTaskOf`). 세션을 만든 프로바이더 연결이나 지침 bundle 버전이 지금과 다르면 admission이 비워 넘긴다.
   * 이어 가지 못하면 프로바이더가 같은 실행 시도 안에서 새 세션으로 시작한다.
   */
  previousSession: sessionStateSchema.nullable(),
  /** 실행 환경. `container`면 프로바이더 프로그램을 실행 시도마다 컨테이너 하나에서 돌린다(격리 실행). 없으면 이 컴퓨터에서 돈다. */
  execution: z.enum(["host", "container"]).optional(),
});
export type RunRequest = z.infer<typeof runRequestSchema>;

/**
 * 프로바이더가 공개로 내는 활동. 허용한 종류·필드만 받으며 그 밖의 값(모델 내부 추론, stdout 등)은 공개 기록에 넣지 않는다.
 * 조직·에이전트·실행 시도 귀속은 Control Plane이 붙인다. 진행 문장(`progress.text`)은 사용자가 대시보드에서 읽으므로 한국어로 쓴다.
 * 도구 입력 칸이 아니라서 이 언어 규칙은 역할 문서의 지시로 에이전트에게 전한다.
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

/** 공개 활동 기록. 프로바이더 활동과 Control Plane이 기록한 조직 도구 호출 요약. */
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

/**
 * 실패의 종류. `login_required`는 제품 로그인이 필요해 실패했다는 뜻이며, 서버가 그 연결의 준비 상태를 다시 확인한다.
 */
export const runErrorCodes = ["login_required"] as const;
export const runErrorCodeSchema = z.enum(runErrorCodes);
export type RunErrorCode = z.infer<typeof runErrorCodeSchema>;

/** 종료. 프로바이더는 취소를 받아도 정리를 끝낸 뒤 `cancelled`로 한 번만 돌려준다. */
export const sessionMaintenanceSchema = z.strictObject({
  tokens: z.number().int().nonnegative(),
  lastRequestAt: z.iso.datetime({ offset: true }),
  ttlMs: z.number().int().positive(),
});
export type SessionMaintenance = z.infer<typeof sessionMaintenanceSchema>;

export const runResultSchema = z.strictObject({
  stopReason: runStopReasonSchema,
  /** 실패 사유. 공개 기록에 남으므로 비밀값을 넣지 않는다. */
  error: z.string().max(2_000).nullable(),
  /** 실패의 종류. 알 수 있을 때만 준다. */
  errorCode: runErrorCodeSchema.nullable().optional(),
  summary: z.string().max(4_000).nullable(),
  usage: usageSchema.nullable(),
  /** 다음 세션 상태. 이 실행 시도의 세션 자리에 저장하며, `null`이면 그 세션을 비운다. */
  nextSession: sessionStateSchema.nullable(),
  sessionMaintenance: sessionMaintenanceSchema.optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

/**
 * 사용자 제어 명령이 실행 시도를 취소한 사유: 조직 일시정지·조직 중단·에이전트 일시정지·실행 중단(`owner_interrupt`, 메시지 없는 `실행 중단`과 `중단하고 보내기`).
 * 실행 시도에 영속하며, 요청한 순간 그 실행 시도의 토큰은 조직 도구를 쓸 수 없다.
 */
export const runCancelReasons = [
  "organization_paused",
  "organization_stopped",
  "agent_paused",
  "owner_interrupt",
] as const;
export const runCancelReasonSchema = z.enum(runCancelReasons);
export type RunCancelReason = z.infer<typeof runCancelReasonSchema>;

/**
 * 제어: 취소. Control Plane은 이 값을 `signal.reason`으로 전한다. 서버 종료 또는 사용자 제어({@link RunCancelReason})가 사유다.
 * 취소는 요청일 뿐이고, 실행 시도는 프로바이더가 정리를 끝내고 결과를 돌려준 뒤에 끝난다.
 */
export const runCancelSchema = z.strictObject({
  type: z.literal("cancel"),
  reason: z.enum(["server_shutdown", ...runCancelReasons]),
});
export type RunCancel = z.infer<typeof runCancelSchema>;

/** 진행 중인 실행 시도에 끼워 넣는 사용자 메시지. */
export type SteerMessage = {
  runId: string;
  messageId: string;
  conversationId: string;
  body: string;
};

/**
 * 끼워 넣기의 결과. `accepted`는 살아 있는 실행 시도·턴을 확인한 뒤 프로바이더에 전달했다는 뜻이다.
 * 확인 실패·명시적 거절은 `rejected`이며, 전달 뒤 턴이 끝나 이번 실행 시도에 반영되지 않을 수 있다. 거절된 메시지는 줄 세운 메시지가 된다.
 */
export const steerOutcomes = ["accepted", "rejected"] as const;
export type SteerOutcome = (typeof steerOutcomes)[number];

/**
 * 프로바이더 adapter. `signal`이 취소(`reason`은 {@link RunCancel})를 전하고, adapter는 진행 중인 일을 멈추고 정리한 뒤에 결과를 돌려준다.
 * `emit`은 공개 활동을 순서대로 기록하며, 돌아온 뒤에 다음 활동을 낸다.
 * adapter는 다음을 지킨다: 취소를 받으면 곧 `cancelled`로 끝나고, 돌아온 뒤 활동을 내지 않으며, 활동은 {@link runtimeActivitySchema},
 * 종료는 {@link runResultSchema}에 맞고, 실행 시도 토큰을 오류 문구·요약·활동에 싣지 않는다. 선언한 일(`capabilities`)은 그대로 한다.
 * 이 약속은 `@babojubot/runtime/runtime-contract`의 공통 검사(`describeRuntimeContract`)가 adapter마다 확인한다.
 */
export type RuntimeAdapter = {
  /** 지원하는 일. 모든 항목을 기본값 없이 선언한다. */
  capabilities: ProviderCapabilities;
  execute(
    request: RunRequest,
    control: {
      signal: AbortSignal;
      emit: (activity: unknown) => Promise<void>;
    }
  ): Promise<RunResult>;
  /**
   * 진행 중인 실행 시도(`message.runId`)에 사용자 메시지를 끼워 넣는다. `capabilities.steer`일 때만 있다.
   * 실행 시도·턴을 확인한 뒤 전달하면 `accepted`, 확인 실패·명시적 거절은 `rejected`다. 닫힌 입력 경로도 `rejected`다.
   * 수신 여부를 모르는 통신 오류는 던진다. 호출자는 `rejected`로 처리하며 실제로 전달됐을 가능성을 감수한다.
   * 받았다는 공개 활동은 실행 흐름(`execute`의 `emit`)이 남긴다.
   */
  steer?: (message: SteerMessage) => Promise<SteerOutcome>;
  /**
   * 같은 세션을 유지하는 비공개 압축. 호출 토큰은 MCP 목록 조회만 허용한다.
   * `ok`는 압축이 실제로 끝났을 때만 `true`다. 중단 신호를 받은 뒤라도 압축이 이미 끝났으면 `true`와 그 세션을 돌려주고, 호출자는 그대로 저장한다.
   */
  precompact?: (
    request: {
      session: SessionState;
      access: RunRequest["access"];
      execution?: RunRequest["execution"];
      /** 세션을 가진 조직. 프로바이더는 그 조직의 제품 폴더에서 압축한다. */
      organizationId: string;
    },
    signal: AbortSignal
  ) => Promise<{ ok: boolean; nextSession: SessionState | null }>;
  /** 모델 호출 없이 프로그램·버전·제품 로그인 상태를 확인한다. */
  checkReadiness: (signal: AbortSignal) => Promise<ProviderReadinessCheck>;
  /** 제품 로그인 명령. 준비 상태가 `product_login_missing`일 때 화면이 복사하게 한다. 없으면 `null`이다. */
  loginCommand: string | null;
};

/**
 * 서버에 등록하는 이름 붙은 프로바이더 연결. 실행 시도는 그 에이전트의 연결(`id`)의 adapter가 맡는다.
 * 같은 adapter 종류라도 ID가 다르면 다른 연결이며 동시 실행 상한도 따로다.
 * 모델 목록은 `listModels`로 받아 오고, 없거나 실패·시간 초과·빈 목록이면 고정 목록 `models`를 쓴다. 목록 조회는 모델을 부르지 않는다.
 */
export type ProviderConnection = {
  id: string;
  /** 화면에 보이는 이름. */
  label: string;
  adapter: RuntimeAdapter;
  models: readonly ModelOption[];
  listModels?: (signal: AbortSignal) => Promise<ModelOption[]>;
  /** 목록 밖의 모델도 받는다. 목록이 제품에 담긴 고정 목록이라 모든 모델을 담지 못하는 연결이다. */
  openModels?: boolean;
  /** 프로그램을 띄우는 실제 연결. 격리를 켜면 컨테이너에서 돌며, 안전 확인이 실패하면 준비안됨이다. 가짜 연결에는 없다. */
  isolatable?: boolean;
  /**
   * 격리 실행의 인증 중계(#148). 컨테이너에는 연결의 로그인 원본 대신 실행 시도에 묶인 권한만 넣고, 모델 요청은 서버의 이 중계가 실제 인증을 붙여 보낸다.
   * 격리를 켰을 때 중계가 없거나 기존 구독으로 검증되지 않았으면(`verified` 거짓) 준비안됨이며 실행 시도를 시작하지 않는다.
   */
  credentialRelay?: CredentialRelayEndpoint;
  /** 제품 로그인 실행 방법. `tokenFile`이 있으면 프로그램이 보여 준 토큰을 받아 그 파일에 저장한다. */
  login?: {
    command: readonly [string, ...string[]];
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    tokenFile?: string;
  };
};

/** 서버가 보는 인증 중계의 면. 권한 발급은 연결의 어댑터가 실행 시도 안에서 한다. */
export type CredentialRelayEndpoint = {
  /** 이 연결의 기존 구독으로 격리 실행을 검증했는가. */
  verified: boolean;
  /** 원본을 읽지 못해 중계가 실패한 상태인가. 복구 전에는 새 격리 실행을 막는다. */
  failed: () => boolean;
  /** 실패 상태면 원본을 다시 읽어 보고, 읽히면 실패 상태를 푼다. 준비 확인(사용자의 다시 확인)이 부른다. */
  recover: () => Promise<void>;
  /** 실패하면 부른다. 돌려준 함수로 해제한다. */
  onFailure: (listener: () => void) => () => void;
  /** 조직 도구 listener에서 `/api/relay/<연결>` 아래 요청을 처리한다. 요청의 경로는 그 접두사를 뺀 것이다. */
  handle: (req: IncomingMessage, res: ServerResponse) => void;
};

// ---------- Surface 조회 모양 ----------

export const runSummarySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  agentId: z.uuid(),
  status: runStatusSchema,
  /** admission이 에이전트 설정에서 고정한 프로바이더 연결과 모델(없으면 기본 모델). 에이전트 설정이 나중에 바뀌어도 그대로다. */
  provider: providerIdSchema,
  model: modelIdSchema.nullable(),
  /** 사용자 제어가 요청한 취소. 실행 중이면 프로바이더가 정리하는 중이고, 끝나면 `cancelled`다. */
  cancelReason: runCancelReasonSchema.nullable(),
  /** 이 실행 시도가 받은 깨우기 수. 서버 재시작으로 끝나 다시 대기한 깨우기도 이 실행 시도의 기록에 남는다. */
  wakeCount: z.number().int().positive(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
export const runSummaryListSchema = z.array(runSummarySchema);

/**
 * 실행 의도 복구가 에이전트의 모델 진행을 막은 이유. 원본 자료 부족(`missing_source`), 기록 모순(`inconsistent_record`),
 * 일시적 오류의 자동 재시도 소진(`retry_exhausted`).
 */
export const agentRecoveryBlockReasons = [
  "missing_source",
  "inconsistent_record",
  "retry_exhausted",
] as const;
export const agentRecoveryBlockReasonSchema = z.enum(agentRecoveryBlockReasons);
export type AgentRecoveryBlockReason = z.infer<
  typeof agentRecoveryBlockReasonSchema
>;

/**
 * 에이전트의 실행 의도 복구 상태. `blocked`면 admission이 그 에이전트의 실행 시도를 시작하지 않고, 사용자가 복구 재시도를 고르면
 * `retrying`이 되어 다음 실행 시도가 모델을 부르기 전에 정산을 다시 한다. 정산에 성공하면 상태가 없어지고 실패하면 다시 `blocked`다.
 * 일시정지·조직 단계 같은 다른 admission 조건은 따로 적용한다.
 */
export const agentRecoverySchema = z.object({
  state: z.enum(["blocked", "retrying"]),
  reason: agentRecoveryBlockReasonSchema,
  since: z.iso.datetime({ offset: true }),
});
export type AgentRecovery = z.infer<typeof agentRecoverySchema>;

export const agentDetailSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: agentRoleSchema,
  name: z.string(),
  appearance: agentAppearanceSchema,
  /** 다음 실행 시도가 쓸 프로바이더 연결과 모델(없으면 기본 모델). 진행 중인 실행 시도의 값은 `recentRuns`에 있다. */
  provider: providerIdSchema,
  model: modelIdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  status: agentStatusSchema,
  /** 사용자가 이 에이전트를 일시정지했다. 조직 일시정지와 따로이며, 에이전트 재개로만 풀린다. */
  paused: z.boolean(),
  /** 현재 사본에서 정한 지침 bundle 버전. 다음 실행 시도가 받는다. */
  instructionsBundleVersion: z.string().nullable(),
  heartbeat: agentHeartbeatSchema,
  recentRuns: z.array(runSummarySchema),
  /** 이 에이전트에게 줄 세운 사용자 메시지 수(모든 대화). 상한은 `maxQueuedMessages`다. Lead가 아니면 0이다. */
  queuedMessageCount: z.number().int().nonnegative(),
  /** 실행 의도 복구가 막혔거나 사용자가 고른 복구 재시도가 진행 중이면 그 상태다. 그 밖에는 없다. */
  recovery: agentRecoverySchema.nullable(),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;
