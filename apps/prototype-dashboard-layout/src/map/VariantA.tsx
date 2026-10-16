// PROTOTYPE (#51) — Map A: React Flow + Dagre. 좌→우 트리, 오른쪽 고정 노드 상세 패널, 편집은 모두 명시 폼.
// Research baseline (D01/D04): select → detail → explicit forms; no drag-to-connect.
// Picked 2026-10-16. Round 2: nodes can be dragged (subtree follows by default). A dragged spot is view state,
// not a research record: it is pinned across auto relayouts, never logged as an edit, never wakes the Lead,
// and never changes the primary parent.
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type NodeChange } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { descendants, NODE_H, NODE_W, type RNode } from "./data";
import type { Dir } from "./layout";
import { AddForm, DiscardButton, KindTag, LinkForm, NodeFacts, ParentForm, SEC_LABEL, StatusText, TitleStatusForm, type SecMode } from "./parts";
import { nodeTypes, useEngineLayout, useFitOnce, useProjection, type RFNode } from "./rf";
import { reportStats, type MapApi } from "./store";

export function MapA({ m }: { m: MapApi }) {
  return (
    <ReactFlowProvider>
      <Inner m={m} />
    </ReactFlowProvider>
  );
}

type Form = "add" | "parent" | "link" | null;

