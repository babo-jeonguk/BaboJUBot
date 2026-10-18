import type {
  ConversationMessage,
  RunContextResponse,
  RunRequest,
  RunResult,
  RuntimeAdapter,
} from "@babojubot/contracts";
import { createOrgToolClient } from "./tools-client.ts";

// 가짜 실행기. 모델을 부르지 않고 에이전트(Role)와 깨우기 사유에 맞는 시나리오 단계를 실행한다.
// 각 단계는 실행 시도별 토큰으로 실제 조직 도구 HTTP 경로를 부르며 DB를 직접 쓰지 않는다.

/** 시나리오가 진행하며 쌓는 상태. */
export type ScriptState = {
  request: RunRequest;
  context: RunContextResponse | undefined;
  sent: ConversationMessage[];
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

/** 사용자 메시지에 대한 Lead의 기본 시나리오: 맥락을 읽고 받은 메시지를 모두 짚어 답장한다. */
export const leadReplyScript: Script = {
  steps: [
    { do: "read_context" },
    {
      do: "emit",
      activity: { type: "progress", text: "받은 메시지를 읽었습니다." },
    },
    {
      do: "send_message",
      body: ({ context, request }) => {
        const reasons = context?.wakeReasons ?? request.wakeReasons;
        return [
          `(가짜 실행기) 메시지 ${reasons.length}개를 받았습니다.`,
          ...reasons.map((r) => `- ${quote(r.body)}`),
        ].join("\n");
      },
    },
  ],
  summary: ({ sent, request }) =>
    `사용자 메시지 ${request.wakeReasons.length}개에 답장 ${sent.length}개를 보냈습니다.`,
};

/** 기본 선택: Lead가 사용자 메시지로 깨어나면 답장 시나리오. 그 밖의 조합은 아직 없다. */
export const defaultScriptSelector: ScriptSelector = (request) =>
  request.context.agent.role === "lead" &&
  request.wakeReasons.every((r) => r.kind === "owner_message")
    ? leadReplyScript
    : undefined;

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
      const state: ScriptState = { request, context: undefined, sent: [] };
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
