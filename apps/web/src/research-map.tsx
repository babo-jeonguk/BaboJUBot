// 조직 › 연구 지도(#51 결정 A): React Flow + Dagre. 배치는 보이는 노드와 주 연결만으로 하고 보조 연결은 연하게 겹쳐 그린다.
// 노드를 고르면 오른쪽 상세 패널(1024px 미만에서는 지도 아래)이 열리고 편집은 모두 명시 폼으로 한다. 서버 기록만 지도에 그리며,
// 렌더러의 삭제·재연결·parentId는 연구 기록에 쓰지 않는다. 노드 위치 드래그는 이 화면의 보기 상태일 뿐 편집이 아니다.
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import {
  ownerMapEditStages,
  researchNodeWorkStatuses,
  type Agent,
  type FlowKind,
  type LifecycleStage,
  type MapActor,
  type OrgToolErrorCode,
  type ResearchLink,
  type ResearchMap,
  type ResearchNode,
  type ResearchNodeStatus,
  type Task,
} from "@babojubot/contracts";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router";
import {
  ApiError,
  useEditResearchMap,
  useFlowTemplate,
  useResearchMap,
  useResearchNode,
  useTasks,
  type MapEdit,
} from "./api.ts";
import {
  formatTime,
  Loading,
  LoadError,
  mapOperationLabel,
  researchNodeStatusLabel,
  runLabel,
} from "./ui.tsx";

const NODE_W = 232;
const NODE_H = 76;
type Dir = "LR" | "TB";
type SecMode = "all" | "focus" | "off";
type XY = { x: number; y: number };

const statusTone: Record<ResearchNodeStatus, string> = {
  proposed: "text-slate-500",
  in_progress: "text-brand-600",
  done: "text-emerald-600",
  rejected: "text-rose-600",
  discarded: "text-slate-400 line-through",
};
/** 노드 종류는 템플릿 선언 순서대로 색을 받고, 색과 함께 늘 종류 글자로 보인다. */
const kindTones = [
  "bg-rose-50 text-rose-700 ring-rose-200",
  "bg-amber-50 text-amber-800 ring-amber-200",
  "bg-sky-50 text-sky-700 ring-sky-200",
  "bg-brand-50 text-brand-700 ring-brand-200",
  "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "bg-slate-100 text-slate-700 ring-slate-200",
];
const linkColors = ["#059669", "#e11d48", "#64748b", "#d97706", "#0284c7"];
const secLabel: Record<SecMode, string> = {
  all: "보조 전체(연하게)",
  focus: "보조: 선택 주변만",
  off: "보조 숨김",
};
const shortId = (id: string) => id.slice(0, 8);
const discarded = (n: ResearchNode) => n.status === "discarded";

const problemText: Partial<Record<OrgToolErrorCode | "stage_closed", string>> =
  {
    primary_cycle:
      "자기 자신이나 후손은 주 부모가 될 수 없습니다. 주 연결은 순환할 수 없습니다.",
    primary_parent_exists: "이미 주 부모가 있습니다.",
    node_discarded:
      "폐기된 노드는 폐기 취소만 할 수 있고 새 연결의 대상이 될 수 없습니다.",
    unknown_kind: "조직의 연구 흐름 템플릿에 없는 종류입니다.",
    stage_closed: "지금 조직 단계에서는 연구 지도를 편집할 수 없습니다.",
    not_found: "노드를 찾을 수 없습니다. 지도를 다시 불러왔습니다.",
    invalid_input:
      "입력을 확인하세요. 자기 자신과는 보조 연결을 맺을 수 없습니다.",
  };
const editFailure = (error: unknown) =>
  (error instanceof ApiError &&
    error.code &&
    problemText[error.code as keyof typeof problemText]) ||
  "저장했는지 확인하지 못했습니다. 입력은 그대로 두었으니 지도를 확인하고 다시 시도하세요.";

/** 지도의 파생 조회: 노드·자식·보조 연결·종류. */
type MapIndex = {
  map: ResearchMap;
  byId: Map<string, ResearchNode>;
  children: Map<string, ResearchNode[]>;
  nodeKinds: FlowKind[];
  linkKinds: FlowKind[];
  tasksByNode: Map<string, Task[]>;
};
function indexMap(
  map: ResearchMap,
  template: { nodeKinds: FlowKind[]; linkKinds: FlowKind[] },
  tasks: Task[]
): MapIndex {
  const children = new Map<string, ResearchNode[]>();
  for (const n of map.nodes)
    if (n.parentNodeId)
      children.set(n.parentNodeId, [
        ...(children.get(n.parentNodeId) ?? []),
        n,
      ]);
  const tasksByNode = new Map<string, Task[]>();
  for (const t of tasks)
    if (t.researchNodeId)
      tasksByNode.set(t.researchNodeId, [
        ...(tasksByNode.get(t.researchNodeId) ?? []),
        t,
      ]);
  return {
    map,
    byId: new Map(map.nodes.map((n) => [n.id, n])),
    children,
    nodeKinds: template.nodeKinds,
    linkKinds: template.linkKinds,
    tasksByNode,
  };
}

/** 주 연결을 따라 내려간 모든 후손. 폐기된 노드도 포함한다. */
function descendantsOf(index: MapIndex, id: string) {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length)
    for (const c of index.children.get(stack.pop()!) ?? [])
      if (!out.has(c.id)) {
        out.add(c.id);
        stack.push(c.id);
      }
  return out;
}

const kindLabel = (kinds: FlowKind[], name: string) =>
  kinds.find((k) => k.name === name)?.label ?? name;
