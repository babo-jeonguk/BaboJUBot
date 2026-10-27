import "@xyflow/react/dist/style.css";
import "./org-chart.css";
import type { Agent } from "@babojubot/contracts";
import {
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AgentFace, faceMoodOf } from "./agent-face.tsx";
import { roleLabel } from "./agents.tsx";
import { useAgent, useRunningRuns } from "./api.ts";
import { AgentStatusBadge, PausedBadge } from "./ui.tsx";

// 조직 › 에이전트의 팀 그래프. 위에 Research Lead, 아래에 작업자를 두고 연결한다(paperclip OrgChart의 위→아래 나무 배치).
// 팀은 Lead 아래 작업자 한 층뿐이라 자동 배치 없이 작업자를 생긴 순서대로 한 줄에 놓고 Lead를 가운데 둔다.
// 넓은 화면은 끌기·확대·한눈에 보기를 쓰고, 좁은 화면은 Lead 아래로 작업자를 들여 쌓아 넘치지 않는다.

const nodeHeight = 84;
const treeNodeWidth = 236;
const gap = { x: 28, y: 64 };
/** 이보다 좁으면 들여 쌓기. 작업자 두 명이 한 줄에 들어가지 않는 폭이다. */
const stackBelow = 2 * treeNodeWidth + gap.x + 48;
const stackIndent = 28;
const stackGap = 14;

type Layout = "tree" | "stack";
type AgentNodeData = {
  orgId: string;
  agent: Agent;
  layout: Layout;
  width: number;
};
type ChartNode =
  | Node<AgentNodeData, "agent">
  | Node<{ width: number; layout: Layout }, "empty">;

const ariaLabelConfig = {
  "controls.ariaLabel": "보기 조절",
  "controls.zoomIn.ariaLabel": "확대",
  "controls.zoomOut.ariaLabel": "축소",
  "controls.fitView.ariaLabel": "한눈에 보기",
  "node.a11yDescription.default": "",
  "node.a11yDescription.keyboardDisabled": "",
  "edge.a11yDescription.default": "",
};

export default function OrgChart({
  orgId,
  agents,
}: {
  orgId: string;
  agents: Agent[];
}) {
  return (
    <ReactFlowProvider>
      <Chart orgId={orgId} agents={agents} />
    </ReactFlowProvider>
  );
}

function Chart({ orgId, agents }: { orgId: string; agents: Agent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const layout: Layout = width > 0 && width < stackBelow ? "stack" : "tree";
  const running = useRunningRuns(orgId).data;
  // 조직 상세는 Event마다 새 배열로 오므로, 보이는 값이 같으면 같은 그래프를 쓴다.
  const shown = JSON.stringify(
    agents.map((a) => [a.id, a.role, a.name, a.appearance])
  );
  const busy = (running ?? [])
    .map((r) => r.agentId)
    .sort()
    .join();
  const graph = useMemo(() => {
    const lead = agents.find((a) => a.role === "lead");
    if (!lead || !width) return { nodes: [], edges: [], height: 0 };
    const workers = agents.filter((a) => a.role === "worker");
    const built =
      layout === "tree"
        ? treeLayout(orgId, lead, workers)
        : stackLayout(orgId, lead, workers, width);
    const active = new Set(busy.split(","));
    for (const edge of built.edges) edge.animated = active.has(edge.target);
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- agents는 shown으로 비교한다.
  }, [orgId, layout, width, shown, busy]);
  const members = agents.map((a) => a.id).join();
  const height =
    layout === "tree"
      ? Math.min(Math.max(graph.height + 96, 300), 560)
      : graph.height;
  return (
    <div
      ref={box}
      className="card relative overflow-hidden"
      style={{ height: height || 300 }}
    >
      {width > 0 && (
        <Canvas
          key={layout}
          graph={graph}
          tree={layout === "tree"}
          fitKey={`${members}|${width}`}
        />
      )}
    </div>
  );
}

function Canvas({
  graph,
  tree,
  fitKey,
}: {
  graph: { nodes: ChartNode[]; edges: Edge[] };
  tree: boolean;
  /** 구성원이나 폭이 바뀌면 다시 한눈에 맞춘다. 이름·상태가 바뀔 때는 보던 위치를 그대로 둔다. */
  fitKey: string;
}) {
  const rf = useReactFlow();
  useEffect(() => {
    if (!tree) return;
    const id = requestAnimationFrame(() => void rf.fitView(fitOptions));
    return () => cancelAnimationFrame(id);
  }, [rf, tree, fitKey]);
  return (
    <ReactFlow<ChartNode>
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      panOnDrag={tree}
      zoomOnPinch={tree}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      panOnScroll={false}
      fitView={tree}
      fitViewOptions={fitOptions}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      minZoom={0.3}
      maxZoom={1.6}
      ariaLabelConfig={ariaLabelConfig}
      proOptions={{ hideAttribution: true }}
      className={tree ? "org-chart" : "org-chart cursor-default"}
    >
      {tree && <Controls showInteractive={false} position="bottom-right" />}
    </ReactFlow>
  );
}

const fitOptions = { padding: 0.14, maxZoom: 1, minZoom: 0.45 };

function treeLayout(orgId: string, lead: Agent, workers: Agent[]) {
  const row = workers.length ? workers.length : 1;
  const rowWidth = row * treeNodeWidth + (row - 1) * gap.x;
  const y = nodeHeight + gap.y;
  const nodes: ChartNode[] = [
    {
      id: lead.id,
      type: "agent",
      position: { x: (rowWidth - treeNodeWidth) / 2, y: 0 },
      data: { orgId, agent: lead, layout: "tree", width: treeNodeWidth },
    },
    ...workers.map((agent, i): ChartNode => ({
      id: agent.id,
      type: "agent",
      position: { x: i * (treeNodeWidth + gap.x), y },
      data: { orgId, agent, layout: "tree", width: treeNodeWidth },
    })),
  ];
  if (!workers.length)
    nodes.push({
      id: "empty",
      type: "empty",
      position: { x: 0, y },
      data: { width: treeNodeWidth, layout: "tree" },
    });
  const edges = nodes.slice(1).map((n) => edgeOf(lead.id, n.id, "tree"));
  return { nodes, edges, height: y + nodeHeight };
}

function stackLayout(
  orgId: string,
  lead: Agent,
  workers: Agent[],
  width: number
) {
  const pad = 12;
  const full = width - 2 * pad;
  const row = (i: number) => pad + i * (nodeHeight + stackGap);
  const nodes: ChartNode[] = [
    {
      id: lead.id,
      type: "agent",
      position: { x: pad, y: row(0) },
      data: { orgId, agent: lead, layout: "stack", width: full },
    },
    ...workers.map((agent, i): ChartNode => ({
      id: agent.id,
      type: "agent",
      position: { x: pad + stackIndent, y: row(i + 1) },
      data: { orgId, agent, layout: "stack", width: full - stackIndent },
    })),
  ];
  if (!workers.length)
    nodes.push({
      id: "empty",
      type: "empty",
      position: { x: pad + stackIndent, y: row(1) },
      data: { width: full - stackIndent, layout: "stack" },
    });
  const edges = nodes.slice(1).map((n) => edgeOf(lead.id, n.id, "stack"));
  return { nodes, edges, height: row(nodes.length) - stackGap + pad };
}

const edgeOf = (source: string, target: string, layout: Layout): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle: layout,
  targetHandle: layout,
  type: "smoothstep",
  className: "org-chart-edge",
});

