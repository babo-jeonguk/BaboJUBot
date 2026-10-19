import type {
  CreateResearchNodeInput,
  Event,
  MapActor,
  OrgToolName,
  PublicActivity,
  ResearchLink,
  ResearchMap,
  ResearchMapEdit,
  ResearchNode,
  ResearchNodeDetail,
  Task,
  UpdateResearchNodeInput,
} from "@babojubot/contracts";
import {
  acceptsOwnerMapEdit,
  findLead,
  planDiscard,
  planLinkAddition,
  planNodeCreation,
  planNodeUpdate,
  planParentChange,
  planRestore,
  planTaskNodeLink,
  type MapEditor,
  type MapEditPlan,
  type MapPlan,
  type MapRuleProblem,
  type MapSnapshot,
  type RecordSource,
  type Wake,
} from "@babojubot/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  artifactSummaryColumns,
  insertEvent,
  isUuid,
  lockOrganization,
  toTask,
  type Executor,
} from "./rows.ts";
import {
  agents,
  artifacts,
  flowTemplates,
  researchLinks,
  researchMapEdits,
  researchNodes,
  tasks,
  wakes,
} from "./schema.ts";
import { toolWrite, type ActiveRunRef, type ToolWrite } from "./tool-calls.ts";

// 연구 지도의 저장. 에이전트 도구와 사용자 편집 모두 조직 행 잠금 아래에서 최신 지도(조직 사본 템플릿·모든 노드)를 따로 읽어
// core 규칙을 적용하므로, 같은 조직의 동시 구조 편집이 순환을 남기지 않는다. 변경·편집 기록·Event와 사용자 편집의 Lead 깨우기는
// 한 transaction에 저장한다. 다른 조직의 기록과 없는 기록은 같은 `not_found`다.

/** 연구 지도 편집 명령 하나. 에이전트 도구와 사용자 편집이 같은 명령과 규칙을 쓴다. */
export type MapCommand =
  | {
      op: "create_node";
      input: Required<Omit<CreateResearchNodeInput, "parentNodeId">> &
        Pick<CreateResearchNodeInput, "parentNodeId">;
    }
  | { op: "update_node"; nodeId: string; input: UpdateResearchNodeInput }
  | { op: "assign_parent"; nodeId: string; parentNodeId: string }
  | { op: "change_parent"; nodeId: string; parentNodeId: string | null }
  | {
      op: "add_link";
      input: { sourceNodeId: string; targetNodeId: string; kind: string };
    }
  | { op: "discard_node" | "restore_node"; nodeId: string }
  | { op: "link_task" | "relink_task"; taskId: string; researchNodeId: string }
  | { op: "unlink_task"; taskId: string };

/** 명령이 돌려주는 기록: 보조 연결 추가는 보조 연결, 작업 연결 명령은 작업, 나머지는 노드. */
export type MapCommandValue<C extends MapCommand> = C extends { op: "add_link" }
  ? ResearchLink
  : C extends { op: "link_task" | "relink_task" | "unlink_task" }
    ? Task
    : ResearchNode;

/** 명령마다 쓰는 조직 도구. 거부 Event와 공개 활동이 이 이름으로 남는다. */
export const mapCommandTools = {
  create_node: "create_research_node",
  update_node: "update_research_node",
  assign_parent: "assign_research_node_parent",
  change_parent: "change_research_node_parent",
  add_link: "add_research_link",
  discard_node: "discard_research_node",
  restore_node: "restore_research_node",
  link_task: "link_task_research_node",
  relink_task: "relink_task_research_node",
  unlink_task: "unlink_task_research_node",
} as const satisfies Record<MapCommand["op"], OrgToolName>;

