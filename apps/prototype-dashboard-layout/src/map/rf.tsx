// PROTOTYPE (#51) — throwaway React Flow plumbing shared by variants A (Dagre) and B (ELK):
// domain → renderer projection, the layout trigger/revision hook, and the node card.
// Projection rules from the research: relation IDs are kept as edge IDs (no addEdge dedup), primary
// parent is NOT mapped to React Flow parentId (that is visual containment), deletes never reach the lib.
import { Handle, MarkerType, Position, applyNodeChanges, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { layoutKey, NODE_H, NODE_W, pathToRoot, REL_STYLE, type RNode } from "./data";
import { dagreLayout, elkLayout, flextreeLayout, type Dir, type Pos } from "./layout";
import { KindTag, StatusText, tasksFor, type SecMode } from "./parts";
import type { MapApi } from "./store";

// ---------- layout trigger + revision guard (research D06 / V08) ----------

export type Engine = "dagre" | "elk" | "flextree";
export type LayoutState = { pos?: Pos; ms?: number; runs: number; stale: number; pending: boolean; laidKey?: string };

/** auto: relayout whenever the primary structure changes. manual: mark dirty and wait for run().
 * Async (ELK) results are applied only if no newer run started — older results are counted as stale. */
export function useEngineLayout(engine: Engine, visible: RNode[], dir: Dir, auto: boolean) {
  const key = layoutKey(visible, dir);
  const [st, setSt] = useState<LayoutState>({ runs: 0, stale: 0, pending: false });
  const rev = useRef(0);
  const vis = useRef(visible);
  vis.current = visible;

  const run = useCallback(() => {
    const my = ++rev.current;
    const nodes = vis.current;
    const k = layoutKey(nodes, dir);
    if (engine === "elk") {
      setSt((s) => ({ ...s, pending: true }));
      elkLayout(nodes, dir).then((r) => {
        if (my !== rev.current) return setSt((s) => ({ ...s, stale: s.stale + 1 }));
        setSt((s) => ({ ...s, pos: r.pos, ms: r.ms, runs: s.runs + 1, pending: false, laidKey: k }));
      });
    } else {
      const r = engine === "dagre" ? dagreLayout(nodes, dir) : flextreeLayout(nodes, dir);
      setSt((s) => ({ ...s, pos: r.pos, ms: r.ms, runs: s.runs + 1, laidKey: k }));
    }
  }, [engine, dir]);

  // direction change or first mount always lays out; structure change only when auto
  useEffect(() => run(), [run]);
  useEffect(() => {
    if (auto && st.laidKey !== undefined && st.laidKey !== key) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto]);
  useEffect(
    () => () => {
      rev.current = -1; // unmount (e.g. org switch): any in-flight result is dropped
    },
    [],
  );
  return { ...st, run, dirty: st.laidKey !== undefined && st.laidKey !== key };
}

/** Nodes the last layout did not see (manual mode) are parked next to their parent so they stay visible. */
export function placeAll(nodes: RNode[], pos: Pos | undefined, dir: Dir) {
  const out: Pos = new Map();
  if (!pos) return { out, unplaced: new Set(nodes.map((n) => n.id)) };
  const by = new Map(nodes.map((n) => [n.id, n]));
  const unplaced = new Set<string>();
  const kidsSeen = new Map<string, number>();
  let minX = Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) (minX = Math.min(minX, p.x)), (maxY = Math.max(maxY, p.y));
  let orphanRow = 0;
  const at = (id: string, guard = 0): { x: number; y: number } => {
    if (out.has(id)) return out.get(id)!;
    const p = pos.get(id);
    if (p) return out.set(id, p), p;
    unplaced.add(id);
    const n = by.get(id)!;
    let q: { x: number; y: number };
    if (n.parentId && by.has(n.parentId) && guard < 50) {
      const pp = at(n.parentId, guard + 1);
      const k = kidsSeen.get(n.parentId) ?? 0;
      kidsSeen.set(n.parentId, k + 1);
      q = dir === "LR" ? { x: pp.x + NODE_W + 72, y: pp.y + (k + 1) * (NODE_H + 18) } : { x: pp.x + (k + 1) * (NODE_W + 24), y: pp.y + NODE_H + 56 };
    } else q = { x: (isFinite(minX) ? minX : 0) - NODE_W - 80, y: (isFinite(maxY) ? 0 : 0) + orphanRow++ * (NODE_H + 18) };
    out.set(id, q);
    return q;
  };
  for (const n of nodes) at(n.id);
  return { out, unplaced };
}

/** Fit once per fixture/direction after React Flow has measured the nodes; later relayouts keep the viewport. */
export function useFitOnce(key: string, ready: boolean) {
  const rf = useReactFlow();
  const init = useNodesInitialized();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !init || done.current === key) return;
    done.current = key;
    requestAnimationFrame(() => rf.fitView({ padding: 0.12, maxZoom: 1, minZoom: 0.45 }));
  }, [key, ready, init, rf]);
}

// ---------- projection ----------

export type CardData = { n: RNode; dim: boolean; tasks: number; dir: Dir; connectable: boolean; unplaced: boolean; focus: boolean };
export type RFNode = Node<CardData, "research">;

