import {
  ownerMapEditStages,
  type FlowKind,
  type LifecycleStage,
  type MapActor,
  type NewEvent,
  type ResearchLink,
  type ResearchMapEdit,
  type ResearchMapOperation,
  type ResearchNode,
  type ResearchNodeStatus,
  type ResearchNodeWorkStatus,
} from "@babojubot/contracts";
import type { RecordSource } from "./organization.ts";
import type { Wake } from "./run.ts";

// 연구 지도의 구조 규칙과 편집 효과. 노드·보조 연결 종류는 조직 사본 템플릿의 선언만 받고, 주 부모는 최대 하나이며
// 주 연결은 순환하지 않는다. 보조 연결은 개수·순환 제한이 없다. 삭제는 `폐기` 상태이며 자손·연결·작업은 그대로 남는다.
// 편집마다 편집 기록 하나와 Event 하나를 남기고, 사용자 편집은 Lead를 깨운다. 지금과 같은 값의 요청은 편집이 아니다.
// 이 규칙은 저장 쪽이 조직 잠금 아래에서 읽은 최신 지도에 적용해야 동시 편집에도 순환을 막는다.

/** 연구 지도 규칙의 거부. 저장 쪽은 이 값을 그대로 응답으로 옮긴다. */
export type MapRuleProblem =
  | "not_found"
  | "unknown_kind"
  | "self_link"
  | "primary_cycle"
  | "primary_parent_exists"
  | "node_discarded"
  | "task_already_linked";

/** 사용자 지도 편집을 받는 단계인가(contracts `ownerMapEditStages`). */
export const acceptsOwnerMapEdit = (stage: LifecycleStage) =>
  (ownerMapEditStages as readonly LifecycleStage[]).includes(stage);

/** 편집자. 사용자 편집은 그 조직의 Lead를 깨운다. */
export type MapEditor =
  | { author: "owner"; leadAgentId: string }
  | { author: "agent"; agentId: string; runId: string };

/** 규칙을 적용할 지도: 조직 사본 템플릿의 종류 선언과 조직의 모든 노드(폐기 포함). */
export type MapSnapshot = {
  organizationId: string;
  nodeKinds: FlowKind[];
  linkKinds: FlowKind[];
  nodes: ReadonlyMap<string, ResearchNode>;
};

/** 저장할 변경 하나. */
export type MapChange =
  | { type: "insert_node"; node: ResearchNode }
  | { type: "update_node"; node: ResearchNode }
  | { type: "insert_link"; link: ResearchLink }
  | { type: "set_task_node"; taskId: string; researchNodeId: string | null };

export type MapEditPlan<T> =
  | {
      kind: "edit";
      value: T;
      change: MapChange;
      edit: ResearchMapEdit;
      wake: Wake | undefined;
      event: NewEvent;
    }
  /** 지금과 같은 값. 기록·Event·깨우기가 없다. */
  | { kind: "unchanged"; value: T };

export type MapPlan<T> = MapRuleProblem | MapEditPlan<T>;

export const researchNodeStatusLabel: Record<ResearchNodeStatus, string> = {
  proposed: "제안됨",
  in_progress: "진행 중",
  done: "완료",
  rejected: "기각됨",
  discarded: "폐기",
};

/** 노드 생성. 새 노드는 `제안됨`이다. 주 부모가 있으면 같은 조직의 폐기되지 않은 노드여야 한다. */
export function planNodeCreation(
  map: MapSnapshot,
  editor: MapEditor,
  input: { kind: string; title: string; body: string; parentNodeId?: string },
  source: RecordSource
): MapPlan<ResearchNode> {
  if (!map.nodeKinds.some((k) => k.name === input.kind)) return "unknown_kind";
  const parent = input.parentNodeId
    ? map.nodes.get(input.parentNodeId)
    : undefined;
  if (input.parentNodeId && !parent) return "not_found";
  if (parent?.status === "discarded") return "node_discarded";
  const at = source.now().toISOString();
  const node: ResearchNode = {
    id: source.newId(),
    organizationId: map.organizationId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    status: "proposed",
    statusBeforeDiscard: null,
    parentNodeId: parent?.id ?? null,
    createdBy: actorOf(editor),
    createdAt: at,
    updatedAt: at,
  };
  return edited(map, editor, source, at, {
    operation: "create_node",
    refs: { nodeId: node.id },
    summary: `노드 추가: ${kindLabel(map.nodeKinds, node.kind)} ${quote(node.title)} (주 부모 ${parent ? quote(parent.title) : "없음"})`,
    value: node,
    change: { type: "insert_node", node },
  });
}

