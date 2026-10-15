// PROTOTYPE (#51) — Map B: React Flow + ELK (browser Worker). 위→아래, 왼쪽 개요 트리, 캔버스 직접 조작.
// Primary affordance is the canvas: drag a node's bottom handle onto another node and choose 주 부모 / 보조,
// drop on empty space to create a child, selected-node toolbar for title/폐기. Relayout is manual by default;
// nodes can be dragged and keep that spot until the next relayout.
import * as Dialog from "@radix-ui/react-dialog";
import { Background, Controls, NodeToolbar, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type NodeChange } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addNode, descendants, NODE_H, NODE_W, patchNode, REL_KINDS, REL_STYLE, setParent, addLink, type RNode } from "./data";
import type { Dir } from "./layout";
import { DiscardButton, KindTag, NodeFacts, nextKind, SEC_LABEL, StatusText, type SecMode } from "./parts";
import { CardCtx, nodeTypes, useEngineLayout, useFitOnce, useProjection, type RFNode } from "./rf";
import { reportStats, type MapApi } from "./store";
import { Empty } from "./VariantA";

export function MapB({ m }: { m: MapApi }) {
  return (
    <ReactFlowProvider>
      <Inner m={m} />
    </ReactFlowProvider>
  );
}

type Pending = { source: string; target: string };

