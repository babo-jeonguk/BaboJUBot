import type {
  ConversationMessage,
  OrgToolName,
  RequestInitialApprovalInput,
  RunContextResponse,
  RunRequest,
  RunResult,
  RuntimeAdapter,
  WakeReason,
} from "@babojubot/contracts";
import { createOrgToolClient, OrgToolError } from "./tools-client.ts";

// 가짜 실행기. 모델을 부르지 않고 에이전트(Role)와 깨우기 사유에 맞는 시나리오 단계를 실행한다.
// 각 단계는 실행 시도별 토큰으로 실제 조직 도구 HTTP 경로를 부르며 DB를 직접 쓰지 않는다.

/** 조직 도구 호출 하나의 결과. 거부를 허용한 단계는 거부도 결과로 남긴다. */
export type ToolCallRecord =
  | { tool: OrgToolName; ok: true; output: unknown }
  | { tool: OrgToolName; ok: false; status: number; code: string | undefined };

/** 시나리오가 진행하며 쌓는 상태. */
export type ScriptState = {
  request: RunRequest;
  context: RunContextResponse | undefined;
  sent: ConversationMessage[];
  calls: ToolCallRecord[];
};

export type ScriptStep =
  /** 내 실행 맥락 조회. */
  | { do: "read_context" }
  /** 공개 활동을 낸다. Control Plane이 허용하지 않는 값은 버려진다. */
  | { do: "emit"; activity: unknown }
  /** Lead 대화에 답장한다. */
  | { do: "send_message"; body: (state: ScriptState) => string }
  /** 조직 안의 메시지 하나를 조회한다. */
  | { do: "read_message"; messageId: (state: ScriptState) => string }
  /** 조직 도구 하나를 부른다. `allowRefusal`이면 거부돼도 결과로 남기고 다음 단계로 간다. */
  | {
      do: "call";
      tool: OrgToolName;
      input?: (state: ScriptState) => unknown;
      allowRefusal?: boolean;
    }
  /** 테스트가 정한 조건까지 멈춘다. 취소되면 reject해야 한다. */
  | { do: "hold"; until: (signal: AbortSignal) => Promise<void> }
  /** 실행기 오류를 흉내 낸다. */
  | { do: "fail"; error: string };

export type Script = {
  steps: ScriptStep[];
  summary?: (state: ScriptState) => string;
};

export type ScriptSelector = (request: RunRequest) => Script | undefined;

const quote = (body: string) =>
  `“${body.length > 80 ? `${body.slice(0, 80)}…` : body}”`;

const decisionLabel = {
  approve: "승인",
  reject: "반려",
  request_changes: "수정 요청",
} as const;

/** 깨우기 사유 한 줄. */
export const describeWakeReason = (reason: WakeReason) =>
  reason.kind === "owner_message"
    ? quote(reason.body)
    : `초기 연구 승인 요청 ${decisionLabel[reason.decision]}${reason.note ? `: ${quote(reason.note)}` : ""}`;

/** 받은 깨우기 사유를 모두 짚는 답장. */
const replyToWakeReasons = ({ context, request }: ScriptState) => {
  const reasons = context?.wakeReasons ?? request.wakeReasons;
  return [
    `(가짜 실행기) 메시지 ${reasons.length}개를 받았습니다.`,
    ...reasons.map((r) => `- ${describeWakeReason(r)}`),
  ].join("\n");
};

const leadReplySteps = (
  body: (state: ScriptState) => string = replyToWakeReasons
): ScriptStep[] => [
  { do: "read_context" },
  {
    do: "emit",
    activity: { type: "progress", text: "받은 메시지를 읽었습니다." },
  },
  { do: "send_message", body },
];

/** 사용자 메시지에 대한 Lead의 기본 시나리오: 맥락을 읽고 받은 깨우기 사유를 모두 짚어 답장한다. */
export const leadReplyScript: Script = {
  steps: leadReplySteps(),
  summary: ({ sent, request }) =>
    `깨우기 ${request.wakeReasons.length}개에 답장 ${sent.length}개를 보냈습니다.`,
};

/**
 * 데모용 초기 연구 승인 요청. 목표를 그대로 옮긴 계획, 연구원 두 명, 기본 연구 흐름 템플릿.
 * 반려·수정 요청을 받았으면 그 사유를 계획에 적는다.
 */
export function demoProposal(
  goal: string,
  feedback?: string | null
): RequestInitialApprovalInput {
  return {
    plan: [
      `# 초기 연구 계획`,
      ``,
      `목표: ${goal}`,
      ``,
      `1. 연구 문제를 목록화한다.`,
      `2. 문제마다 가설·아이디어와 검증 방법을 세운다.`,
      `3. 연구원 두 명이 실험·검증을 나눠 수행하고 결과를 평가한다.`,
      ...(feedback ? [``, `반영한 사용자 의견: ${feedback}`] : []),
    ].join("\n"),
    environment: [
      `# 연구 환경 명세`,
      ``,
      `- compute: 로컬 CPU`,
      `- 데이터: 사용자가 지정할 공개 데이터셋`,
      `- 사용자 할 일: 없음`,
      `(가짜 실행기가 만든 예시입니다.)`,
    ].join("\n"),
    team: [{ role: "researcher", count: 2 }],
    template: "basic-research",
  };
}

