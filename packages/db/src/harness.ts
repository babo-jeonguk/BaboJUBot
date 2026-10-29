import type {
  AgentInstructions,
  EditInstructionCopyInput,
  FlowTemplateCopy,
  InstructionCopy,
  InstructionEditor,
  InstructionRevision,
  InstructionRevisionSummary,
} from "@babojubot/contracts";
import {
  findLead,
  instructionsBundleVersion,
  planInstructionEdit,
  type InstructionEditProblem,
  type RecordSource,
} from "@babojubot/core";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { refused, stored, type Stored } from "./stored.ts";
import {
  insertEvent,
  instructionCopyRow,
  isUuid,
  lockOrganization,
  toInstructionCopy,
  withIsoTime,
  type Executor,
} from "./rows.ts";
import {
  agents,
  flowTemplates,
  instructionCopies,
  instructionRevisions,
  wakes,
} from "./schema.ts";

/** 사본 하나를 가리키는 범위. 조직·에이전트·사본이 모두 맞아야 찾는다. */
export type InstructionCopyRef = {
  organizationId: string;
  agentId: string;
  copyId: string;
};

const isCopyRef = (ref: InstructionCopyRef) =>
  [ref.organizationId, ref.agentId, ref.copyId].every(isUuid);

/**
 * 새 에이전트의 지침 사본을 저장한다. 복사한 처음 내용을 사본마다 revision 1(편집자 `copy`, 시각은 사본을 만든 때)로 함께 남긴다.
 * 사본을 만드는 transaction(조직 생성·승인 결정·작업자 추가) 안에서 부른다.
 */
export async function insertInstructionCopies(
  tx: Executor,
  copies: InstructionCopy[]
): Promise<void> {
  if (!copies.length) return;
  await tx.insert(instructionCopies).values(copies.map(instructionCopyRow));
  await tx.insert(instructionRevisions).values(
    copies.map((copy) => ({
      organizationId: copy.organizationId,
      agentId: copy.agentId,
      copyId: copy.id,
      number: copy.revision,
      editorAuthor: "copy" as const,
      content: copy.content,
      createdAt: new Date(copy.createdAt),
    }))
  );
}

/** 에이전트의 Role·Soul·Skill 사본과 그 내용의 bundle 버전. 다른 조직의 에이전트와 없는 에이전트를 구별하지 않는다. */
export async function findAgentInstructions(
  db: Database,
  organizationId: string,
  agentId: string
): Promise<AgentInstructions | undefined> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return undefined;
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
    );
  if (!agent) return undefined;
  const rows = await db
    .select()
    .from(instructionCopies)
    .where(
      and(
        eq(instructionCopies.organizationId, organizationId),
        eq(instructionCopies.agentId, agentId)
      )
    )
    .orderBy(asc(instructionCopies.path));
  const copies = rows.map(toInstructionCopy);
  return {
    agentId,
    bundleVersion: instructionsBundleVersion(copies),
    copies,
  };
}

/**
 * 사용자의 사본 편집. 조직 행을 잠근 뒤 그 조직·에이전트의 사본을 읽어 core 규칙을 적용하고, 바뀐 사본·새 revision·편집 사유의
 * Lead 깨우기·Event를 한 transaction에 저장한 뒤 commit 뒤 Lead를 깨운다. 값은 바뀐 사본이다. 실행 시도 admission도 조직 행을 잠근 뒤
 * 사본을 읽으므로 실행 시도는 편집 전이나 뒤의 사본 하나를 받는다. 진행 중 실행 시도는 시작할 때 받은 지침으로 끝까지 간다.
 * 다른 조직·다른 에이전트의 사본과 없는 사본은 같은 `not_found`다.
 */
export async function editInstructionCopy(
  db: Database,
  ref: InstructionCopyRef,
  input: EditInstructionCopyInput,
  source: RecordSource
): Promise<Stored<InstructionCopy, "not_found" | InstructionEditProblem>> {
  const { organizationId, agentId, copyId } = ref;
  if (!isCopyRef(ref)) return refused("not_found");
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return refused("not_found");
    const [row] = await tx
      .select()
      .from(instructionCopies)
      .where(copyWhere(ref));
    if (!row) return refused("not_found");
    const lead = findLead(
      await tx
        .select({ id: agents.id, role: agents.role })
        .from(agents)
        .where(eq(agents.organizationId, organizationId))
    );
    if (!lead) throw new Error(`organization ${organizationId} has no Lead`);
    const plan = planInstructionEdit(
      { copy: toInstructionCopy(row), stage: org.stage, leadAgentId: lead.id },
      input,
      source
    );
    if (typeof plan === "string") return refused(plan);
    const [updated] = await tx
      .update(instructionCopies)
      .set({ content: plan.copy.content, revision: plan.copy.revision })
      .where(
        and(
          copyWhere(ref),
          eq(instructionCopies.revision, input.expectedRevision)
        )
      )
      .returning({ id: instructionCopies.id });
    if (!updated)
      throw new Error(`instruction copy ${copyId} changed under the lock`);
    const { revision } = plan;
    await tx.insert(instructionRevisions).values({
      id: revision.id,
      organizationId,
      agentId,
      copyId,
      number: revision.number,
      ...editorRow(revision.editor),
      content: revision.content,
      createdAt: new Date(revision.createdAt),
    });
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    return stored(plan.copy, {
      events: [await insertEvent(tx, plan.event)],
      woken: [plan.wake.agentId],
    });
  });
}