/** 에이전트의 연구 지도 편집 도구. 실행 시도 → 조직 잠금과 단계 규칙은 `toolWrite`가 맡는다. 에이전트 편집은 아무도 깨우지 않는다. */
export function writeResearchMap<C extends MapCommand>(
  db: Database,
  run: ActiveRunRef,
  command: C,
  { source, activity }: { source: RecordSource; activity: PublicActivity }
): Promise<ToolWrite<MapCommandValue<C>, MapRuleProblem>> {
  return toolWrite(
    db,
    run,
    mapCommandTools[command.op],
    activity,
    async (tx, locked) => {
      const map = await loadMap(tx, locked.organizationId);
      // 연구 진행 단계의 조직은 초기 연구 승인으로 템플릿 사본을 갖는다.
      if (!map)
        throw new Error(
          `organization ${locked.organizationId} has no template`
        );
      const result = await apply(
        tx,
        map,
        { author: "agent", agentId: locked.agentId, runId: locked.id },
        command,
        source
      );
      if (result.kind !== "ok") return result;
      return {
        kind: "ok",
        value: result.value,
        events: result.event ? [result.event] : [],
      };
    }
  );
}

export type OwnerMapEditResult<T> =
  | { kind: "ok"; value: T; event: Event | undefined; wake: Wake | undefined }
  | { kind: "invalid"; problem: MapRuleProblem }
  | { kind: "stage_closed" };

/**
 * 사용자의 연구 지도 편집. 조직 행을 잠근 뒤 편집을 받는 단계(초기 연구 승인 뒤, 최종 완료·중단 전)인지 확인하고, 변경·편집 기록·
 * Lead 깨우기·Event를 한 transaction에 저장한다. 지금과 같은 값이면 아무것도 남기지 않는다. 없는 조직은 `not_found`다.
 */
export async function editResearchMap<C extends MapCommand>(
  db: Database,
  organizationId: string,
  command: C,
  source: RecordSource
): Promise<OwnerMapEditResult<MapCommandValue<C>>> {
  if (!isUuid(organizationId)) return { kind: "invalid", problem: "not_found" };
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return { kind: "invalid", problem: "not_found" };
    const map = await loadMap(tx, organizationId);
    if (!acceptsOwnerMapEdit(org.stage) || !map)
      return { kind: "stage_closed" };
    const lead = findLead(
      await tx
        .select({ id: agents.id, role: agents.role })
        .from(agents)
        .where(eq(agents.organizationId, organizationId))
    );
    if (!lead) throw new Error(`organization ${organizationId} has no Lead`);
    return apply(
      tx,
      map,
      { author: "owner", leadAgentId: lead.id },
      command,
      source
    );
  });
}

// ---------- 조회 ----------

/** 조직의 연구 지도 전체. 없는 조직은 빈 지도다. */
export async function getResearchMap(
  db: Executor,
  organizationId: string
): Promise<ResearchMap> {
  if (!isUuid(organizationId)) return { nodes: [], links: [] };
  const nodes = await db
    .select()
    .from(researchNodes)
    .where(eq(researchNodes.organizationId, organizationId))
    .orderBy(asc(researchNodes.seq));
  const links = await db
    .select()
    .from(researchLinks)
    .where(eq(researchLinks.organizationId, organizationId))
    .orderBy(asc(researchLinks.seq));
  return { nodes: nodes.map(toNode), links: links.map(toLink) };
}

/** 노드 상세: 연결 작업과 그 산출물, 편집 기록. 다른 조직의 노드와 없는 노드를 구별하지 않는다. */
export async function findResearchNodeDetail(
  db: Executor,
  organizationId: string,
  nodeId: string
): Promise<ResearchNodeDetail | undefined> {
  if (!isUuid(organizationId) || !isUuid(nodeId)) return undefined;
  const [row] = await db
    .select()
    .from(researchNodes)
    .where(
      and(
        eq(researchNodes.organizationId, organizationId),
        eq(researchNodes.id, nodeId)
      )
    );
  if (!row) return undefined;
  const linked = (
    await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          eq(tasks.researchNodeId, nodeId)
        )
      )
      .orderBy(asc(tasks.seq))
  ).map(toTask);
  const taskArtifacts = linked.length
    ? await db
        .select(artifactSummaryColumns)
        .from(artifacts)
        .where(
          and(
            eq(artifacts.organizationId, organizationId),
            inArray(
              artifacts.taskId,
              linked.map((t) => t.id)
            )
          )
        )
        .orderBy(asc(artifacts.seq))
    : [];
  const edits = await db
    .select()
    .from(researchMapEdits)
    .where(
      and(
        eq(researchMapEdits.organizationId, organizationId),
        eq(researchMapEdits.nodeId, nodeId)
      )
    )
    .orderBy(asc(researchMapEdits.seq));
  return {
    ...toNode(row),
    tasks: linked,
    artifacts: taskArtifacts.map(({ createdAt, ...a }) => ({
      ...a,
      createdAt: createdAt.toISOString(),
    })),
    edits: edits.map(toEdit),
  };
}

