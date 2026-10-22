import {
  defaultHeartbeatMinutes,
  type AddWorkerInput,
  type AddWorkerProposal,
  type ApprovalPolicy,
  type InstructionCopy,
  type LifecycleStage,
  type NewEvent,
} from "@babojubot/contracts";
import type { NewApproval, RunRef } from "./approval.ts";
import { copyInstructions, type HarnessLibraryContents } from "./harness.ts";
import type { NewAgent, RecordSource } from "./organization.ts";

// Lead의 작업자 추가. 승인 정책(ADR-0003)이 꺼져 있으면 곧바로 작업자를 만들고, 켜져 있으면 승인 요청만 남긴다.
// 어느 쪽이든 호출할 때 읽은 라이브러리 내용을 고정하며, 승인 때 라이브러리를 다시 읽지 않는다.

/**
 * 작업자 추가 대상 snapshot. Role은 라이브러리의 작업자 Role이어야 한다.
 * 이 snapshot이 곧바로 만드는 작업자의 사본이자 승인 요청에서 사용자가 검토하는 내용이다.
 */
export function buildAddWorkerProposal(
  input: AddWorkerInput,
  library: HarnessLibraryContents
): AddWorkerProposal | "unknown_role" {
  const role = library.roles.get(input.role);
  if (!role || role.agent !== "worker") return "unknown_role";
  return {
    role: input.role,
    label: role.label,
    files: role.files,
    heartbeatMinutes: role.heartbeatMinutes,
  };
}

/** 새 작업자의 이름: Role 표시 이름 뒤에 같은 이름의 작업자 중 가장 큰 번호 + 1. */
export function nextWorkerName(label: string, existingNames: string[]) {
  const prefix = `${label} `;
  const taken = existingNames.flatMap((name) => {
    const rest = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    return /^[1-9]\d*$/.test(rest) ? [Number(rest)] : [];
  });
  return `${prefix}${Math.max(0, ...taken) + 1}`;
}

/** snapshot에서 작업자 한 명과 그 작업자만의 Role·Soul·Skill 사본을 만든다. 기본 heartbeat 간격도 snapshot의 Role 값이다. */
export function planWorker(
  organizationId: string,
  proposal: Pick<AddWorkerProposal, "label" | "files" | "heartbeatMinutes">,
  agentNames: string[],
  { newId, createdAt }: { newId: () => string; createdAt: string }
): { worker: NewAgent; copies: InstructionCopy[] } {
  const worker: NewAgent = {
    id: newId(),
    organizationId,
    role: "worker",
    name: nextWorkerName(proposal.label, agentNames),
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
 * 승인 요청은 조직 단계를 바꾸지 않고, 같은 Role이라도 호출마다 따로다.
 */
export function planAddWorker(
  run: RunRef,
  proposal: AddWorkerProposal,
  {
    policy,
    stage,
    agentNames,
  }: { policy: ApprovalPolicy; stage: LifecycleStage; agentNames: string[] },
  { newId, now }: RecordSource
): AddWorkerPlan {
  const createdAt = now().toISOString();
  if (!policy.addWorker) {
    const { worker, copies } = planWorker(
      run.organizationId,
      proposal,
      agentNames,
      { newId, createdAt }
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