/** 사본의 revision 목록(최근 것부터). 본문은 담지 않는다. 다른 조직·다른 에이전트의 사본과 없는 사본은 없다(`undefined`). */
export async function listInstructionRevisions(
  db: Executor,
  ref: InstructionCopyRef
): Promise<InstructionRevisionSummary[] | undefined> {
  if (!isCopyRef(ref)) return undefined;
  const [copy] = await db
    .select({ id: instructionCopies.id })
    .from(instructionCopies)
    .where(copyWhere(ref));
  if (!copy) return undefined;
  const rows = await db
    .select(revisionSummaryColumns)
    .from(instructionRevisions)
    .where(revisionWhere(ref))
    .orderBy(desc(instructionRevisions.number));
  return rows.map(toRevisionSummary);
}

/** 사본 revision 하나와 그때의 전체 본문. 다른 조직·다른 에이전트의 사본과 없는 번호를 구별하지 않는다. */
export async function findInstructionRevision(
  db: Executor,
  ref: InstructionCopyRef,
  number: number
): Promise<InstructionRevision | undefined> {
  if (!isCopyRef(ref)) return undefined;
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  const [row] = await db
    .select({
      ...revisionSummaryColumns,
      path: instructionCopies.path,
      content: instructionRevisions.content,
    })
    .from(instructionRevisions)
    .innerJoin(
      instructionCopies,
      eq(instructionCopies.id, instructionRevisions.copyId)
    )
    .where(and(revisionWhere(ref), eq(instructionRevisions.number, number)));
  if (!row) return undefined;
  const { path, content, ...summary } = row;
  return { ...toRevisionSummary(summary), path, content };
}

/** 조직의 연구 흐름 템플릿 사본. 초기 연구 승인 전에는 없다. */
export async function findFlowTemplate(
  db: Database,
  organizationId: string
): Promise<FlowTemplateCopy | undefined> {
  if (!isUuid(organizationId)) return undefined;
  const [row] = await db
    .select()
    .from(flowTemplates)
    .where(eq(flowTemplates.organizationId, organizationId));
  return row && withIsoTime(row);
}

const copyWhere = (ref: InstructionCopyRef) =>
  and(
    eq(instructionCopies.organizationId, ref.organizationId),
    eq(instructionCopies.agentId, ref.agentId),
    eq(instructionCopies.id, ref.copyId)
  );

const revisionWhere = (ref: InstructionCopyRef) =>
  and(
    eq(instructionRevisions.organizationId, ref.organizationId),
    eq(instructionRevisions.agentId, ref.agentId),
    eq(instructionRevisions.copyId, ref.copyId)
  );

const revisionSummaryColumns = {
  id: instructionRevisions.id,
  organizationId: instructionRevisions.organizationId,
  agentId: instructionRevisions.agentId,
  copyId: instructionRevisions.copyId,
  number: instructionRevisions.number,
  editorAuthor: instructionRevisions.editorAuthor,
  editorAgentId: instructionRevisions.editorAgentId,
  editorRunId: instructionRevisions.editorRunId,
  createdAt: instructionRevisions.createdAt,
};

const editorRow = (editor: InstructionEditor) => ({
  editorAuthor: editor.author,
  editorAgentId: editor.author === "agent" ? editor.agentId : null,
  editorRunId: editor.author === "agent" ? editor.runId : null,
});

const toRevisionSummary = ({
  editorAuthor,
  editorAgentId,
  editorRunId,
  createdAt,
  ...row
}: Omit<
  typeof instructionRevisions.$inferSelect,
  "content"
>): InstructionRevisionSummary => ({
  ...row,
  editor:
    editorAuthor === "agent"
      ? { author: editorAuthor, agentId: editorAgentId!, runId: editorRunId! }
      : { author: editorAuthor },
  createdAt: createdAt.toISOString(),
});