// ---------- 내부 ----------

/** 조직 사본 템플릿과 모든 노드. 템플릿이 없으면(초기 연구 승인 전) `undefined`. 잠금 뒤 별도 statement로 읽는다. */
async function loadMap(
  tx: Executor,
  organizationId: string
): Promise<MapSnapshot | undefined> {
  const [template] = await tx
    .select({
      nodeKinds: flowTemplates.nodeKinds,
      linkKinds: flowTemplates.linkKinds,
    })
    .from(flowTemplates)
    .where(eq(flowTemplates.organizationId, organizationId));
  if (!template) return undefined;
  const rows = await tx
    .select()
    .from(researchNodes)
    .where(eq(researchNodes.organizationId, organizationId));
  return {
    organizationId,
    ...template,
    nodes: new Map(rows.map((r) => [r.id, toNode(r)])),
  };
}

type Applied<T> =
  | { kind: "ok"; value: T; event: Event | undefined; wake: Wake | undefined }
  | { kind: "invalid"; problem: MapRuleProblem };

/** 명령에 규칙을 적용하고, 편집이면 변경·편집 기록·깨우기·Event를 저장한다. */
async function apply<C extends MapCommand>(
  tx: Executor,
  map: MapSnapshot,
  editor: MapEditor,
  command: C,
  source: RecordSource
): Promise<Applied<MapCommandValue<C>>> {
  const c = command as MapCommand;
  let plan: MapPlan<unknown>;
  switch (c.op) {
    case "create_node":
      plan = planNodeCreation(map, editor, c.input, source);
      break;
    case "update_node":
      plan = planNodeUpdate(map, editor, c.nodeId, c.input, source);
      break;
    case "assign_parent":
    case "change_parent":
      plan = planParentChange(
        map,
        editor,
        c.nodeId,
        c.parentNodeId,
        c.op === "assign_parent" ? "assign" : "change",
        source
      );
      break;
    case "add_link":
      plan = planLinkAddition(map, editor, c.input, source);
      break;
    case "discard_node":
      plan = planDiscard(map, editor, c.nodeId, source);
      break;
    case "restore_node":
      plan = planRestore(map, editor, c.nodeId, source);
      break;
    case "link_task":
    case "relink_task":
    case "unlink_task": {
      const task = await selectTaskRow(tx, map.organizationId, c.taskId);
      if (!task) return { kind: "invalid", problem: "not_found" };
      plan = planTaskNodeLink(
        map,
        editor,
        task,
        c.op === "unlink_task" ? null : c.researchNodeId,
        c.op === "link_task"
          ? "link"
          : c.op === "relink_task"
            ? "relink"
            : "unlink",
        source
      );
      if (typeof plan === "string") return { kind: "invalid", problem: plan };
      const event = plan.kind === "edit" ? await store(tx, plan) : undefined;
      const updated = await selectTaskRow(tx, map.organizationId, c.taskId);
      return {
        kind: "ok",
        value: toTask(updated!) as MapCommandValue<C>,
        event,
        wake: plan.kind === "edit" ? plan.wake : undefined,
      };
    }
  }
  if (typeof plan === "string") return { kind: "invalid", problem: plan };
  if (plan.kind === "unchanged")
    return {
      kind: "ok",
      value: plan.value as MapCommandValue<C>,
      event: undefined,
      wake: undefined,
    };
  return {
    kind: "ok",
    value: plan.value as MapCommandValue<C>,
    event: await store(tx, plan),
    wake: plan.wake,
  };
}

