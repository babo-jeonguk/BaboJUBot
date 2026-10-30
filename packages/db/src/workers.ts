import type { AddWorkerInput, AddWorkerResult } from "@babojubot/contracts";
import {
  buildAddWorkerProposal,
  planAddWorker,
  type HarnessLibraryContents,
  type ProviderChoiceProblem,
  type ProviderModels,
  type RecordSource,
} from "@babojubot/core";
import { toApprovalSummary } from "./approvals.ts";
import type { Database } from "./client.ts";
import { insertInstructionCopies } from "./harness.ts";
import { readProviderDefaults } from "./providers.ts";
import {
  agentRow,
  agentNamesOf,
  insertEvent,
  toAgent,
  toOrganization,
} from "./rows.ts";
import { agents, approvals } from "./schema.ts";
import {
  toolWrite,
  type ActiveRunRef,
  type ToolCall,
  type ToolWrite,
} from "./tool-calls.ts";

export type AddWorkerProblem = "unknown_role" | ProviderChoiceProblem;

/**
 * Lead의 작업자 추가. 프로바이더를 비웠으면 지금의 작업자 기본값을 Lead 제안으로 고정하고, 적었으면 호출한 쪽이 잠금 밖에서
 * 받아 온 연결별 모델 목록(`connections`)으로 확인한다. 같은 호출 키의 재시도는 이 확인 전에 저장된 결과를 받는다.
 * 조직 행 잠금 아래에서 읽은 최신 승인 정책으로 갈린다. 꺼져 있으면 Lead 제안 프로바이더·모델의 작업자·그 사본·Event를,
 * 켜져 있으면 승인 요청·Event만 같은 transaction에 저장하고 조직 단계는 그대로 둔다.
 */
export function addWorker(
  db: Database,
  run: ActiveRunRef,
  input: AddWorkerInput,
  options: ToolCall & {
    library: HarnessLibraryContents;
    connections: ProviderModels;
    source: RecordSource;
  }
): Promise<ToolWrite<AddWorkerResult, AddWorkerProblem>> {
  return toolWrite<AddWorkerResult, AddWorkerProblem>(
    db,
    run,
    "add_worker",
    options,
    async (tx, locked, org) => {
      const proposal = buildAddWorkerProposal(input, options.library, {
        workerDefault: (await readProviderDefaults(tx)).workerDefault,
        connections: options.connections,
      });
      if (typeof proposal === "string")
        return { kind: "invalid", problem: proposal };
      const { approvalPolicy: policy, stage } = toOrganization(org);
      const plan = planAddWorker(
        locked,
        proposal,
        {
          policy,
          stage,
          agentNames: await agentNamesOf(tx, locked.organizationId),
        },
        options.source
      );
      if (plan.kind === "added") {
        const [worker] = await tx
          .insert(agents)
          .values(agentRow(plan.worker))
          .returning();
        await insertInstructionCopies(tx, plan.copies);
        const event = await insertEvent(tx, plan.event);
        return {
          kind: "ok",
          value: { status: "added", agent: toAgent(worker!) },
          events: [event],
        };
      }
      const [row] = await tx
        .insert(approvals)
        .values({
          ...plan.approval,
          status: "pending",
          createdAt: new Date(plan.approval.createdAt),
        })
        .returning();
      const event = await insertEvent(tx, plan.event);
      return {
        kind: "ok",
        value: {
          status: "pending_approval",
          approval: toApprovalSummary(row!),
        },
        events: [event],
      };
    }
  );
}