function Inner({ m }: { m: MapApi }) {
  const [dir, setDir] = useState<Dir>("LR");
  const [secMode, setSecMode] = useState<SecMode>("all");
  const [hideGone, setHideGone] = useState(false);
  const [auto, setAuto] = useState(true);
  const [form, setForm] = useState<Form>(null);
  const [pinned, setPinned] = useState(new Map<string, { x: number; y: number }>()); // node centres
  const [follow, setFollow] = useState(true);
  const drag = useRef<Map<string, { x: number; y: number }> | null>(null); // top-left at drag start
  const rf = useReactFlow();

  const visible = useMemo(() => (hideGone ? m.data.nodes.filter((n) => n.status !== "폐기") : m.data.nodes), [m.data.nodes, hideGone]);
  const layout = useEngineLayout("dagre", visible, dir, auto);
  const proj = useProjection(m, { dir, secMode, hideDiscarded: hideGone, connectable: false, layout, visible, manual: pinned });
  const { nodes, edges } = proj;
  // flipping direction makes old spots meaningless
  useEffect(() => setPinned(new Map()), [dir]);

  const pin = (xs: { id: string; position: { x: number; y: number } }[]) =>
    setPinned((mm) => {
      const n = new Map(mm);
      for (const x of xs) n.set(x.id, { x: x.position.x + NODE_W / 2, y: x.position.y + NODE_H / 2 });
      return n;
    });
  const onNodesChange = (cs: NodeChange<RFNode>[]) => {
    proj.onNodesChange(cs);
    // keyboard moves (selected node + arrow keys) arrive as position changes outside a mouse drag
    if (!drag.current) {
      const moved = cs.filter((c) => c.type === "position" && c.position && !c.dragging) as { id: string; position: { x: number; y: number } }[];
      if (moved.length) pin(moved);
    }
  };
  const onDragStart = (id: string) => {
    const ids = new Set(follow ? [id, ...descendants(m.data, id)] : [id]);
    drag.current = new Map(nodes.filter((x) => ids.has(x.id)).map((x) => [x.id, { ...x.position }]));
  };
  const onDrag = (id: string, p: { x: number; y: number }) => {
    const s = drag.current;
    const p0 = s?.get(id);
    if (!s || !p0 || s.size < 2) return;
    const dx = p.x - p0.x;
    const dy = p.y - p0.y;
    proj.setNodes((ns) => ns.map((x) => (x.id !== id && s.has(x.id) ? { ...x, position: { x: s.get(x.id)!.x + dx, y: s.get(x.id)!.y + dy } } : x)));
  };
  const onDragStop = (id: string, p: { x: number; y: number }) => {
    const s = drag.current;
    drag.current = null;
    if (!s) return;
    const p0 = s.get(id)!;
    pin([...s].map(([k, v]) => ({ id: k, position: k === id ? p : { x: v.x + p.x - p0.x, y: v.y + p.y - p0.y } })));
  };
  const node = m.data.nodes.find((n) => n.id === m.selected);

  useEffect(() => setForm(null), [m.selected]);
  useFitOnce(`${m.key}|${dir}|${layout.laidKey?.split("|")[0]}`, layout.runs > 0);

  useEffect(() => {
    reportStats({ engine: "Dagre (sync)", visible: visible.length, total: m.data.nodes.length, primary: visible.filter((n) => n.parentId).length, secondary: m.data.links.length, layoutMs: layout.ms, layoutRuns: layout.runs, stale: layout.stale, pending: layout.pending, dirty: layout.dirty, pinned: pinned.size });
  });
  useEffect(() => () => reportStats(null), []);

  const tb = (on: boolean) => `rounded-lg px-2 py-1 text-xs transition ${on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`;

  return (
    <div className="flex min-h-[560px] flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary py-1 text-xs" onClick={() => (m.select(undefined), setForm("add"))}>
          ＋ 최상위 노드
        </button>
        <Seg>
          <button className={tb(dir === "LR")} onClick={() => setDir("LR")}>좌→우</button>
          <button className={tb(dir === "TB")} onClick={() => setDir("TB")}>위→아래</button>
        </Seg>
        <Seg>
          {(Object.keys(SEC_LABEL) as SecMode[]).map((k) => (
            <button key={k} className={tb(secMode === k)} onClick={() => setSecMode(k)}>
              {SEC_LABEL[k]}
            </button>
          ))}
        </Seg>
        <Seg>
          <button className={tb(!hideGone)} onClick={() => setHideGone(false)}>폐기 흐리게</button>
          <button className={tb(hideGone)} onClick={() => setHideGone(true)}>폐기 숨김 ({m.data.nodes.filter((n) => n.status === "폐기").length})</button>
        </Seg>
        <Seg>
          <button className={tb(auto)} onClick={() => setAuto(true)}>자동 재배치</button>
          <button className={tb(!auto)} onClick={() => setAuto(false)}>수동</button>
        </Seg>
        {!auto && (
          <button className={`btn py-1 text-xs ${layout.dirty ? "bg-amber-500 text-white" : "btn-soft"}`} onClick={layout.run}>
            ↻ 재배치{layout.dirty && " (구조 바뀜)"}
          </button>
        )}
        <Seg>
          <button className={tb(follow)} onClick={() => setFollow(true)} title="노드를 끌면 그 아래 주 연결 하위 노드도 같이 움직입니다">끌면 하위도 함께</button>
          <button className={tb(!follow)} onClick={() => setFollow(false)}>그 노드만</button>
        </Seg>
        {pinned.size > 0 && (
          <button className="btn-soft py-1 text-xs" onClick={() => setPinned(new Map())} title="직접 옮긴 위치를 지우고 자동 배치로 돌아갑니다">
            ↺ 자동 정렬로 되돌리기 ({pinned.size})
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="card relative min-h-[420px] flex-1 overflow-hidden" data-map-canvas>
          {!m.data.nodes.length && <Empty onAdd={() => setForm("add")} />}
          {!node && m.data.nodes.length > 0 && <div className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-white/85 px-2 py-1 text-[11px] text-slate-500">노드를 누르면 오른쪽에 상세·편집 패널 · 끌어서 위치 이동(지도 보기에만 저장) · Tab→Enter로도 선택</div>}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, n) => m.select(n.id)}
            onPaneClick={() => m.select(undefined)}
            onNodeDragStart={(_, n) => onDragStart(n.id)}
            onNodeDrag={(_, n) => onDrag(n.id, n.position)}
            onNodeDragStop={(_, n) => onDragStop(n.id, n.position)}
            selectNodesOnDrag={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onlyRenderVisibleElements={nodes.length > 150}
            minZoom={0.08}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#e2e8f0" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => ((n.data as { n: RNode }).n.status === "폐기" ? "#cbd5e1" : "#a5b4fc")} className="!hidden md:!block" />
          </ReactFlow>
        </div>

        {/* the panel only takes width while something is open; the map gets the full width otherwise */}
        {(node || form === "add") && (
          <aside className="card scrollbar-thin animate-slide-in-right flex max-h-[70vh] w-full shrink-0 flex-col overflow-auto p-4 lg:max-h-none lg:w-[340px]" aria-label="노드 상세">
            {form === "add" && !node ? (
              <Section title="최상위 노드 추가" onClose={() => setForm(null)}>
                <AddForm m={m} onDone={(id) => m.select(id)} />
              </Section>
            ) : (
              node && <Detail key={node.id} m={m} node={node} form={form} setForm={setForm} onCenter={() => rf.fitView({ nodes: [{ id: node.id }], maxZoom: 1.1, duration: 300 })} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function Detail({ m, node, form, setForm, onCenter }: { m: MapApi; node: RNode; form: Form; setForm: (f: Form) => void; onCenter: () => void }) {
  return (
    <div className="animate-fade-up space-y-4">
      <div>
        <div className="flex items-center gap-1.5">
          <KindTag kind={node.kind} />
          <span className="text-xs text-slate-400">{node.id}</span>
          <StatusText status={node.status} />
          <button onClick={onCenter} className="btn-ghost ml-auto px-1.5 py-0.5 text-xs" title="지도에서 이 노드로 이동">
            ◎
          </button>
          <button onClick={() => m.select(undefined)} className="btn-ghost px-1.5 py-0.5 text-xs" aria-label="상세 닫기">
            ✕
          </button>
        </div>
        <TitleStatusForm key={node.title} m={m} node={node} />
      </div>
      <NodeFacts m={m} node={node} />
      <div className="grid grid-cols-3 gap-1.5">
        <button className={`btn-soft px-1 text-xs ${form === "add" ? "!bg-brand-50 !ring-brand-300" : ""}`} onClick={() => setForm(form === "add" ? null : "add")}>＋ 하위 노드</button>
        <button className={`btn-soft px-1 text-xs ${form === "parent" ? "!bg-brand-50 !ring-brand-300" : ""}`} onClick={() => setForm(form === "parent" ? null : "parent")}>주 부모 변경</button>
        <button className={`btn-soft px-1 text-xs ${form === "link" ? "!bg-brand-50 !ring-brand-300" : ""}`} onClick={() => setForm(form === "link" ? null : "link")}>보조 연결</button>
      </div>
      {form === "add" && (
        <Section title="하위 노드 추가" onClose={() => setForm(null)}>
          <AddForm m={m} parent={node} onDone={(id) => m.select(id)} />
        </Section>
      )}
      {form === "parent" && (
        <Section title="주 부모 변경" onClose={() => setForm(null)}>
          <ParentForm m={m} node={node} onDone={() => setForm(null)} />
        </Section>
      )}
      {form === "link" && (
        <Section title="보조 연결 추가" onClose={() => setForm(null)}>
          <LinkForm m={m} node={node} onDone={() => setForm(null)} />
        </Section>
      )}
      <DiscardButton m={m} node={node} className="w-full" />
    </div>
  );
}

function Section({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="animate-fade-up rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center text-xs font-semibold text-slate-700">
        {title}
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700" aria-label="닫기">
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

function Seg({ children }: { children: ReactNode }) {
  return <div className="flex rounded-xl bg-white p-0.5 shadow-xs ring-1 ring-slate-200">{children}</div>;
}

export function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center">
      <div className="text-center text-sm text-slate-500">
        <div className="mb-1 text-2xl">◌</div>
        아직 연구 노드가 없습니다. 초기 연구 승인 뒤 Lead와 작업자가 노드를 만듭니다.
        <div className="mt-3">
          <button className="btn-soft" onClick={onAdd}>
            직접 문제 노드 추가
          </button>
        </div>
      </div>
    </div>
  );
}