function Inner({ m }: { m: MapApi }) {
  const [dir, setDir] = useState<Dir>("TB");
  const [secMode, setSecMode] = useState<SecMode>("focus");
  const [auto, setAuto] = useState(false);
  const [manual, setManual] = useState(new Map<string, { x: number; y: number }>());
  const [pending, setPending] = useState<Pending | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [outline, setOutline] = useState(true);
  const rf = useReactFlow();
  const connected = useRef(false);

  const visible = m.data.nodes;
  const layout = useEngineLayout("elk", visible, dir, auto);
  const proj = useProjection(m, { dir, secMode, hideDiscarded: false, connectable: true, layout, visible, manual });
  const node = m.data.nodes.find((n) => n.id === m.selected);

  // a fresh layout wins over hand-placed spots
  useEffect(() => setManual(new Map()), [layout.pos]);
  useFitOnce(`${m.key}|${dir}|${layout.laidKey?.split("|")[0]}`, layout.runs > 0);
  useEffect(() => {
    reportStats({ engine: "ELK layered (Worker, async)", visible: visible.length, total: m.data.nodes.length, primary: visible.filter((n) => n.parentId).length, secondary: m.data.links.length, layoutMs: layout.ms, layoutRuns: layout.runs, stale: layout.stale, pending: layout.pending, dirty: layout.dirty });
  });
  useEffect(() => () => reportStats(null), []);

  const onNodesChange = (cs: NodeChange<RFNode>[]) => {
    proj.onNodesChange(cs);
    const done = cs.filter((c) => c.type === "position" && c.dragging === false && c.position);
    if (done.length)
      setManual((mm) => {
        const n = new Map(mm);
        for (const c of done) if (c.type === "position" && c.position) n.set(c.id, { x: c.position.x + NODE_W / 2, y: c.position.y + NODE_H / 2 });
        return n;
      });
  };

  const addChild = (parent?: RNode) => {
    const r = addNode(m.data, nextKind(parent?.kind), "새 노드", parent?.id);
    if (m.apply(r) && r.ok) {
      m.select(r.touched);
      setEditing(r.touched);
    }
  };

  const toolbar = (n: RNode, selected: boolean) => (
    <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
      {editing === n.id ? (
        <InlineTitle
          n={n}
          onDone={(t) => {
            if (t !== undefined && t !== n.title) m.apply(patchNode(m.data, n.id, { title: t }));
            setEditing(null);
          }}
        />
      ) : (
        <div className="flex items-center gap-1 rounded-xl bg-slate-900 p-1 text-xs text-white shadow-pop">
          <button className="rounded-lg px-2 py-1 hover:bg-white/15" onClick={() => addChild(n)}>＋ 하위</button>
          <button className="rounded-lg px-2 py-1 hover:bg-white/15" onClick={() => setEditing(n.id)}>✎ 제목</button>
          <span className="px-1 text-white/50">● 끌어서 연결</span>
        </div>
      )}
    </NodeToolbar>
  );

  const tb = (on: boolean) => `rounded-lg px-2 py-1 text-xs transition ${on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`;

  return (
    <div className="flex min-h-[560px] flex-1 gap-3">
      {outline && <Outline m={m} onPick={(id) => {
        m.select(id);
        const p = rf.getNode(id);
        if (p) rf.setCenter(p.position.x + NODE_W / 2, p.position.y + NODE_H / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 350 });
      }} onClose={() => setOutline(false)} />}

      <div className="card relative min-h-[420px] min-w-0 flex-1 overflow-hidden" data-map-canvas>
        {!m.data.nodes.length && <Empty onAdd={() => addChild()} />}
        <div className="absolute top-2 left-2 z-10 flex flex-wrap items-center gap-1.5 rounded-xl bg-white/90 p-1 shadow-card ring-1 ring-slate-200 backdrop-blur">
          {!outline && <button className={tb(false)} onClick={() => setOutline(true)}>☰ 개요</button>}
          <button className={tb(false)} onClick={() => addChild()}>＋ 최상위</button>
          <span className="h-4 w-px bg-slate-200" />
          <button className={tb(dir === "TB")} onClick={() => setDir("TB")}>↓</button>
          <button className={tb(dir === "LR")} onClick={() => setDir("LR")}>→</button>
          <span className="h-4 w-px bg-slate-200" />
          <select value={secMode} onChange={(e) => setSecMode(e.target.value as SecMode)} className="rounded-lg bg-transparent px-1 py-1 text-xs text-slate-600" aria-label="보조 연결 표시">
            {(Object.keys(SEC_LABEL) as SecMode[]).map((k) => <option key={k} value={k}>{SEC_LABEL[k]}</option>)}
          </select>
          <span className="h-4 w-px bg-slate-200" />
          <label className="flex items-center gap-1 px-1 text-xs text-slate-600">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 자동 재배치
          </label>
          {layout.pending && <span className="animate-pulse px-1 text-xs text-brand-600">ELK 계산 중…</span>}
        </div>
        {(layout.dirty || manual.size > 0) && !layout.pending && (
          <div className="animate-fade-up absolute top-2 right-2 z-10 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-1.5 text-xs text-amber-900 shadow-card ring-1 ring-amber-200">
            {layout.dirty ? "구조가 바뀌었습니다 · 새 노드는 임시 위치" : `직접 옮긴 노드 ${manual.size}개`}
            <button className="btn-primary py-0.5 text-xs" onClick={layout.run}>↻ 재배치</button>
          </div>
        )}
        <CardCtx.Provider value={{ extra: toolbar }}>
          <ReactFlow
            nodes={proj.nodes}
            edges={proj.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, n) => m.select(n.id)}
            onNodeDoubleClick={(_, n) => setEditing(n.id)}
            onPaneClick={() => (m.select(undefined), setEditing(null))}
            onConnectStart={() => (connected.current = false)}
            onConnect={(c: Connection) => {
              connected.current = true;
              if (c.source && c.target) setPending({ source: c.source, target: c.target });
            }}
            onConnectEnd={(e, st) => {
              // dropped on empty canvas (not a completed connection) → new child of the dragged node
              const onPane = (e.target as Element | null)?.closest?.(".react-flow__pane");
              if (!connected.current && onPane && st.fromNode) addChild(m.data.nodes.find((x) => x.id === st.fromNode!.id));
            }}
            connectionRadius={36}
            deleteKeyCode={null}
            onlyRenderVisibleElements={proj.nodes.length > 150}
            minZoom={0.08}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#e2e8f0" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </CardCtx.Provider>

        {node && (
          <div key={node.id} className="animate-pop-in absolute right-3 bottom-3 z-10 w-[min(320px,calc(100%-1.5rem))] rounded-2xl bg-white p-3.5 shadow-pop ring-1 ring-slate-900/10">
            <div className="mb-1 flex items-center gap-1.5">
              <KindTag kind={node.kind} />
              <span className="text-xs text-slate-400">{node.id}</span>
              <select value={node.status} onChange={(e) => m.apply(patchNode(m.data, node.id, { status: e.target.value as RNode["status"] }))} className="ml-auto rounded-md bg-slate-50 px-1 py-0.5 text-[11px]" aria-label="상태" disabled={node.status === "폐기"}>
                {["제안됨", "진행 중", "완료", "기각됨", ...(node.status === "폐기" ? ["폐기"] : [])].map((s) => <option key={s}>{s}</option>)}
              </select>
              <button onClick={() => m.select(undefined)} className="btn-ghost px-1.5 py-0.5 text-xs" aria-label="상세 닫기">✕</button>
            </div>
            <div className="mb-2 text-sm leading-snug font-medium">{node.title}</div>
            <NodeFacts m={m} node={node} compact />
            <DiscardButton m={m} node={node} className="mt-3 w-full py-1 text-xs" />
          </div>
        )}
      </div>

      <ConnectDialog m={m} pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

