import type {
  AddWorkerInput,
  AddWorkerResult,
  PublicActivity,
} from "@babojubot/contracts";
import {
  buildAddWorkerProposal,
  planAddWorker,
  type HarnessLibraryContents,
  type RecordSource,
} from "@babojubot/core";
import { toApprovalSummary } from "./approvals.ts";
import type { Database } from "./client.ts";
import {
  agentNamesOf,
  insertEvent,
  instructionCopyRow,
  toAgent,
  toOrganization,
} from "./rows.ts";
import { agents, approvals, instructionCopies } from "./schema.ts";
import { toolWrite, type ActiveRunRef, type ToolWrite } from "./tool-calls.ts";

/**
 * Lead의 작업자 추가. 조직 행 잠금 아래에서 읽은 최신 승인 정책으로 갈린다. 꺼져 있으면 작업자·그 사본·Event를,
 * 켜져 있으면 승인 요청·Event만 같은 transaction에 저장하고 조직 단계는 그대로 둔다.
 */
export function addWorker(
  db: Database,
  run: ActiveRunRef,
  input: AddWorkerInput,
  options: {
    library: HarnessLibraryContents;
    source: RecordSource;
    activity: PublicActivity;
  }
): Promise<ToolWrite<AddWorkerResult, "unknown_role">> {
  return toolWrite<AddWorkerResult, "unknown_role">(
    db,
    run,
    "add_worker",
    options.activity,
    async (tx, locked, org) => {
      const proposal = buildAddWorkerProposal(input, options.library);
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
          .values({
            ...plan.worker,
            createdAt: new Date(plan.worker.createdAt),
          })
          .returning();
        await tx
          .insert(instructionCopies)
          .values(plan.copies.map(instructionCopyRow));
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
