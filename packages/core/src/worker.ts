import {
  defaultHeartbeatMinutes,
  resolveProposedChoice,
  type AddWorkerInput,
  type AddWorkerProposal,
  type ApprovalPolicy,
  type InstructionCopy,
  type LifecycleStage,
  type NewEvent,
  type ProviderChoice,
} from "@babojubot/contracts";
import { agentNameKey, isAgentNameTaken } from "./agent-profile.ts";
import type { NewApproval, RunRef } from "./approval.ts";
import { copyInstructions, type HarnessLibraryContents } from "./harness.ts";
import type { NewAgent, RecordSource } from "./organization.ts";

// Lead의 작업자 추가. 승인 정책(ADR-0003)이 꺼져 있으면 곧바로 작업자를 만들고, 켜져 있으면 승인 요청만 남긴다.
// 어느 쪽이든 호출할 때 읽은 라이브러리 내용을 고정하며, 승인 때 라이브러리를 다시 읽지 않는다.

/** 지금 요청으로 만든 작업자 추가 snapshot. Lead 제안 프로바이더·모델이 언제나 있다(예전 요청에만 없음). */
export type AddWorkerProposalWithChoice = AddWorkerProposal & {
  choice: ProviderChoice;
};

/**
 * 작업자 추가 대상 snapshot. Role은 라이브러리의 작업자 Role이어야 한다.
 * 이 snapshot이 곧바로 만드는 작업자의 사본이자 승인 요청에서 사용자가 검토하는 내용이다.
 * 프로바이더를 비웠으면 호출할 때 읽은 전역 작업자 기본값(`workerDefault`)을 Lead 제안으로 고정한다.
 */
export function buildAddWorkerProposal(
  input: AddWorkerInput,
  library: HarnessLibraryContents,
  workerDefault: ProviderChoice
): AddWorkerProposalWithChoice | "unknown_role" {
  const role = library.roles.get(input.role);
  if (!role || role.agent !== "worker") return "unknown_role";
  return {
    role: input.role,
    label: role.label,
    files: role.files,
    heartbeatMinutes: role.heartbeatMinutes,
    choice: resolveProposedChoice(input, workerDefault),
  };
}

/**
 * 새 작업자의 이름 `<Role 표시 이름> N`. `agentNames`는 조직의 모든 에이전트(Lead·작업자) 이름이다.
 * N은 같은 표시 이름을 쓰는 이름(`agentNameKey` 기준) 가운데 가장 큰 번호 + 1이며, 그 이름을 다른 에이전트가 이미 쓰면
 * 다음 번호로 넘어가 조직 안에서 겹치지 않는 이름을 낸다.
 */
export function nextWorkerName(label: string, agentNames: string[]) {
  const prefix = `${agentNameKey(label)} `;
  const numbers = agentNames.flatMap((name) => {
    const key = agentNameKey(name);
    const rest = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    return /^[1-9]\d*$/.test(rest) ? [Number(rest)] : [];
  });
  let n = Math.max(0, ...numbers) + 1;
  while (isAgentNameTaken(`${label.trim()} ${n}`, agentNames)) n++;
  return `${label.trim()} ${n}`;
}

/**
 * snapshot에서 작업자 한 명과 그 작업자만의 Role·Soul·Skill 사본을 만든다. 기본 heartbeat 간격도 snapshot의 Role 값이다.
 * `agentNames`는 조직의 모든 에이전트 이름이며 함께 만드는 작업자가 있으면 그 이름도 넣는다(`nextWorkerName`).
 * 프로바이더·모델은 결정한 값(`choice`)이다. 나중에 전역 기본값이 바뀌어도 그대로다.
 */
export function planWorker(
  organizationId: string,
  proposal: Pick<AddWorkerProposal, "label" | "files" | "heartbeatMinutes">,
  agentNames: string[],
  {
    newId,
    createdAt,
    choice,
  }: { newId: () => string; createdAt: string; choice: ProviderChoice }
): { worker: NewAgent; copies: InstructionCopy[] } {
  const worker: NewAgent = {
    id: newId(),
    organizationId,
    role: "worker",
    name: nextWorkerName(proposal.label, agentNames),
    provider: choice.provider,
    model: choice.model,
    createdAt,
    heartbeatMinutes: proposal.heartbeatMinutes ?? defaultHeartbeatMinutes,
  };
  return {
    worker,
    copies: copyInstructions(worker, proposal.files, { newId, createdAt }),
  };
}

export type AddWorkerPlan =
  | {
      kind: "added";
      worker: NewAgent;
      copies: InstructionCopy[];
      event: NewEvent;
    }
  | { kind: "pending_approval"; approval: NewApproval; event: NewEvent };

/**
 * 지금의 승인 정책으로 작업자 추가를 정한다. 정책은 호출한 쪽이 조직 행 잠금 아래에서 읽은 최신 값이어야 한다.
 * 승인 요청은 조직 단계를 바꾸지 않고, 같은 Role이라도 호출마다 따로다. 곧바로 만드는 작업자는 Lead 제안 프로바이더·모델을 쓴다.
 */
export function planAddWorker(
  run: RunRef,
  proposal: AddWorkerProposalWithChoice,
  {
    policy,
    stage,
    agentNames,
  }: {
    policy: ApprovalPolicy;
    stage: LifecycleStage;
    agentNames: string[];
  },
  { newId, now }: RecordSource
): AddWorkerPlan {
  const createdAt = now().toISOString();
  if (!policy.addWorker) {
    const { worker, copies } = planWorker(
      run.organizationId,
      proposal,
      agentNames,
      { newId, createdAt, choice: proposal.choice }
    );
    return {
      kind: "added",
      worker,
      copies,
      event: {
        organizationId: run.organizationId,
        type: "worker.added",
        payload: {
          runId: run.id,
          agentId: run.agentId,
          workerAgentId: worker.id,
          role: proposal.role,
        },
      },
    };
  }
  const approval: NewApproval = {
    id: newId(),
    organizationId: run.organizationId,
    kind: "add_worker",
    requestedByAgentId: run.agentId,
    requestedByRunId: run.id,
    previousApprovalId: null,
    proposal,
    createdAt,
  };
  return {
    kind: "pending_approval",
    approval,
    event: {
      organizationId: run.organizationId,
      type: "approval.requested",
      payload: {
        approvalId: approval.id,
        kind: approval.kind,
        runId: run.id,
        agentId: run.agentId,
        stage,
      },
    },
  };
}