/** 제목·본문·상태 수정. 폐기된 노드는 폐기 취소만 받는다. */
export function planNodeUpdate(
  map: MapSnapshot,
  editor: MapEditor,
  nodeId: string,
  input: { title?: string; body?: string; status?: ResearchNodeWorkStatus },
  source: RecordSource
): MapPlan<ResearchNode> {
  const node = map.nodes.get(nodeId);
  if (!node) return "not_found";
  if (node.status === "discarded") return "node_discarded";
  const parts: string[] = [];
  if (input.title !== undefined && input.title !== node.title)
    parts.push(`제목 ${quote(node.title)} → ${quote(input.title)}`);
  if (input.body !== undefined && input.body !== node.body)
    parts.push("본문 수정");
  if (input.status !== undefined && input.status !== node.status)
    parts.push(
      `상태 ${researchNodeStatusLabel[node.status]} → ${researchNodeStatusLabel[input.status]}`
    );
  if (!parts.length) return { kind: "unchanged", value: node };
  const at = source.now().toISOString();
  const updated: ResearchNode = {
    ...node,
    title: input.title ?? node.title,
    body: input.body ?? node.body,
    status: input.status ?? node.status,
    updatedAt: at,
  };
  return edited(map, editor, source, at, {
    operation: "update_node",
    refs: { nodeId },
    summary: `노드 ${quote(node.title)} 수정: ${parts.join(", ")}`,
    value: updated,
    change: { type: "update_node", node: updated },
  });
}

/**
 * 주 부모 지정(`assign`)과 변경(`change`). 지정은 주 부모가 없는 노드에만 하고, 변경은 기존 주 부모를 명시적으로 바꾸거나
 * 없앤다(`null`). 자기 자신이나 후손은 주 부모가 될 수 없다. 순환 검사는 폐기된 노드를 포함한 모든 주 연결을 따라간다.
 */
export function planParentChange(
  map: MapSnapshot,
  editor: MapEditor,
  nodeId: string,
  parentNodeId: string | null,
  mode: "assign" | "change",
  source: RecordSource
): MapPlan<ResearchNode> {
  const node = map.nodes.get(nodeId);
  const parent = parentNodeId ? map.nodes.get(parentNodeId) : undefined;
  if (!node || (parentNodeId && !parent)) return "not_found";
  if (node.status === "discarded" || parent?.status === "discarded")
    return "node_discarded";
  if (node.parentNodeId === parentNodeId)
    return { kind: "unchanged", value: node };
  if (mode === "assign" && node.parentNodeId !== null)
    return "primary_parent_exists";
  if (parent && isSelfOrDescendant(map.nodes, node.id, parent.id))
    return "primary_cycle";
  const before = node.parentNodeId ? map.nodes.get(node.parentNodeId) : null;
  const at = source.now().toISOString();
  const updated: ResearchNode = {
    ...node,
    parentNodeId,
    updatedAt: at,
  };
  return edited(map, editor, source, at, {
    operation: mode === "assign" ? "assign_parent" : "change_parent",
    refs: { nodeId },
    summary: `노드 ${quote(node.title)} 주 부모: ${before ? quote(before.title) : "없음"} → ${parent ? quote(parent.title) : "없음"}`,
    value: updated,
    change: { type: "update_node", node: updated },
  });
}