/** 사용자 메시지에서 `목표:`·`완료 기준:` 줄을 읽는다. 둘 다 있을 때만 목표로 기록한다. */
export function parseGoalMessage(
  body: string
): { goal: string; completionCriteria: string } | undefined {
  const line = (label: string) =>
    new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, "m").exec(body)?.[1]?.trim();
  const goal = line("목표");
  const completionCriteria = line("완료 기준");
  return goal && completionCriteria ? { goal, completionCriteria } : undefined;
}

/**
 * 가짜 Lead의 데모 흐름. 실제 판단 없이 단계와 깨우기 사유로 정한다.
 * - 목표 설정: `목표:`·`완료 기준:` 줄이 있는 메시지를 받으면 목표를 기록하고 곧바로 초기 연구 승인을 요청한다.
 * - 계획 수립(반려·수정 요청을 받음): 사유를 반영한 새 요청을 제출한다.
 * - 그 밖: 받은 깨우기 사유에 답장한다.
 */
export function demoLeadScript(request: RunRequest): Script {
  const { stage } = request.context.organization;
  const messages = request.wakeReasons.flatMap((r) =>
    r.kind === "owner_message" ? [r.body] : []
  );
  const goal = messages.map(parseGoalMessage).findLast(Boolean);

  if (stage === "goal_setting" && goal)
    return {
      steps: [
        { do: "read_context" },
        { do: "call", tool: "record_goal", input: () => goal },
        {
          do: "call",
          tool: "request_initial_approval",
          input: () => demoProposal(goal.goal),
        },
        {
          do: "send_message",
          body: () =>
            `(가짜 실행기) 목표와 완료 기준을 기록하고 초기 연구 승인을 요청했습니다. Inbox에서 계획·팀·연구 환경 명세를 검토해 주세요.`,
        },
      ],
      summary: () => "목표를 기록하고 초기 연구 승인을 요청했습니다.",
    };

  const sentBack = request.wakeReasons.findLast(
    (r) => r.kind === "approval_decision" && r.decision !== "approve"
  );
  const recorded = request.context.organization.goal;
  if (
    stage === "planning" &&
    sentBack?.kind === "approval_decision" &&
    recorded
  )
    return {
      steps: [
        { do: "read_context" },
        {
          do: "call",
          tool: "request_initial_approval",
          input: () => demoProposal(recorded, sentBack.note),
        },
        {
          do: "send_message",
          body: () =>
            `(가짜 실행기) ${describeWakeReason(sentBack)}\n사유를 반영해 계획을 다시 제출했습니다.`,
        },
      ],
      summary: () => "사유를 반영해 초기 연구 승인을 다시 요청했습니다.",
    };

  if (stage === "goal_setting" && messages.length)
    return {
      ...leadReplyScript,
      steps: leadReplySteps((state) =>
        [
          replyToWakeReasons(state),
          "목표가 정해지면 `목표: …`와 `완료 기준: …` 줄로 보내 주세요. 기록하고 초기 연구 승인을 요청합니다.",
        ].join("\n")
      ),
    };
  return leadReplyScript;
}

/** 기본 선택: Lead는 데모 흐름. 작업자 시나리오는 작업(#55)과 함께 더한다. */
export const defaultScriptSelector: ScriptSelector = (request) =>
  request.context.agent.role === "lead" ? demoLeadScript(request) : undefined;

export function createScriptedRuntime({
  select = defaultScriptSelector,
  fetch,
}: {
  select?: ScriptSelector;
  fetch?: typeof globalThis.fetch;
} = {}): RuntimeAdapter {
  return {
    async execute(request, { signal, emit }) {
      const turns = Number(request.previousSession?.turns ?? 0);
      const end = (
        stopReason: RunResult["stopReason"],
        fields: Partial<RunResult> = {}
      ): RunResult => ({
        stopReason,
        error: null,
        summary: null,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        nextSession: { turns: turns + 1 },
        ...fields,
      });

      const script = select(request);
      if (!script)
        return end("failed", {
          error: `가짜 실행기에 ${request.context.agent.role}·${request.wakeReasons.map((r) => r.kind).join(",")} 시나리오가 없습니다.`,
        });
      const tools = createOrgToolClient({
        baseUrl: request.access.toolsBaseUrl,
        token: request.access.token,
        signal,
        fetch,
      });
      const state: ScriptState = {
        request,
        context: undefined,
        sent: [],
        calls: [],
      };
      try {
        for (const step of script.steps) {
          signal.throwIfAborted();
          switch (step.do) {
            case "read_context":
              state.context = await tools.getRunContext();
              break;
            case "emit":
              await emit(step.activity);
              break;
            case "send_message":
              state.sent.push(await tools.sendMessage(step.body(state)));
              break;
            case "read_message":
              await tools.getMessage(step.messageId(state));
              break;
            case "call":
              try {
                const output = await tools.call(step.tool, step.input?.(state));
                state.calls.push({ tool: step.tool, ok: true, output });
              } catch (error) {
                if (!(error instanceof OrgToolError) || !step.allowRefusal)
                  throw error;
                state.calls.push({
                  tool: step.tool,
                  ok: false,
                  status: error.status,
                  code: error.code,
                });
              }
              break;
            case "hold":
              await step.until(signal);
              break;
            case "fail":
              return end("failed", { error: step.error });
          }
        }
        signal.throwIfAborted();
        return end("completed", { summary: script.summary?.(state) ?? null });
      } catch (error) {
        // 취소 중 생긴 오류는 실패가 아니라 취소다(ACP prompt-turn Cancellation과 같은 규칙).
        if (signal.aborted) return end("cancelled");
        return end("failed", {
          error: error instanceof Error ? error.message : "가짜 실행기 오류",
        });
      }
    },
  };
}
