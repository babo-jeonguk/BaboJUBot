import type { InstructionFile, WakeReason } from "@babojubot/contracts";
import { decisionOfStatus, type PendingWake } from "@babojubot/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type Executor } from "./rows.ts";
import {
  agentToAgentMessages,
  approvals,
  instructionCopies,
  instructionRevisions,
  messages,
  researchMapEdits,
  resultSubmissions,
  runs,
  runWakes,
  taskComments,
  tasks,
  wakes,
} from "./schema.ts";

// 실행 시도 쪽이 함께 쓰는 읽기: 깨우기와 그 사유, 진행 중 실행 시도, 지침 사본. admission(runs.ts)과 실행 시도·에이전트 화면
// 조회(run-views.ts)가 쓴다. DB 안에서만 쓰며 패키지 밖으로 내보내지 않는다(index.ts에 없음).

export async function findRunningRunId(db: Executor, agentId: string) {
  const [active] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")))
    .limit(1);
  return active?.id;
}

/** 에이전트의 지침 사본. bundle 버전 계산과 프로바이더 전달에 쓴다. */
export async function selectInstructions(
  db: Executor,
  agentId: string
): Promise<InstructionFile[]> {
  return db
    .select({
      path: instructionCopies.path,
      content: instructionCopies.content,
    })
    .from(instructionCopies)
    .where(eq(instructionCopies.agentId, agentId))
    .orderBy(asc(instructionCopies.path));
}

/** 실행 시도가 받은 깨우기. 서버 재시작으로 다시 대기한 깨우기도 받았던 실행 시도의 기록에 남는다. */
export const selectRunWakes = (db: Executor, runId: string) =>
  selectWakes(
    db,
    inArray(
      wakes.id,
      db
        .select({ id: runWakes.wakeId })
        .from(runWakes)
        .where(eq(runWakes.runId, runId))
    )
  );

/** 깨우기와 그 사유. 사유는 깨우기가 가리키는 기록(메시지, 승인 결정, 작업, 작업 댓글, 에이전트 메시지, 연구 지도 편집, 결과 수정 요청)에서 읽는다. heartbeat는 가리키는 기록이 없다. */
export async function selectWakes(
  db: Executor,
  where: ReturnType<typeof and> | ReturnType<typeof inArray>
): Promise<PendingWake[]> {
  const rows = await db
    .select({
      wake: wakes,
      body: messages.body,
      delivery: messages.delivery,
      conversationId: messages.conversationId,
      approvalKind: approvals.kind,
      decision: approvals.status,
      note: approvals.decisionNote,
      task: {
        title: tasks.title,
        summary: tasks.reportSummary,
        completedBy: tasks.completedByAgentId,
      },
      comment: { taskId: taskComments.taskId, body: taskComments.body },
      agentToAgent: {
        sender: agentToAgentMessages.senderAgentId,
        body: agentToAgentMessages.body,
      },
      mapEdit: {
        operation: researchMapEdits.operation,
        nodeId: researchMapEdits.nodeId,
        summary: researchMapEdits.summary,
      },
      instructionEdit: {
        agentId: instructionRevisions.agentId,
        copyId: instructionRevisions.copyId,
        number: instructionRevisions.number,
        path: instructionCopies.path,
      },
      resultNote: resultSubmissions.decisionNote,
    })
    .from(wakes)
    .leftJoin(messages, eq(messages.id, wakes.messageId))
    .leftJoin(approvals, eq(approvals.id, wakes.approvalId))
    .leftJoin(tasks, eq(tasks.id, wakes.taskId))
    .leftJoin(taskComments, eq(taskComments.id, wakes.commentId))
    .leftJoin(
      agentToAgentMessages,
      eq(agentToAgentMessages.id, wakes.agentToAgentMessageId)
    )
    .leftJoin(researchMapEdits, eq(researchMapEdits.id, wakes.mapEditId))
    .leftJoin(
      instructionRevisions,
      eq(instructionRevisions.id, wakes.instructionRevisionId)
    )
    .leftJoin(
      instructionCopies,
      eq(instructionCopies.id, instructionRevisions.copyId)
    )
    .leftJoin(
      resultSubmissions,
      eq(resultSubmissions.id, wakes.resultSubmissionId)
    )
    .where(where)
    .orderBy(asc(wakes.seq));
  return rows.map(
    ({
      wake,
      body,
      delivery,
      conversationId,
      approvalKind,
      decision,
      note,
      task,
      comment,
      agentToAgent,
      mapEdit,
      instructionEdit,
      resultNote,
    }) => {
      const wakeId = wake.id;
      const reason = ((): WakeReason => {
        switch (wake.kind) {
          case "owner_message":
            return {
              kind: wake.kind,
              wakeId,
              messageId: wake.messageId!,
              conversationId: conversationId!,
              body: body!,
            };
          case "approval_decision":
            return {
              kind: wake.kind,
              wakeId,
              approvalId: wake.approvalId!,
              approvalKind: approvalKind!,
              decision: decisionOfStatus(decision!),
              note,
            };
          case "task_assigned":
            return {
              kind: wake.kind,
              wakeId,
              taskId: wake.taskId!,
              title: task!.title,
            };
          case "task_completed":
            return {
              kind: wake.kind,
              wakeId,
              taskId: wake.taskId!,
              title: task!.title,
              summary: task!.summary!,
              completedByAgentId: task!.completedBy!,
            };
          case "task_comment":
            return {
              kind: wake.kind,
              wakeId,
              taskId: comment!.taskId,
              commentId: wake.commentId!,
              body: comment!.body,
            };
          case "agent_to_agent_message":
            return {
              kind: wake.kind,
              wakeId,
              messageId: wake.agentToAgentMessageId!,
              senderAgentId: agentToAgent!.sender,
              body: agentToAgent!.body,
            };
          case "research_map_edit":
            return {
              kind: wake.kind,
              wakeId,
              editId: wake.mapEditId!,
              operation: mapEdit!.operation,
              nodeId: mapEdit!.nodeId,
              summary: mapEdit!.summary,
            };
          case "instruction_edit":
            return {
              kind: wake.kind,
              wakeId,
              revisionId: wake.instructionRevisionId!,
              agentId: instructionEdit!.agentId!,
              copyId: instructionEdit!.copyId!,
              path: instructionEdit!.path!,
              revision: instructionEdit!.number!,
            };
          case "result_changes_requested":
            return {
              kind: wake.kind,
              wakeId,
              submissionId: wake.resultSubmissionId!,
              note: resultNote!,
            };
          case "organization_created":
          case "heartbeat":
            return { kind: wake.kind, wakeId };
        }
      })();
      return {
        id: wake.id,
        organizationId: wake.organizationId,
        agentId: wake.agentId,
        createdAt: wake.createdAt.toISOString(),
        reason,
        delivery: wake.kind === "owner_message" ? delivery : null,
      };
    }
  );
}
