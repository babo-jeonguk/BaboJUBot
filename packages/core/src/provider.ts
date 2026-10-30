import {
  isClosedStage,
  unlimitedConcurrentRuns,
  type Agent,
  type LifecycleStage,
  type NewEvent,
  type ProviderChoice,
} from "@babojubot/contracts";

// 에이전트별 프로바이더·모델과 프로바이더 연결별 동시 실행 상한(#94).

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
 */
export function planAgentProviderChange(
  agent: Pick<Agent, "id" | "organizationId" | "provider" | "model">,
  stage: LifecycleStage,
  input: ProviderChoice
):
  | { update: ProviderChoice; event: NewEvent }
  | "unchanged"
  | "organization_closed" {
  if (isClosedStage(stage)) return "organization_closed";
  if (input.provider === agent.provider && input.model === agent.model)
    return "unchanged";
  return {
    update: { provider: input.provider, model: input.model },
    event: {
      organizationId: agent.organizationId,
      type: "agent.provider_changed",
      payload: {
        by: "owner",
        agentId: agent.id,
        from: { provider: agent.provider, model: agent.model },
        to: { provider: input.provider, model: input.model },
      },
    },
  };
}