const kindTone = (kinds: FlowKind[], name: string) => {
  const i = kinds.findIndex((k) => k.name === name);
  return kindTones[i < 0 ? kindTones.length - 1 : i % kindTones.length]!;
};
const linkColor = (kinds: FlowKind[], name: string) => {
  const i = kinds.findIndex((k) => k.name === name);
  return linkColors[i < 0 ? 2 : i % linkColors.length]!;
};

/** 배치 입력(방향, 보이는 노드와 그 안의 주 부모)의 문자열. 제목·상태·보조 연결은 들어가지 않는다. */
function layoutKey(visible: ResearchNode[], dir: Dir) {
  const ids = new Set(visible.map((n) => n.id));
  return JSON.stringify({
    dir,
    items: visible.map((n) => [
      n.id,
      n.parentNodeId && ids.has(n.parentNodeId) ? n.parentNodeId : null,
    ]),
  });
}
/** Dagre 배치. 주 부모가 보이지 않는 노드는 root로 둔다. 좌표는 카드 왼쪽 위다. */
function layoutOf(key: string): Map<string, XY> {
  const { dir, items } = JSON.parse(key) as {
    dir: Dir;
    items: [string, string | null][];
  };
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: dir,
    nodesep: dir === "LR" ? 14 : 28,
    ranksep: dir === "LR" ? 72 : 56,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const [id] of items) g.setNode(id, { width: NODE_W, height: NODE_H });
  for (const [id, parent] of items) if (parent) g.setEdge(parent, id);
  dagre.layout(g);
  return new Map(
    items.map(([id]) => {
      const p = g.node(id);
      return [id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }];
    })
  );
}

/** 조직 › 연구 지도. 초기 연구 승인 전에는 템플릿이 없어 지도도 없다. */
export function ResearchMapScreen({
  orgId,
  stage,
  agents,
}: {
  orgId: string;
  stage: LifecycleStage;
  agents: Agent[];
}) {
  const map = useResearchMap(orgId);
  const template = useFlowTemplate(orgId);
  const tasks = useTasks(orgId);
  if (map.isPending || template.isPending) return <Loading />;
  if (map.isError)
    return <LoadError what="연구 지도" onRetry={() => void map.refetch()} />;
  if (template.isError)
    return (
      <LoadError
        what="연구 흐름 템플릿"
        onRetry={() => void template.refetch()}
      />
    );
  if (!template.data)
    return (
      <>
        <h1 className="mb-4 text-xl font-semibold">연구 지도</h1>
        <div className="card p-6 text-sm text-slate-500">
          초기 연구 승인 뒤 조직의 연구 흐름 템플릿이 정해지면 Lead와 작업자가
          연구 노드를 만듭니다.
        </div>
      </>
    );
  return (
    <ReactFlowProvider>
      <MapWorkspace
        orgId={orgId}
        canEdit={(ownerMapEditStages as readonly string[]).includes(stage)}
        agents={agents}
        index={indexMap(map.data, template.data, tasks.data ?? [])}
      />
    </ReactFlowProvider>
  );
}

type CardData = {
  node: ResearchNode;
  kind: string;
  tone: string;
  tasks: number;
  dim: boolean;
  dir: Dir;
};
type CardNode = Node<CardData, "research">;

