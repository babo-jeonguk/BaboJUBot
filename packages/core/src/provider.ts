import {
  isClosedStage,
  sameProviderChoice,
  unlimitedConcurrentRuns,
  type Agent,
  type LifecycleStage,
  type NewEvent,
  type ProviderChoice,
  type ProviderSummary,
} from "@babojubot/contracts";

// 에이전트별 프로바이더·모델과 프로바이더 연결별 동시 실행 상한(#94).

/** 고른 프로바이더·모델이 이 서버에서 쓸 수 없는 이유. */
export type ProviderChoiceProblem = "unknown_provider" | "unknown_model";

/**
 * 선택을 확인할 때 쓰는 등록된 연결과 그 모델 목록. 모델 목록은 받아 올 때마다 달라질 수 있어, 호출한 쪽이 잠금 밖에서
 * 받아 온 것을 넘긴다. 등록되지 않은 연결은 들어 있지 않다.
 */
export type ProviderModels = readonly Pick<ProviderSummary, "id" | "models">[];

/** 모두 등록된 연결이고, 모델을 골랐다면 그 연결의 모델 목록에 있는가. 처음 걸린 문제를 돌려준다. */
export function checkProviderChoices(
  connections: ProviderModels,
  choices: readonly ProviderChoice[]
): ProviderChoiceProblem | undefined {
  for (const { provider, model } of choices) {
    const connection = connections.find((c) => c.id === provider);
    if (!connection) return "unknown_provider";
    if (model !== null && !connection.models.some((m) => m.id === model))
      return "unknown_model";
  }
  return undefined;
}

/**
 * 프로바이더 연결이 새 실행 시도를 받을 수 있는가. 진행 중인 실행 시도가 상한보다 적을 때만이며, 상한 0은 무제한이다.
 * 상한을 줄여 진행 중인 수가 상한 이상이면 진행 중인 것은 그대로 두고 새 실행 시도만 기다린다.
 */
export const admitsProviderRun = ({
  maxConcurrentRuns,
  running,
}: {
  maxConcurrentRuns: number;
  running: number;
}) =>
  maxConcurrentRuns === unlimitedConcurrentRuns || running < maxConcurrentRuns;

/**
 * 사용자의 에이전트 프로바이더·모델 변경. 다음 실행 시도부터 적용한다(admission이 그때의 값을 실행 시도에 고정).
 * 연결·모델이 그 서버에 있는지는 호출한 쪽이 등록부로 확인한다. 값이 그대로면 `unchanged`, 끝난 조직이면 `organization_closed`다.
 * 프로바이더 연결이 바뀌면 그 에이전트의 세션을 모두 비운다(`resetsSessions`). 모델만 바뀌면 세션은 그대로다.
 */
export function planAgentProviderChange(
  agent: Pick<Agent, "id" | "organizationId" | "provider" | "model">,
  stage: LifecycleStage,
  input: ProviderChoice
):
  | { update: ProviderChoice; resetsSessions: boolean; event: NewEvent }
  | "unchanged"
  | "organization_closed" {
  if (isClosedStage(stage)) return "organization_closed";
  const current = { provider: agent.provider, model: agent.model };
  if (sameProviderChoice(input, current)) return "unchanged";
  return {
    update: { provider: input.provider, model: input.model },
    resetsSessions: input.provider !== agent.provider,
    event: {
      organizationId: agent.organizationId,
      type: "agent.provider_changed",
      payload: {
        by: "owner",
        agentId: agent.id,
        from: current,
        to: { provider: input.provider, model: input.model },
      },
    },
  };
}
