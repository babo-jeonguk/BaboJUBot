import type { AddWorkerInput, AddWorkerResult } from "@babojubot/contracts";
import {
  buildAddWorkerProposal,
  planAddWorker,
  type HarnessLibraryContents,
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

/**
 * Lead의 작업자 추가. 프로바이더를 비웠으면 지금의 작업자 기본값을 Lead 제안으로 고정한다.
 * 조직 행 잠금 아래에서 읽은 최신 승인 정책으로 갈린다. 꺼져 있으면 Lead 제안 프로바이더·모델의 작업자·그 사본·Event를,
 * 켜져 있으면 승인 요청·Event만 같은 transaction에 저장하고 조직 단계는 그대로 둔다.
 */
export function addWorker(
  db: Database,
  run: ActiveRunRef,
  input: AddWorkerInput,
  options: ToolCall & {
    library: HarnessLibraryContents;
    source: RecordSource;
  }
): Promise<ToolWrite<AddWorkerResult, "unknown_role">> {
  return toolWrite<AddWorkerResult, "unknown_role">(
    db,
    run,
    "add_worker",
    options,
    async (tx, locked, org) => {
      const proposal = buildAddWorkerProposal(
        input,
        options.library,
        (await readProviderDefaults(tx)).workerDefault
      );
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