const ResearchCard = memo(function ResearchCard({
  data,
  selected,
}: NodeProps<CardNode>) {
  const { node, kind, tone, tasks, dim, dir } = data;
  const gone = discarded(node);
  const handle = "!h-1.5 !w-1.5 !min-w-0 !border-0 !opacity-0";
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-testid="map-node"
      data-node-id={node.id}
      data-status={node.status}
      className={`flex flex-col rounded-xl px-2.5 py-2 text-left transition-[opacity,box-shadow] duration-150 ${gone ? "border border-dashed border-slate-300 bg-slate-50" : "bg-white shadow-card ring-1 ring-slate-900/[0.07]"} ${selected ? "!ring-2 !ring-brand-500 shadow-lift" : ""} ${dim ? "opacity-30" : gone ? "opacity-70" : ""}`}
    >
      <Handle
        type="target"
        position={dir === "LR" ? Position.Left : Position.Top}
        isConnectable={false}
        className={handle}
      />
      <div className="flex items-center gap-1.5">
        <span
          className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${tone}`}
        >
          {kind}
        </span>
        <span className="text-[10px] text-slate-400">{shortId(node.id)}</span>
        <span className={`text-[11px] font-medium ${statusTone[node.status]}`}>
          {researchNodeStatusLabel[node.status]}
        </span>
        {tasks > 0 && (
          <span className="ml-auto rounded bg-slate-100 px-1 text-[10px] text-slate-500">
            작업 {tasks}
          </span>
        )}
      </div>
      <div
        className={`mt-1 line-clamp-2 text-[12.5px] leading-snug break-words ${gone ? "text-slate-400 line-through" : "text-slate-800"}`}
        title={node.title}
      >
        {node.title}
      </div>
      <Handle
        type="source"
        position={dir === "LR" ? Position.Right : Position.Bottom}
        isConnectable={false}
        className={handle}
      />
    </div>
  );
});
const nodeTypes = { research: ResearchCard };

type Panel = { mode: "add_root" } | { mode: "node"; id: string } | null;

function MapWorkspace({
  orgId,
  canEdit,
  agents,
  index,
}: {
  orgId: string;
  canEdit: boolean;
  agents: Agent[];
  index: MapIndex;
}) {
  const [dir, setDir] = useState<Dir>("LR");
  const [secMode, setSecMode] = useState<SecMode>("all");
  const [hideDiscarded, setHideDiscarded] = useState(false);
  // 직접 옮긴 위치(카드 왼쪽 위). 보기 상태이며 저장하지 않는다. 자동 재배치에도 유지하고 방향을 바꾸면 지운다.
  const [pinned, setPinned] = useState<Map<string, XY>>(new Map());
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState<Map<string, XY> | null>(null);
  const drag = useRef<{ id: string; start: Map<string, XY> } | null>(null);
  const [addingRoot, setAddingRoot] = useState(false);
  const [params, setParams] = useSearchParams();
  const rf = useReactFlow();
  const initialized = useNodesInitialized();

  const requested = params.get("node") ?? undefined;
  const selected =
    requested && index.byId.has(requested) ? requested : undefined;
  const select = (id?: string) => {
    if (id === selected) return;
    const next = new URLSearchParams(params);
    if (id) next.set("node", id);
    else next.delete("node");
    setParams(next, { replace: true });
    if (id) setAddingRoot(false);
  };
  const panel: Panel = selected
    ? { mode: "node", id: selected }
    : addingRoot && canEdit
      ? { mode: "add_root" }
      : null;

  const visible = useMemo(
    () =>
      hideDiscarded
        ? index.map.nodes.filter((n) => !discarded(n))
        : index.map.nodes,
    [index.map.nodes, hideDiscarded]
  );
  const key = layoutKey(visible, dir);
  const laidOut = useMemo(() => layoutOf(key), [key]);

  // 선택한 노드의 root까지 경로·하위 노드 전체·보조 연결 이웃을 강조하고 나머지를 흐리게 한다.
  const focus = useMemo(() => {
    if (!selected) return undefined;
    const set = new Set<string>();
    for (
      let n = index.byId.get(selected);
      n && !set.has(n.id);
      n = n.parentNodeId ? index.byId.get(n.parentNodeId) : undefined
    )
      set.add(n.id);
    for (const id of descendantsOf(index, selected)) set.add(id);
    for (const l of index.map.links)
      if (l.sourceNodeId === selected || l.targetNodeId === selected) {
        set.add(l.sourceNodeId);
        set.add(l.targetNodeId);
      }
    return set;
  }, [index, selected]);

  const nodes: CardNode[] = visible.map((n) => ({
    id: n.id,
    type: "research",
    position: live?.get(n.id) ??
      pinned.get(n.id) ??
      laidOut.get(n.id) ?? { x: 0, y: 0 },
    // 카드 크기는 고정이다. 다시 그려도 측정값과 연결 핸들 위치를 잃지 않게 함께 넘긴다.
    measured: { width: NODE_W, height: NODE_H },
    selected: n.id === selected,
    data: {
      node: n,
      kind: kindLabel(index.nodeKinds, n.kind),
      tone: kindTone(index.nodeKinds, n.kind),
      tasks: index.tasksByNode.get(n.id)?.length ?? 0,
      dim: !!focus && !focus.has(n.id),
      dir,
    },
  }));

  const visibleIds = new Set(visible.map((n) => n.id));
  const edges: Edge[] = [];
  for (const n of visible)
    if (n.parentNodeId && visibleIds.has(n.parentNodeId)) {
      const on = !!focus && focus.has(n.id) && focus.has(n.parentNodeId);
      const color = on ? "#4338ca" : "#94a3b8";
      edges.push({
        // 주 연결의 ID는 자식 노드의 ID다.
        id: `primary:${n.id}`,
        source: n.parentNodeId,
        target: n.id,
        type: "smoothstep",
        selectable: false,
        style: {
          stroke: color,
          strokeWidth: on ? 2.2 : 1.5,
          opacity: focus && !on ? 0.35 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 14,
          height: 14,
        },
      });
    }
  if (secMode !== "off")
    for (const l of index.map.links) {
      if (!visibleIds.has(l.sourceNodeId) || !visibleIds.has(l.targetNodeId))
        continue;
      const touch = l.sourceNodeId === selected || l.targetNodeId === selected;
      if (secMode === "focus" && !touch) continue;
      const color = linkColor(index.linkKinds, l.kind);
      edges.push({
        // 관계 ID를 그대로 쓴다. 같은 두 노드 사이의 여러 연결이 합쳐지지 않는다.
        id: l.id,
        source: l.sourceNodeId,
        target: l.targetNodeId,
        type: "default",
        selectable: false,
        zIndex: touch ? 5 : 0,
        label: touch ? kindLabel(index.linkKinds, l.kind) : undefined,
        labelStyle: { fill: color, fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "white" },
        style: {
          stroke: color,
          strokeWidth: touch ? 2 : 1.2,
          strokeDasharray: "5 4",
          opacity: touch ? 0.95 : selected ? 0.12 : 0.32,
        },
        markerEnd: { type: MarkerType.Arrow, color, width: 12, height: 12 },
      });
    }

  // 화면 맞춤은 처음 열 때와 방향을 바꿀 때만 한다. 이후 재배치는 사용자의 viewport를 유지한다.
  const fitted = useRef<Dir | null>(null);
  useEffect(() => {
    if (!initialized || fitted.current === dir) return;
    fitted.current = dir;
    requestAnimationFrame(
      () => void rf.fitView({ padding: 0.12, maxZoom: 1, minZoom: 0.45 })
    );
  }, [initialized, dir, rf]);

  const pin = (moved: Map<string, XY>) =>
    setPinned((current) => new Map([...current, ...moved]));
  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    for (const c of changes) {
      if (c.type === "select" && c.selected) select(c.id);
      if (c.type !== "position" || !c.position) continue;
      const session = drag.current;
      if (session?.id === c.id) {
        const p0 = session.start.get(c.id)!;
        const dx = c.position.x - p0.x;
        const dy = c.position.y - p0.y;
        setLive(
          new Map(
            [...session.start].map(([id, p]) => [
              id,
              { x: p.x + dx, y: p.y + dy },
            ])
          )
        );
      } else if (!c.dragging) pin(new Map([[c.id, c.position]])); // 키보드로 옮긴 위치
    }
  };
  const onDragStart = (id: string) => {
    const ids = [id, ...(follow ? descendantsOf(index, id) : [])];
    const at = new Map(nodes.map((n) => [n.id, n.position]));
    drag.current = {
      id,
      start: new Map(ids.filter((x) => at.has(x)).map((x) => [x, at.get(x)!])),
    };
  };
  const onDragStop = () => {
    drag.current = null;
    if (live) pin(live);
    setLive(null);
  };

  const node = selected ? index.byId.get(selected) : undefined;
  const discardedCount = index.map.nodes.filter(discarded).length;
  const seg = (on: boolean) =>
    `rounded-lg px-2 py-1 text-xs transition ${on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">연구 지도</h1>
        {canEdit && (
          <button
            className="btn-primary py-1 text-xs"
            onClick={() => {
              select(undefined);
              setAddingRoot(true);
            }}
          >
            ＋ 최상위 노드
          </button>
        )}
        <Seg label="배치 방향">
          <button
            className={seg(dir === "LR")}
            aria-pressed={dir === "LR"}
            onClick={() => {
              setDir("LR");
              setPinned(new Map());
            }}
          >
            좌→우
          </button>
          <button
            className={seg(dir === "TB")}
            aria-pressed={dir === "TB"}
            onClick={() => {
              setDir("TB");
              setPinned(new Map());
            }}
          >
            위→아래
          </button>
        </Seg>
        <Seg label="보조 연결 표시">
          {(Object.keys(secLabel) as SecMode[]).map((m) => (
            <button
              key={m}
              className={seg(secMode === m)}
              aria-pressed={secMode === m}
              onClick={() => setSecMode(m)}
            >
              {secLabel[m]}
            </button>
          ))}
        </Seg>
        <Seg label="폐기 노드 표시">
          <button
            className={seg(!hideDiscarded)}
            aria-pressed={!hideDiscarded}
            onClick={() => setHideDiscarded(false)}
          >
            폐기 흐리게
          </button>
          <button
            className={seg(hideDiscarded)}
            aria-pressed={hideDiscarded}
            onClick={() => setHideDiscarded(true)}
          >
            폐기 숨김 ({discardedCount})
          </button>
        </Seg>
        <Seg label="노드 끌기">
          <button
            className={seg(follow)}
            aria-pressed={follow}
            onClick={() => setFollow(true)}
            title="노드를 끌면 그 아래 주 연결 하위 노드도 함께 움직입니다"
          >
            끌면 하위도 함께
          </button>
          <button
            className={seg(!follow)}
            aria-pressed={!follow}
            onClick={() => setFollow(false)}
          >
            그 노드만
          </button>
        </Seg>
        {pinned.size > 0 && (
          <button
            className="btn-soft py-1 text-xs"
            onClick={() => setPinned(new Map())}
            title="직접 옮긴 위치를 지우고 자동 배치로 돌아갑니다"
          >
            ↺ 자동 정렬로 되돌리기 ({pinned.size})
          </button>
        )}
      </div>
      {!canEdit && (
        <p className="text-xs text-slate-500">
          지금 조직 단계에서는 보기만 할 수 있습니다. 연구 지도는 초기 연구 승인
          뒤, 최종 완료·중단 전에 편집합니다.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div
          className="card relative h-[60vh] min-h-[420px] flex-1 overflow-hidden lg:h-auto"
          data-testid="map-canvas"
        >
          {!index.map.nodes.length ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-slate-500">
              <div>
                아직 연구 노드가 없습니다. Lead와 작업자가 연구를 진행하며
                노드를 만듭니다.
                {canEdit && (
                  <div className="mt-3">
                    <button
                      className="btn-soft"
                      onClick={() => setAddingRoot(true)}
                    >
                      직접 최상위 노드 추가
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            !selected && (
              <div className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-white/85 px-2 py-1 text-center text-[11px] text-slate-500">
                노드를 누르면 상세·편집 패널이 열립니다 · 끌어서 옮긴 위치는
                보기에만 남습니다
              </div>
            )
          )}
          <ReactFlow<CardNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, n) => select(n.id)}
            onPaneClick={() => select(undefined)}
            onNodeDragStart={(_, n) => onDragStart(n.id)}
            onNodeDragStop={onDragStop}
            selectNodesOnDrag={false}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            onlyRenderVisibleElements={nodes.length > 150}
            minZoom={0.08}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#e2e8f0" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>

        {panel && (
          <aside
            className="card scrollbar-thin animate-fade-up w-full shrink-0 overflow-auto p-4 lg:max-h-[calc(100vh-9rem)] lg:w-[340px]"
            aria-label="노드 상세"
          >
            {panel.mode === "add_root" ? (
              <Section
                title="최상위 노드 추가"
                onClose={() => setAddingRoot(false)}
              >
                <AddNodeForm
                  orgId={orgId}
                  index={index}
                  onDone={(id) => select(id)}
                />
              </Section>
            ) : (
              node && (
                <NodeDetail
                  key={node.id}
                  orgId={orgId}
                  node={node}
                  index={index}
                  agents={agents}
                  canEdit={canEdit}
                  select={select}
                  onCenter={() =>
                    void rf.fitView({
                      nodes: [{ id: node.id }],
                      maxZoom: 1.1,
                      duration: 300,
                    })
                  }
                />
              )
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

type Form = "child" | "parent" | "link" | null;

/** 노드 상세 패널: 종류·ID·상태·제목, 주 부모와 하위, 보조 연결, 연결 작업과 산출물, 편집 기록, 편집 폼. */
function NodeDetail({
  orgId,
  node,
  index,
  agents,
  canEdit,
  select,
  onCenter,
}: {
  orgId: string;
  node: ResearchNode;
  index: MapIndex;
  agents: Agent[];
  canEdit: boolean;
  select: (id?: string) => void;
  onCenter: () => void;
}) {
  const [form, setForm] = useState<Form>(null);
  const detail = useResearchNode(orgId, node.id);
  const status = useEditResearchMap(orgId);
  const editable = canEdit && !discarded(node);
  const parent = node.parentNodeId
    ? index.byId.get(node.parentNodeId)
    : undefined;
  const kids = index.children.get(node.id) ?? [];
  const out = index.map.links.filter((l) => l.sourceNodeId === node.id);
  const inn = index.map.links.filter((l) => l.targetNodeId === node.id);
  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? "에이전트";
  const ref = (id: string) => {
    const x = index.byId.get(id);
    return (
      <button
        key={id}
        onClick={() => select(id)}
        className="block max-w-full truncate text-left text-brand-600 hover:underline"
        title={x?.title}
      >
        {shortId(id)}{" "}
        <span
          className={
            x && discarded(x) ? "text-slate-400 line-through" : "text-slate-600"
          }
        >
          {x?.title}
        </span>
      </button>
    );
  };
  const linkRow = (l: ResearchLink, outgoing: boolean) => {
    const color = linkColor(index.linkKinds, l.kind);
    const label = kindLabel(index.linkKinds, l.kind);
    return (
      <div
        key={l.id}
        className="flex min-w-0 items-center gap-1"
        data-link-id={l.id}
      >
        <span className="shrink-0 font-medium" style={{ color }}>
          {outgoing ? `─${label}→` : `←${label}─`}
        </span>
        {ref(outgoing ? l.targetNodeId : l.sourceNodeId)}
      </div>
    );
  };
  const row = "grid grid-cols-[4.5rem_1fr] gap-2 text-xs";
  const by = (actor: MapActor) =>
    actor.author === "owner" ? "사용자" : agentName(actor.agentId);

  return (
    <div className="space-y-4" data-testid="node-detail">
      <div>
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${kindTone(index.nodeKinds, node.kind)}`}
          >
            {kindLabel(index.nodeKinds, node.kind)}
          </span>
          <span className="text-xs text-slate-400" title={node.id}>
            {shortId(node.id)}
          </span>
          <span
            className={`text-[11px] font-medium ${statusTone[node.status]}`}
            data-testid="node-status"
          >
            {researchNodeStatusLabel[node.status]}
          </span>
          <button
            onClick={onCenter}
            className="btn-ghost ml-auto px-1.5 py-0.5 text-xs"
            title="지도에서 이 노드로 이동"
            aria-label="지도에서 이 노드로 이동"
          >
            ◎
          </button>
          <button
            onClick={() => select(undefined)}
            className="btn-ghost px-1.5 py-0.5 text-xs"
            aria-label="상세 닫기"
          >
            ✕
          </button>
        </div>
        {editable ? (
          <TitleForm orgId={orgId} node={node} />
        ) : (
          <h2
            className={`mt-2 text-sm font-semibold break-words ${discarded(node) ? "text-slate-400 line-through" : ""}`}
            data-testid="node-title"
          >
            {node.title}
          </h2>
        )}
        {editable && (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            상태
            <select
              aria-label="상태"
              value={node.status}
              disabled={status.isPending}
              onChange={(e) =>
                void status
                  .mutateAsync({
                    op: "update_node",
                    nodeId: node.id,
                    input: {
                      status: e.target
                        .value as (typeof researchNodeWorkStatuses)[number],
                    },
                  })
                  .catch(() => undefined)
              }
              className="rounded-lg bg-white px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200"
            >
              {researchNodeWorkStatuses.map((s) => (
                <option key={s} value={s}>
                  {researchNodeStatusLabel[s]}
                </option>
              ))}
            </select>
          </div>
        )}
        {status.isError && <Problem error={status.error} />}
        {node.body && (
          <p className="mt-2 text-xs break-words whitespace-pre-wrap text-slate-600">
            {node.body}
          </p>
        )}
      </div>

      <div className="space-y-2.5 text-sm">
        <div className={row}>
          <span className="text-slate-400">주 부모</span>
          {parent ? (
            ref(parent.id)
          ) : (
            <span className="text-slate-400">없음 (최상위)</span>
          )}
        </div>
        <div className={row}>
          <span className="text-slate-400">하위 {kids.length}</span>
          <div className="min-w-0 space-y-0.5">
            {kids.length ? (
              kids.map((k) => ref(k.id))
            ) : (
              <span className="text-slate-400">없음</span>
            )}
          </div>
        </div>
        <div className={row}>
          <span className="text-slate-400">보조 {out.length + inn.length}</span>
          <div className="min-w-0 space-y-0.5">
            {!out.length && !inn.length && (
              <span className="text-slate-400">없음</span>
            )}
            {out.map((l) => linkRow(l, true))}
            {inn.map((l) => linkRow(l, false))}
          </div>
        </div>
        <section className={row} aria-label="연결 작업">
          <span className="text-slate-400">연결 작업</span>
          <div className="min-w-0 space-y-1">
            {detail.isPending ? (
              <span className="text-slate-400">불러오는 중…</span>
            ) : detail.isError ? (
              <button
                className="text-rose-700 underline"
                onClick={() => void detail.refetch()}
              >
                불러오지 못했습니다. 다시 시도
              </button>
            ) : !detail.data.tasks.length ? (
              <span className="text-slate-400">없음</span>
            ) : (
              detail.data.tasks.map((t) => (
                <div key={t.id}>
                  <Link
                    to={`/orgs/${orgId}/tasks/${t.id}`}
                    className="font-medium break-words text-brand-600 hover:underline"
                  >
                    {t.title} →
                  </Link>
                  {detail.data.artifacts
                    .filter((a) => a.taskId === t.id)
                    .map((a) => (
                      <Link
                        key={a.id}
                        to={`/orgs/${orgId}/artifacts/${a.id}`}
                        className="block break-words text-brand-600 hover:underline"
                      >
                        📄 {a.title}
                      </Link>
                    ))}
                </div>
              ))
            )}
          </div>
        </section>
        <div className={row}>
          <span className="text-slate-400">만든 이</span>
          <span className="text-slate-600">
            {by(node.createdBy)}
            {node.createdBy.author === "agent" && (
              <>
                {" · "}
                <Link
                  to={`/orgs/${orgId}/runs/${node.createdBy.runId}`}
                  className="text-brand-600 hover:underline"
                >
                  {runLabel(node.createdBy.runId)}
                </Link>
              </>
            )}
          </span>
        </div>
      </div>

      {editable && (
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ["child", "＋ 하위 노드"],
              ["parent", "주 부모 변경"],
              ["link", "보조 연결"],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              aria-expanded={form === f}
              className={`btn-soft px-1 text-xs ${form === f ? "!bg-brand-50 !ring-brand-300" : ""}`}
              onClick={() => setForm(form === f ? null : f)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {editable && form === "child" && (
        <Section title="하위 노드 추가" onClose={() => setForm(null)}>
          <AddNodeForm
            orgId={orgId}
            index={index}
            parent={node}
            onDone={(id) => select(id)}
          />
        </Section>
      )}
      {editable && form === "parent" && (
        <Section title="주 부모 변경" onClose={() => setForm(null)}>
          <ParentForm
            orgId={orgId}
            index={index}
            node={node}
            onDone={() => setForm(null)}
          />
        </Section>
      )}
      {editable && form === "link" && (
        <Section title="보조 연결 추가" onClose={() => setForm(null)}>
          <LinkForm
            orgId={orgId}
            index={index}
            node={node}
            onDone={() => setForm(null)}
          />
        </Section>
      )}
      {canEdit && (
        <DiscardControl
          orgId={orgId}
          node={node}
          counts={{
            children: kids.length,
            links: out.length + inn.length,
            tasks: index.tasksByNode.get(node.id)?.length ?? 0,
          }}
        />
      )}

      <section aria-label="편집 기록" className="text-xs">
        <h3 className="mb-1 font-semibold text-slate-600">편집 기록</h3>
        {detail.data && !detail.data.edits.length && (
          <p className="text-slate-400">없음</p>
        )}
        <ol className="space-y-1.5">
          {detail.data?.edits
            .slice()
            .reverse()
            .map((e) => (
              <li key={e.id} data-editor={e.editor.author}>
                <div className="text-[11px] text-slate-400">
                  {by(e.editor)} · {mapOperationLabel[e.operation]} ·{" "}
                  {formatTime(e.createdAt)}
                </div>
                <div className="break-words text-slate-600">{e.summary}</div>
              </li>
            ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * 제목 수정. 입력 중인 초안은 서버 기록이 다시 불려도 지우지 않고, 그 사이 다른 곳에서 제목이 바뀌면 알린다.
 */
function TitleForm({ orgId, node }: { orgId: string; node: ResearchNode }) {
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(
    null
  );
  const save = useEditResearchMap(orgId);
  const text = draft?.text ?? node.title;
  const changedElsewhere = draft !== null && draft.base !== node.title;
  const submit = async () => {
    const title = text.trim();
    if (!title || title === node.title) return;
    try {
      await save.mutateAsync({
        op: "update_node",
        nodeId: node.id,
        input: { title },
      });
      setDraft(null);
    } catch {
      // 오류는 save.error로 보이고 초안은 그대로 둔다.
    }
  };
  return (
    <form
      className="mt-2 space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="node-title" className="sr-only">
        제목
      </label>
      <textarea
        id="node-title"
        value={text}
        rows={2}
        onChange={(e) =>
          setDraft({ text: e.target.value, base: draft?.base ?? node.title })
        }
        className="w-full resize-y rounded-xl px-2.5 py-1.5 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400"
      />
      {changedElsewhere && (
        <p className="text-[11px] text-amber-700" role="status">
          입력하는 사이 제목이 “{node.title}”(으)로 바뀌었습니다.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setDraft(null)}
          >
            새 제목 보기
          </button>
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {save.isPending && (
          <span className="text-xs text-slate-400" role="status">
            저장 중…
          </span>
        )}
        <button
          className="btn-soft py-1 text-xs"
          disabled={
            !text.trim() || text.trim() === node.title || save.isPending
          }
        >
          제목 저장
        </button>
      </div>
      {save.isError && <Problem error={save.error} />}
    </form>
  );
}

function AddNodeForm({
  orgId,
  index,
  parent,
  onDone,
}: {
  orgId: string;
  index: MapIndex;
  parent?: ResearchNode;
  onDone: (id: string) => void;
}) {
  // 하위 노드의 종류 기본값은 템플릿에서 부모 다음 단계다.
  const kinds = index.nodeKinds;
  const next = parent
    ? kinds[
        Math.min(
          kinds.findIndex((k) => k.name === parent.kind) + 1,
          kinds.length - 1
        )
      ]
    : kinds[0];
  const [kind, setKind] = useState(next?.name ?? "");
  const [title, setTitle] = useState("");
  const add = useEditResearchMap(orgId);
  const submit = async () => {
    if (!title.trim() || add.isPending) return;
    try {
      const created = await add.mutateAsync({
        op: "create_node",
        input: { kind, title: title.trim(), parentNodeId: parent?.id },
      } satisfies MapEdit);
      setTitle("");
      onDone(created.id);
    } catch {
      // 입력은 그대로 둔다.
    }
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="text-xs text-slate-500">
        {parent
          ? `“${parent.title}” 아래에 추가`
          : "최상위(주 부모 없음)에 추가"}
      </div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="종류">
        {kinds.map((k) => (
          <button
            type="button"
            key={k.name}
            role="radio"
            aria-checked={kind === k.name}
            onClick={() => setKind(k.name)}
            className={`chip ${kind === k.name ? "bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <label className="sr-only" htmlFor="new-node-title">
        새 노드 제목
      </label>
      <input
        id="new-node-title"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="제목"
        className="w-full rounded-xl px-2.5 py-1.5 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400"
      />
      <button
        className="btn-primary w-full"
        disabled={!title.trim() || add.isPending}
      >
        노드 추가
      </button>
      {add.isError && <Problem error={add.error} />}
    </form>
  );
}

/** 노드 고르기. 수백 개여도 쓸 수 있게 ID·제목으로 찾는다. */
function NodePicker({
  nodes,
  kinds,
  value,
  onChange,
  placeholder,
  none,
}: {
  nodes: ResearchNode[];
  kinds: FlowKind[];
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  placeholder: string;
  none?: string;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const found = (
    query
      ? nodes.filter(
          (n) =>
            n.id.toLowerCase().includes(query) ||
            n.title.toLowerCase().includes(query)
        )
      : nodes
  ).slice(0, 40);
  return (
    <div className="rounded-xl ring-1 ring-slate-200">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-t-xl border-b border-slate-100 px-2.5 py-1.5 text-sm outline-none focus:bg-brand-50/40"
      />
      <ul
        className="scrollbar-thin max-h-44 overflow-auto p-1 text-xs"
        role="listbox"
        aria-label="찾은 노드"
      >
        {none && (
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => onChange(null)}
              className={`w-full rounded-lg px-2 py-1 text-left ${value === null ? "bg-brand-50 font-medium" : "hover:bg-slate-50"}`}
            >
              {none}
            </button>
          </li>
        )}
        {found.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              role="option"
              aria-selected={value === n.id}
              onClick={() => onChange(n.id)}
              className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left ${value === n.id ? "bg-brand-50 font-medium" : "hover:bg-slate-50"}`}
            >
              <span
                className={`shrink-0 rounded px-1 text-[10px] font-semibold ring-1 ${kindTone(kinds, n.kind)}`}
              >
                {kindLabel(kinds, n.kind)}
              </span>
              <span className="shrink-0 text-slate-400">{shortId(n.id)}</span>
              <span className="truncate">{n.title}</span>
            </button>
          </li>
        ))}
        {!found.length && (
          <li className="px-2 py-1 text-slate-400">일치하는 노드 없음</li>
        )}
        {nodes.length > 40 && found.length === 40 && (
          <li className="px-2 py-1 text-slate-400">
            … 검색어로 좁히세요 ({nodes.length}개)
          </li>
        )}
      </ul>
    </div>
  );
}

function ParentForm({
  orgId,
  index,
  node,
  onDone,
}: {
  orgId: string;
  index: MapIndex;
  node: ResearchNode;
  onDone: () => void;
}) {
  const blocked = useMemo(
    () => descendantsOf(index, node.id),
    [index, node.id]
  );
  const candidates = index.map.nodes.filter(
    (n) => n.id !== node.id && !blocked.has(n.id) && !discarded(n)
  );
  const discardedCount = index.map.nodes.filter(
    (n) => n.id !== node.id && !blocked.has(n.id) && discarded(n)
  ).length;
  const [value, setValue] = useState<string | null>(node.parentNodeId);
  const change = useEditResearchMap(orgId);
  const target = value ? index.byId.get(value) : undefined;
  return (
    <div className="space-y-2">
      <NodePicker
        nodes={candidates}
        kinds={index.nodeKinds}
        value={value}
        onChange={setValue}
        placeholder="새 주 부모 검색 (ID·제목)"
        none="주 부모 없음 (최상위로)"
      />
      <p className="text-[11px] text-slate-400">
        자기 자신과 후손 {blocked.size + 1}개는 순환이 되므로 목록에서 뺐습니다.
        {discardedCount > 0 && ` 폐기된 노드 ${discardedCount}개도 뺐습니다.`}
      </p>
      <button
        className="btn-primary w-full"
        disabled={value === node.parentNodeId || change.isPending}
        onClick={() =>
          void change
            .mutateAsync({
              op: "change_parent",
              nodeId: node.id,
              parentNodeId: value,
            })
            .then(onDone, () => undefined)
        }
      >
        주 부모를 {target ? `“${target.title}”` : "없음"}(으)로 변경
      </button>
      {change.isError && <Problem error={change.error} />}
    </div>
  );
}

function LinkForm({
  orgId,
  index,
  node,
  onDone,
}: {
  orgId: string;
  index: MapIndex;
  node: ResearchNode;
  onDone: () => void;
}) {
  const others = index.map.nodes.filter(
    (n) => n.id !== node.id && !discarded(n)
  );
  const [target, setTarget] = useState<string | null>(null);
  const [kind, setKind] = useState(index.linkKinds[0]?.name ?? "");
  const [reversed, setReversed] = useState(false);
  const add = useEditResearchMap(orgId);
  const [from, to] = reversed ? [target, node.id] : [node.id, target];
  const title = (id: string | null) =>
    id ? `“${index.byId.get(id)?.title ?? shortId(id)}”` : "?";
  if (!index.linkKinds.length)
    return (
      <p className="text-xs text-slate-500">
        조직의 연구 흐름 템플릿에 보조 연결 종류가 없습니다.
      </p>
    );
  return (
    <div className="space-y-2">
      <NodePicker
        nodes={others}
        kinds={index.nodeKinds}
        value={target}
        onChange={setTarget}
        placeholder="연결할 노드 검색 (ID·제목)"
      />
      <div
        className="flex flex-wrap items-center gap-1.5 text-xs"
        role="radiogroup"
        aria-label="연결 종류"
      >
        {index.linkKinds.map((k) => (
          <button
            key={k.name}
            type="button"
            role="radio"
            aria-checked={kind === k.name}
            onClick={() => setKind(k.name)}
            className={`chip ${kind === k.name ? "bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: linkColor(index.linkKinds, k.name) }}
            />
            {k.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setReversed(!reversed)}
          className="chip ml-auto bg-white ring-1 ring-slate-200"
          aria-pressed={reversed}
        >
          ⇄ 방향
        </button>
      </div>
      <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-xs break-words text-slate-600">
        {title(from)} ─{kindLabel(index.linkKinds, kind)}→ {title(to)}{" "}
        <span className="text-slate-400">· 주 배치는 바뀌지 않습니다</span>
      </div>
      <button
        className="btn-primary w-full"
        disabled={!target || add.isPending}
        onClick={() =>
          target &&
          void add
            .mutateAsync({
              op: "add_link",
              input: { sourceNodeId: from!, targetNodeId: to!, kind },
            })
            .then(onDone, () => undefined)
        }
      >
        보조 연결 추가
      </button>
      {add.isError && <Problem error={add.error} />}
    </div>
  );
}

/** 폐기는 상태 변경이며 확인 단계에서 그대로 남는 기록을 보여 준다. 폐기 취소도 여기서 한다. */
function DiscardControl({
  orgId,
  node,
  counts,
}: {
  orgId: string;
  node: ResearchNode;
  counts: { children: number; links: number; tasks: number };
}) {
  const [asking, setAsking] = useState(false);
  const edit = useEditResearchMap(orgId);
  const run = (op: "discard_node" | "restore_node") =>
    void edit.mutateAsync({ op, nodeId: node.id }).then(
      () => setAsking(false),
      () => undefined
    );
  let body: ReactNode;
  if (discarded(node))
    body = (
      <button
        className="btn-soft w-full"
        disabled={edit.isPending}
        onClick={() => run("restore_node")}
      >
        폐기 취소
        {node.statusBeforeDiscard &&
          ` (이전 상태: ${researchNodeStatusLabel[node.statusBeforeDiscard]})`}
      </button>
    );
  else if (!asking)
    body = (
      <button className="btn-danger w-full" onClick={() => setAsking(true)}>
        폐기…
      </button>
    );
  else
    body = (
      <div
        className="space-y-2 rounded-xl bg-rose-50 p-2.5 text-xs text-rose-800 ring-1 ring-rose-200"
        role="group"
        aria-label="폐기 확인"
      >
        <p>
          이 노드를 폐기합니다. 기록은 지우지 않습니다: 하위 노드{" "}
          {counts.children}개의 주 연결, 보조 연결 {counts.links}개, 연결 작업{" "}
          {counts.tasks}개가 그대로 남고 폐기 취소할 수 있습니다.
        </p>
        <div className="flex gap-1.5">
          <button
            className="btn-soft py-1 text-xs"
            onClick={() => setAsking(false)}
            autoFocus
          >
            취소
          </button>
          <button
            className="btn bg-rose-600 py-1 text-xs text-white hover:bg-rose-700"
            disabled={edit.isPending}
            onClick={() => run("discard_node")}
          >
            폐기
          </button>
        </div>
      </div>
    );
  return (
    <div>
      {body}
      {edit.isError && <Problem error={edit.error} />}
    </div>
  );
}

function Problem({ error }: { error: unknown }) {
  return (
    <p role="alert" className="mt-1.5 text-xs text-rose-600">
      {editFailure(error)}
    </p>
  );
}

function Section({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center text-xs font-semibold text-slate-700">
        {title}
        <button
          onClick={onClose}
          className="ml-auto text-slate-400 hover:text-slate-700"
          aria-label="닫기"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

function Seg({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex rounded-xl bg-white p-0.5 shadow-xs ring-1 ring-slate-200"
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