async function store(
  tx: Executor,
  plan: Extract<MapEditPlan<unknown>, { kind: "edit" }>
) {
  const { change } = plan;
  switch (change.type) {
    case "insert_node":
      await tx.insert(researchNodes).values(nodeRow(change.node));
      break;
    case "update_node": {
      const n = change.node;
      const [row] = await tx
        .update(researchNodes)
        .set({
          title: n.title,
          body: n.body,
          status: n.status,
          statusBeforeDiscard: n.statusBeforeDiscard,
          parentNodeId: n.parentNodeId,
          updatedAt: new Date(n.updatedAt),
        })
        .where(
          and(
            eq(researchNodes.organizationId, n.organizationId),
            eq(researchNodes.id, n.id)
          )
        )
        .returning({ id: researchNodes.id });
      if (!row)
        throw new Error(`research node ${n.id} vanished under the lock`);
      break;
    }
    case "insert_link":
      await tx.insert(researchLinks).values({
        ...change.link,
        ...authorRow(change.link.createdBy, "createdBy"),
        createdAt: new Date(change.link.createdAt),
      });
      break;
    case "set_task_node":
      await tx
        .update(tasks)
        .set({ researchNodeId: change.researchNodeId })
        .where(
          and(
            eq(tasks.organizationId, plan.edit.organizationId),
            eq(tasks.id, change.taskId)
          )
        );
      break;
  }
  const { editor, ...edit } = plan.edit;
  await tx.insert(researchMapEdits).values({
    ...edit,
    ...authorRow(editor, "editor"),
    createdAt: new Date(edit.createdAt),
  });
  if (plan.wake)
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
  return insertEvent(tx, plan.event);
}

async function selectTaskRow(
  tx: Executor,
  organizationId: string,
  taskId: string
) {
  if (!isUuid(taskId)) return undefined;
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
  return row;
}

const authorRow = <P extends "createdBy" | "editor">(
  actor: MapActor,
  prefix: P
) =>
  ({
    [`${prefix}Author`]: actor.author,
    [`${prefix}AgentId`]: actor.author === "agent" ? actor.agentId : null,
    [`${prefix}RunId`]: actor.author === "agent" ? actor.runId : null,
  }) as Record<`${P}Author`, MapActor["author"]> &
    Record<`${P}AgentId` | `${P}RunId`, string | null>;

const actorOf = (
  author: MapActor["author"],
  agentId: string | null,
  runId: string | null
): MapActor =>
  author === "owner"
    ? { author }
    : { author, agentId: agentId!, runId: runId! };

const nodeRow = ({ createdBy, ...node }: ResearchNode) => ({
  ...node,
  ...authorRow(createdBy, "createdBy"),
  createdAt: new Date(node.createdAt),
  updatedAt: new Date(node.updatedAt),
});

const toNode = ({
  seq: _seq,
  createdByAuthor,
  createdByAgentId,
  createdByRunId,
  createdAt,
  updatedAt,
  ...row
}: typeof researchNodes.$inferSelect): ResearchNode => ({
  ...row,
  createdBy: actorOf(createdByAuthor, createdByAgentId, createdByRunId),
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

const toLink = ({
  seq: _seq,
  createdByAuthor,
  createdByAgentId,
  createdByRunId,
  createdAt,
  ...row
}: typeof researchLinks.$inferSelect): ResearchLink => ({
  ...row,
  createdBy: actorOf(createdByAuthor, createdByAgentId, createdByRunId),
  createdAt: createdAt.toISOString(),
});

const toEdit = ({
  seq: _seq,
  editorAuthor,
  editorAgentId,
  editorRunId,
  createdAt,
  ...row
}: typeof researchMapEdits.$inferSelect): ResearchMapEdit => ({
  ...row,
  editor: actorOf(editorAuthor, editorAgentId, editorRunId),
  createdAt: createdAt.toISOString(),
});