/** 보조 연결 추가. 개수·순환 제한이 없고 같은 두 노드 사이의 같은 종류 연결도 따로 남는다. 자기 연결만 거부한다. */
export function planLinkAddition(
  map: MapSnapshot,
  editor: MapEditor,
  input: { sourceNodeId: string; targetNodeId: string; kind: string },
  source: RecordSource
): MapPlan<ResearchLink> {
  if (!map.linkKinds.some((k) => k.name === input.kind)) return "unknown_kind";
  const from = map.nodes.get(input.sourceNodeId);
  const to = map.nodes.get(input.targetNodeId);
  if (!from || !to) return "not_found";
  if (from.id === to.id) return "self_link";
  if (from.status === "discarded" || to.status === "discarded")
    return "node_discarded";
  const at = source.now().toISOString();
  const link: ResearchLink = {
    id: source.newId(),
    organizationId: map.organizationId,
    sourceNodeId: from.id,
    targetNodeId: to.id,
    kind: input.kind,
    createdBy: actorOf(editor),
    createdAt: at,
  };
  return edited(map, editor, source, at, {
    operation: "add_link",
    refs: { nodeId: from.id, linkId: link.id },
    summary: `보조 연결 추가: ${quote(from.title)} ─${kindLabel(map.linkKinds, link.kind)}→ ${quote(to.title)}`,
    value: link,
    change: { type: "insert_link", link },
  });
}

/** 폐기. 노드 상태만 바꾸고 폐기 직전 상태를 남긴다. 자손·주/보조 연결·연결 작업은 그대로다. */
export function planDiscard(
  map: MapSnapshot,
  editor: MapEditor,
  nodeId: string,
  source: RecordSource
): MapPlan<ResearchNode> {
  const node = map.nodes.get(nodeId);
  if (!node) return "not_found";
  if (node.status === "discarded") return { kind: "unchanged", value: node };
  const at = source.now().toISOString();
  const updated: ResearchNode = {
    ...node,
    status: "discarded",
    statusBeforeDiscard: node.status,
    updatedAt: at,
  };
  return edited(map, editor, source, at, {
    operation: "discard_node",
    refs: { nodeId },
    summary: `노드 ${quote(node.title)} 폐기 (하위 노드·연결·작업은 그대로)`,
    value: updated,
    change: { type: "update_node", node: updated },
  });
}

/** 폐기 취소. 폐기 직전 상태로 돌린다. */
export function planRestore(
  map: MapSnapshot,
  editor: MapEditor,
  nodeId: string,
  source: RecordSource
): MapPlan<ResearchNode> {
  const node = map.nodes.get(nodeId);
  if (!node) return "not_found";
  if (node.status !== "discarded") return { kind: "unchanged", value: node };
  const status = node.statusBeforeDiscard ?? "proposed";
  const at = source.now().toISOString();
  const updated: ResearchNode = {
    ...node,
    status,
    statusBeforeDiscard: null,
    updatedAt: at,
  };
  return edited(map, editor, source, at, {
    operation: "restore_node",
    refs: { nodeId },
    summary: `노드 ${quote(node.title)} 폐기 취소 (상태 ${researchNodeStatusLabel[status]})`,
    value: updated,
    change: { type: "update_node", node: updated },
  });
}

/** 작업을 연결할 노드인가. 같은 조직의 폐기되지 않은 노드여야 한다. */
export function taskNodeProblem(
  node: Pick<ResearchNode, "status"> | undefined
): "not_found" | "node_discarded" | undefined {
  if (!node) return "not_found";
  if (node.status === "discarded") return "node_discarded";
  return undefined;
}

/**
 * 작업의 연구 노드 연결(`link`)·재연결(`relink`)·해제(`unlink`). 작업은 노드 0~1개에 연결된다.
 * 연결은 연결이 없는 작업에만 하고, 다른 노드로 바꾸려면 재연결을 명시해야 한다.
 */