export function useProjection(m: MapApi, opts: { dir: Dir; secMode: SecMode; hideDiscarded: boolean; connectable: boolean; layout: ReturnType<typeof useEngineLayout>; visible: RNode[]; manual?: Map<string, { x: number; y: number }> }) {
  const { dir, secMode, visible, layout } = opts;
  const sel = m.selected;
  const ids = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const focus = useMemo(() => {
    if (!sel) return undefined;
    const s = new Set(pathToRoot(m.data, sel));
    for (const l of m.data.links) if (l.source === sel || l.target === sel) s.add(l.source), s.add(l.target);
    for (const n of m.data.nodes) if (n.parentId === sel) s.add(n.id);
    return s;
  }, [m.data, sel]);

  const placed = useMemo(() => placeAll(visible, layout.pos, dir), [visible, layout.pos, dir]);

  const derived: RFNode[] = useMemo(
    () =>
      visible.map((n) => {
        const c = opts.manual?.get(n.id) ?? placed.out.get(n.id) ?? { x: 0, y: 0 };
        return {
          id: n.id,
          type: "research",
          position: { x: c.x - NODE_W / 2, y: c.y - NODE_H / 2 },
          selected: n.id === sel,
          draggable: !!opts.manual,
          data: { n, dim: !!focus && !focus.has(n.id), tasks: tasksFor(m, n.id).length, dir, connectable: opts.connectable, unplaced: placed.unplaced.has(n.id) && !!layout.pos, focus: !!focus?.has(n.id) },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, placed, sel, focus, dir, opts.connectable, opts.manual],
  );

  // keep React Flow's measured size on our controlled nodes so handle bounds survive re-derivation
  const [nodes, setNodes] = useState<RFNode[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const pm = new Map(prev.map((x) => [x.id, x.measured]));
      return derived.map((x) => ({ ...x, measured: pm.get(x.id) }));
    });
  }, [derived]);

  const edges: Edge[] = useMemo(() => {
    const es: Edge[] = [];
    for (const n of visible)
      if (n.parentId && ids.has(n.parentId)) {
        const on = !!focus && focus.has(n.id) && focus.has(n.parentId);
        es.push({
          id: `p:${n.id}`,
          source: n.parentId,
          target: n.id,
          type: "smoothstep",
          selectable: false,
          style: { stroke: on ? "#4338ca" : "#94a3b8", strokeWidth: on ? 2.2 : 1.5, opacity: focus && !on ? 0.35 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color: on ? "#4338ca" : "#94a3b8", width: 14, height: 14 },
        });
      }
    if (secMode !== "off")
      for (const l of m.data.links) {
        if (!ids.has(l.source) || !ids.has(l.target)) continue;
        const touch = l.source === sel || l.target === sel;
        if (secMode === "focus" && !touch) continue;
        es.push({
          id: l.id, // relation ID, not source/target tuple (research D03)
          source: l.source,
          target: l.target,
          type: "default",
          selectable: false,
          zIndex: touch ? 5 : 0,
          label: touch ? l.rel : undefined,
          labelStyle: { fill: REL_STYLE[l.rel], fontWeight: 600, fontSize: 11 },
          labelBgStyle: { fill: "white" },
          style: { stroke: REL_STYLE[l.rel], strokeWidth: touch ? 2 : 1.2, strokeDasharray: "5 4", opacity: touch ? 0.95 : sel ? 0.12 : 0.32 },
          markerEnd: { type: MarkerType.Arrow, color: REL_STYLE[l.rel], width: 12, height: 12 },
        });
      }
    return es;
  }, [visible, ids, m.data.links, secMode, sel, focus]);

  const onNodesChange = useCallback(
    (cs: NodeChange<RFNode>[]) => {
      setNodes((ns) => applyNodeChanges(cs, ns));
      for (const c of cs) if (c.type === "select" && c.selected) m.select(c.id);
    },
    [m],
  );
  return { nodes, edges, onNodesChange, setNodes };
}

// ---------- node card ----------

export const CardCtx = createContext<{ extra?: (n: RNode, selected: boolean) => ReactNode }>({});

export const ResearchCard = memo(function ResearchCard({ data, selected }: NodeProps<RFNode>) {
  const { n, dim, tasks, dir, connectable, unplaced } = data;
  const { extra } = useContext(CardCtx);
  const gone = n.status === "폐기";
  const hcls = connectable ? "!h-3 !w-3 !border-2 !border-white !bg-brand-500" : "!h-1.5 !w-1.5 !min-w-0 !border-0 !bg-slate-300 !opacity-0";
  return (
    <>
      {extra?.(n, !!selected)}
      <div
        style={{ width: NODE_W, height: NODE_H }}
        className={`flex flex-col rounded-xl bg-white px-2.5 py-2 text-left transition-[opacity,box-shadow] duration-150 ${gone ? "border border-dashed border-slate-300 bg-slate-50" : "shadow-card ring-1 ring-slate-900/[0.07]"} ${selected ? "!ring-2 !ring-brand-500 shadow-lift" : ""} ${dim ? "opacity-30" : gone ? "opacity-70" : ""}`}
      >
        <Handle type="target" position={dir === "LR" ? Position.Left : Position.Top} isConnectable={connectable} className={hcls} />
        <div className="flex items-center gap-1.5">
          <KindTag kind={n.kind} />
          <span className="text-[10px] text-slate-400">{n.id}</span>
          <StatusText status={n.status} />
          {tasks > 0 && <span className="ml-auto rounded bg-slate-100 px-1 text-[10px] text-slate-500">작업 {tasks}</span>}
          {unplaced && <span className="ml-auto rounded bg-amber-100 px-1 text-[10px] text-amber-800">배치 전</span>}
        </div>
        <div className={`mt-1 line-clamp-2 text-[12.5px] leading-snug ${gone ? "text-slate-400 line-through" : "text-slate-800"}`} title={n.title}>
          {n.title}
        </div>
        <Handle type="source" position={dir === "LR" ? Position.Right : Position.Bottom} isConnectable={connectable} className={hcls} />
      </div>
    </>
  );
});
export const nodeTypes = { research: ResearchCard };