const nodeTypes = { agent: AgentNode, empty: EmptyNode };

/** 그래프의 에이전트 카드. 카드 전체가 에이전트 상세로 가는 링크이고, 실행 중인 작업자로 가는 연결은 흐른다. */
function AgentNode({ data }: NodeProps<Node<AgentNodeData, "agent">>) {
  const { orgId, agent, layout, width } = data;
  const detail = useAgent(orgId, agent.id).data;
  const isLead = agent.role === "lead";
  return (
    <>
      <Handles layout={layout} />
      <Link
        to={`/orgs/${orgId}/agents/${agent.id}`}
        data-agent-node={agent.id}
        className={`card card-hover flex items-center gap-3 px-3 ${isLead ? "ring-2 ring-brand-200" : ""}`}
        style={{ width, height: nodeHeight }}
      >
        <AgentFace
          appearance={agent.appearance}
          mood={faceMoodOf(detail)}
          size={52}
          seed={agent.id}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-slate-900">
            {agent.name}
          </span>
          {agent.name !== roleLabel[agent.role] && (
            <span className="block truncate text-xs text-slate-500">
              {roleLabel[agent.role]}
            </span>
          )}
          <span className="mt-1 flex items-center gap-1">
            {detail && <AgentStatusBadge status={detail.status} />}
            {detail?.paused && <PausedBadge />}
          </span>
        </span>
      </Link>
    </>
  );
}

function EmptyNode({
  data,
}: NodeProps<Node<{ width: number; layout: Layout }, "empty">>) {
  return (
    <>
      <Handles layout={data.layout} />
      <div
        className="flex items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 text-sm text-slate-400"
        style={{ width: data.width, height: nodeHeight }}
      >
        아직 작업자가 없습니다
      </div>
    </>
  );
}

/** 연결 지점. 보이지 않으며, 나무는 위·아래, 들여 쌓기는 Lead 왼쪽 아래 → 작업자 왼쪽이다. */
function Handles({ layout }: { layout: Layout }) {
  const hidden = "!h-1 !w-1 !min-w-0 !border-0 !bg-transparent";
  return layout === "tree" ? (
    <>
      <Handle
        id="tree"
        type="target"
        position={Position.Top}
        className={hidden}
        isConnectable={false}
      />
      <Handle
        id="tree"
        type="source"
        position={Position.Bottom}
        className={hidden}
        isConnectable={false}
      />
    </>
  ) : (
    <>
      <Handle
        id="stack"
        type="target"
        position={Position.Left}
        className={hidden}
        isConnectable={false}
      />
      <Handle
        id="stack"
        type="source"
        position={Position.Bottom}
        className={hidden}
        style={{ left: stackIndent / 2 }}
        isConnectable={false}
      />
    </>
  );
}

function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry!.contentRect.width))
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