/** Drag ended on another node: the gesture alone can't say which relation, so ask (research D04). */
function ConnectDialog({ m, pending, onClose }: { m: MapApi; pending: Pending | null; onClose: () => void }) {
  const p = pending;
  const a = p && m.data.nodes.find((n) => n.id === p.source);
  const b = p && m.data.nodes.find((n) => n.id === p.target);
  const cyc = p && (p.source === p.target || descendants(m.data, p.target).has(p.source));
  const same = b?.parentId === p?.source;
  return (
    <Dialog.Root open={!!p} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-fade-in fixed inset-0 z-40 bg-slate-950/30" />
        <Dialog.Content className="animate-pop-in fixed top-1/2 left-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-pop">
          <Dialog.Title className="font-semibold">이 연결을 무엇으로 만들까요?</Dialog.Title>
          {a && b && (
            <>
              <div className="mt-2 space-y-1 rounded-xl bg-slate-50 p-2.5 text-xs">
                <div className="flex items-center gap-1.5"><KindTag kind={a.kind} /> <b>{a.id}</b> <span className="truncate">{a.title}</span></div>
                <div className="pl-3 text-slate-400">↓</div>
                <div className="flex items-center gap-1.5"><KindTag kind={b.kind} /> <b>{b.id}</b> <span className="truncate">{b.title}</span></div>
              </div>
              <button
                className="btn-soft mt-3 w-full justify-start text-left"
                disabled={!!cyc || same}
                onClick={() => m.apply(setParent(m.data, b.id, a.id)) && onClose()}
              >
                <span className="font-semibold">주 연결</span>
                <span className="truncate text-xs text-slate-500">{same ? "이미 주 부모입니다" : cyc ? `순환이 되어 불가 (${a.id}가 ${b.id}의 후손)` : `${b.id}의 주 부모 ${b.parentId ?? "없음"} → ${a.id}`}</span>
              </button>
              <div className="mt-3 text-xs font-semibold text-slate-500">보조 연결 ({a.id} → {b.id})</div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {REL_KINDS.map((r) => (
                  <button key={r} className="btn-soft text-xs" onClick={() => m.apply(addLink(m.data, a.id, b.id, r)) && onClose()}>
                    <span className="h-2 w-2 rounded-full" style={{ background: REL_STYLE[r] }} /> {r}
                  </button>
                ))}
              </div>
              <Dialog.Close className="btn-ghost mt-3 w-full text-xs">취소 (Esc)</Dialog.Close>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InlineTitle({ n, onDone }: { n: RNode; onDone: (t?: string) => void }) {
  const [v, setV] = useState(n.title);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onDone(v.trim() || n.title);
      }}
      className="flex gap-1 rounded-xl bg-white p-1 shadow-pop ring-1 ring-slate-200"
    >
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} onFocus={(e) => e.target.select()} className="w-64 rounded-lg px-2 py-1 text-sm outline-none" aria-label="제목" />
      <button className="btn-primary py-0.5 text-xs">저장</button>
    </form>
  );
}

function Outline({ m, onPick, onClose }: { m: MapApi; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const rows = useMemo(() => {
    const kids = new Map<string | undefined, RNode[]>();
    const ids = new Set(m.data.nodes.map((n) => n.id));
    for (const n of m.data.nodes) {
      const k = n.parentId && ids.has(n.parentId) ? n.parentId : undefined;
      kids.set(k, [...(kids.get(k) ?? []), n]);
    }
    const out: { n: RNode; d: number; has: boolean }[] = [];
    const walk = (p: string | undefined, d: number) => {
      for (const n of kids.get(p) ?? []) {
        out.push({ n, d, has: kids.has(n.id) });
        if (!shut.has(n.id)) walk(n.id, d + 1);
      }
    };
    walk(undefined, 0);
    return out;
  }, [m.data.nodes, shut]);
  const s = q.trim().toLowerCase();
  const xs = s ? m.data.nodes.filter((n) => n.id.toLowerCase().includes(s) || n.title.toLowerCase().includes(s)).map((n) => ({ n, d: 0, has: false })) : rows;
  return (
    <aside className="card hidden w-64 shrink-0 flex-col overflow-hidden md:flex" aria-label="연구 지도 개요">
      <div className="flex items-center gap-1 border-b border-slate-100 p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`노드 찾기 (${m.data.nodes.length})`} className="min-w-0 flex-1 rounded-lg bg-slate-50 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand-300" />
        <button onClick={onClose} className="btn-ghost px-1.5 py-0.5 text-xs" aria-label="개요 닫기">«</button>
      </div>
      <ul className="scrollbar-thin flex-1 overflow-auto p-1 text-xs" role="tree">
        {xs.map(({ n, d, has }) => (
          <li key={n.id} role="treeitem" aria-selected={m.selected === n.id} aria-expanded={has ? !shut.has(n.id) : undefined}>
            <div className={`flex items-center gap-1 rounded-lg py-0.5 pr-1 ${m.selected === n.id ? "bg-brand-50 ring-1 ring-brand-200" : "hover:bg-slate-50"}`} style={{ paddingLeft: 4 + d * 12 }}>
              <button
                className={`w-3 shrink-0 text-[9px] text-slate-400 ${has ? "" : "invisible"}`}
                onClick={() => setShut((x) => { const y = new Set(x); if (y.has(n.id)) y.delete(n.id); else y.add(n.id); return y; })}
                aria-label="접기/펼치기"
              >
                {shut.has(n.id) ? "▸" : "▾"}
              </button>
              <button onClick={() => onPick(n.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                <KindTag kind={n.kind} className="shrink-0 !px-1 !py-0 !text-[9px]" />
                <span className={`truncate ${n.status === "폐기" ? "text-slate-400 line-through" : ""}`}>{n.title}</span>
              </button>
              {n.status !== "폐기" && n.status !== "제안됨" && <StatusText status={n.status} />}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