export function planTaskNodeLink(
  map: MapSnapshot,
  editor: MapEditor,
  task: { id: string; title: string; researchNodeId: string | null },
  researchNodeId: string | null,
  mode: "link" | "relink" | "unlink",
  source: RecordSource
): MapPlan<{ taskId: string; researchNodeId: string | null }> {
  const value = { taskId: task.id, researchNodeId };
  const current = task.researchNodeId
    ? map.nodes.get(task.researchNodeId)
    : undefined;
  const next = researchNodeId ? map.nodes.get(researchNodeId) : undefined;
  if (researchNodeId) {
    const problem = taskNodeProblem(next);
    if (problem === "not_found") return problem;
    if (task.researchNodeId === researchNodeId)
      return { kind: "unchanged", value };
    if (problem) return problem;
    if (mode === "link" && task.researchNodeId !== null)
      return "task_already_linked";
  } else if (task.researchNodeId === null) return { kind: "unchanged", value };
  const describe = (n: ResearchNode | undefined) =>
    n ? quote(n.title) : "없음";
  const at = source.now().toISOString();
  return edited(map, editor, source, at, {
    operation: `${mode}_task`,
    refs: { nodeId: next?.id ?? current?.id ?? null, taskId: task.id },
    summary: `작업 ${quote(task.title)}의 연구 노드: ${describe(current)} → ${describe(next)}`,
    value,
    change: { type: "set_task_node", taskId: task.id, researchNodeId },
  });
}

// ---------- 내부 ----------

/** `candidate`가 `nodeId` 자신이거나 그 후손인가. 주 연결을 위로 따라간다. */
function isSelfOrDescendant(
  nodes: ReadonlyMap<string, ResearchNode>,
  nodeId: string,
  candidate: string
) {
  const seen = new Set<string>();
  for (
    let id: string | null = candidate;
    id !== null && !seen.has(id);
    id = nodes.get(id)?.parentNodeId ?? null
  ) {
    if (id === nodeId) return true;
    seen.add(id);
  }
  return false;
}

const actorOf = (editor: MapEditor): MapActor =>
  editor.author === "owner"
    ? { author: "owner" }
    : { author: "agent", agentId: editor.agentId, runId: editor.runId };

const kindLabel = (kinds: FlowKind[], name: string) =>
  kinds.find((k) => k.name === name)?.label ?? name;

const quote = (text: string) =>
  `“${[...text].length > 60 ? `${[...text].slice(0, 60).join("")}…` : text}”`;

/** 편집 기록·Event와 사용자 편집의 Lead 깨우기. */
function edited<T>(
  map: MapSnapshot,
  editor: MapEditor,
  { newId }: RecordSource,
  at: string,
  {
    operation,
    refs,
    summary,
    value,
    change,
  }: {
    operation: ResearchMapOperation;
    refs: { nodeId: string | null; linkId?: string; taskId?: string };
    summary: string;
    value: T;
    change: MapChange;
  }
): MapEditPlan<T> {
  const organizationId = map.organizationId;
  const edit: ResearchMapEdit = {
    id: newId(),
    organizationId,
    editor: actorOf(editor),
    operation,
    nodeId: refs.nodeId,
    linkId: refs.linkId ?? null,
    taskId: refs.taskId ?? null,
    summary,
    createdAt: at,
  };
  const wake: Wake | undefined =
    editor.author === "owner"
      ? {
          id: newId(),
          organizationId,
          agentId: editor.leadAgentId,
          kind: "research_map_edit",
          mapEditId: edit.id,
          createdAt: at,
        }
      : undefined;
  return {
    kind: "edit",
    value,
    change,
    edit,
    wake,
    event: {
      organizationId,
      type: "research_map.edited",
      payload: {
        editId: edit.id,
        operation,
        author: editor.author,
        agentId: editor.author === "agent" ? editor.agentId : null,
        runId: editor.author === "agent" ? editor.runId : null,
        nodeId: edit.nodeId,
        linkId: edit.linkId,
        taskId: edit.taskId,
        wokenAgentId: wake?.agentId ?? null,
      },
    },
  };
}
