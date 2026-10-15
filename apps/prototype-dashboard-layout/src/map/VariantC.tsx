// PROTOTYPE (#51) — Map C: Cytoscape (Canvas) + flextree tidy forest (virtual root). 검색 중심, 하단 서랍.
// Primary affordance: find (search box / keyboard tree walk) → act. Relations are made by "pick mode":
// press 주 부모 지정 / 보조 연결, then tap the other node on the map (illegal targets are faded).
// Layout is always automatic and animated; labels drop out when zoomed far out (Canvas LOD).
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLink, childrenOf, descendants, KIND_STYLE, KINDS, pathToRoot, REL_KINDS, REL_STYLE, setParent, type RelKind, type RNode } from "./data";
import type { Dir } from "./layout";
import { AddForm, DiscardButton, KindTag, NodeFacts, ParentForm, SEC_LABEL, TitleStatusForm, type SecMode } from "./parts";
import { useEngineLayout } from "./rf";
import { reportStats, type MapApi } from "./store";

const W = 184;
const H = 56;
const SHAPE = { 문제: "rectangle", 가설: "round-rectangle", "검증 방법": "cut-rectangle", 실험: "round-rectangle", 결과: "bottom-round-rectangle" } as const;
const clip = (s: string, k = 38) => (s.length > k ? s.slice(0, k - 1) + "…" : s);

type Pick = { mode: "parent" | "link"; from: string; target?: string } | null;

export function MapC({ m }: { m: MapApi }) {
  const box = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [dir, setDir] = useState<Dir>("TB");
  const [secMode, setSecMode] = useState<SecMode>("all");
  const [hideGone, setHideGone] = useState(false);
  const [pick, setPick] = useState<Pick>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [panel, setPanel] = useState<"add" | "parent" | null>(null);
  const [q, setQ] = useState("");
  const [zoom, setZoom] = useState(1);
  const search = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  const visible = useMemo(() => (hideGone ? m.data.nodes.filter((n) => n.status !== "폐기") : m.data.nodes), [m.data.nodes, hideGone]);
  const layout = useEngineLayout("flextree", visible, dir, true);
  const node = m.data.nodes.find((n) => n.id === m.selected);
  const blocked = useMemo(() => (pick?.mode === "parent" ? new Set([pick.from, ...descendants(m.data, pick.from)]) : pick ? new Set([pick.from]) : null), [pick, m.data]);

  // latest handlers for cytoscape listeners (registered once)
  const tapRef = useRef<(id?: string) => void>(() => {});
  tapRef.current = (id) => {
    setMenu(null);
    if (pick) {
      if (!id) return;
      if (blocked?.has(id)) return m.apply(pick.mode === "parent" ? setParent(m.data, pick.from, id) : addLink(m.data, pick.from, id, "참고"));
      if (pick.mode === "parent") {
        if (m.apply(setParent(m.data, pick.from, id))) setPick(null);
      } else setPick({ ...pick, target: id });
      return;
    }
    m.select(id);
  };
  const menuRef = useRef<(id: string, x: number, y: number) => void>(() => {});
  menuRef.current = (id, x, y) => {
    m.select(id);
    setMenu({ id, x, y });
  };

  // mount cytoscape once
  useEffect(() => {
    const cy = cytoscape({
      container: box.current,
      autounselectify: true,
      boxSelectionEnabled: false,
      minZoom: 0.06,
      maxZoom: 2.5,
      textureOnViewport: true,
      hideEdgesOnViewport: false,
      style: [
        {
          selector: "node",
          style: {
            shape: "data(shape)" as never,
            width: W,
            height: H,
            "background-color": "#ffffff",
            "border-width": 1.5,
            "border-color": "data(color)",
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": `${W - 16}px`,
            "text-valign": "center",
            "font-size": 11,
            "line-height": 1.3,
            color: "#1e293b",
            "font-family": "Pretendard Variable, Pretendard, sans-serif",
            "min-zoomed-font-size": 7,
          },
        },
        { selector: "node.gone", style: { "border-style": "dashed", "background-color": "#f8fafc", color: "#94a3b8" } },
        { selector: "node.sel", style: { "border-width": 3.5, "border-color": "#4338ca", "background-color": "#eef0ff" } },
        { selector: "node.faded", style: { opacity: 0.18 } },
        { selector: "node.blocked", style: { opacity: 0.12 } },
        { selector: "node.pickable", style: { "border-width": 2.5, "overlay-color": "#6366f1", "overlay-opacity": 0.06 } },
        { selector: "edge.primary", style: { "curve-style": "taxi", width: 1.5, "line-color": "#94a3b8", "target-arrow-shape": "triangle", "target-arrow-color": "#94a3b8", "arrow-scale": 0.8 } },
        { selector: "edge.secondary", style: { "curve-style": "unbundled-bezier", "control-point-distances": [40], "line-style": "dashed", "line-dash-pattern": [6, 4], width: 1.2, "line-color": "data(color)", "target-arrow-shape": "vee", "target-arrow-color": "data(color)", opacity: 0.3, "arrow-scale": 0.8 } },
        { selector: "edge.hl", style: { opacity: 1, width: 2.4, label: "data(rel)", "font-size": 10, color: "data(color)", "text-background-color": "#ffffff", "text-background-opacity": 1, "text-background-padding": "2px" } },
        { selector: "edge.primary.hl", style: { "line-color": "#4338ca", "target-arrow-color": "#4338ca", label: "" } },
        { selector: "edge.faded", style: { opacity: 0.06 } },
      ],
    });
    // cytoscape swallows mousedown, so keep keyboard focus on the canvas wrapper after any tap
    cy.on("tapstart", () => box.current?.parentElement?.focus({ preventScroll: true }));
    cy.on("tap", "node", (e) => tapRef.current(e.target.id()));
    cy.on("tap", (e) => e.target === cy && tapRef.current(undefined));
    cy.on("cxttap", "node", (e) => menuRef.current(e.target.id(), e.renderedPosition.x, e.renderedPosition.y));
    cy.on("zoom", () => setZoom(cy.zoom()));
    cyRef.current = cy;
    if (import.meta.env.DEV) (window as unknown as { __cy: Core }).__cy = cy; // prototype checks drive the canvas
    first.current = true;
    return () => cy.destroy();
  }, []);

  // taxi direction follows layout direction
  useEffect(() => {
    cyRef.current?.style().selector("edge.primary").style({ "taxi-direction": dir === "TB" ? "downward" : "rightward" }).update();
  }, [dir]);

  // sync elements (diff by id; a primary parent change = different edge id)
  useEffect(() => {
    const cy = cyRef.current!;
    const ids = new Set(visible.map((n) => n.id));
    const els: ElementDefinition[] = [];
    for (const n of visible) {
      els.push({ group: "nodes", data: { id: n.id, label: `[${KIND_STYLE[n.kind].tag}] ${n.id} · ${n.status}\n${clip(n.title)}`, color: KIND_STYLE[n.kind].hex, shape: SHAPE[n.kind] }, classes: n.status === "폐기" ? "gone" : "" });
      if (n.parentId && ids.has(n.parentId)) els.push({ group: "edges", data: { id: `p:${n.parentId}>${n.id}`, source: n.parentId, target: n.id }, classes: "primary" });
    }
    if (secMode !== "off")
      for (const l of m.data.links) if (ids.has(l.source) && ids.has(l.target)) els.push({ group: "edges", data: { id: l.id, source: l.source, target: l.target, rel: l.rel, color: REL_STYLE[l.rel] }, classes: "secondary" });
    const want = new Set(els.map((e) => e.data.id!));
    cy.batch(() => {
      cy.elements().forEach((el) => void (!want.has(el.id()) && el.remove()));
      for (const e of els) {
        const el = cy.getElementById(e.data.id!);
        if (el.nonempty()) {
          el.data(e.data);
          el.classes(e.classes as string);
        } else {
          const p = e.group === "nodes" ? layout.pos?.get(e.data.id!) ?? (e.data.id && parentPos(cy, m.data.nodes, e.data.id)) : undefined;
          cy.add({ ...e, position: p || undefined });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, m.data.links, secMode]);

  // apply layout positions (animated after the first one)
  useEffect(() => {
    const cy = cyRef.current!;
    if (!layout.pos) return;
    const pos = layout.pos;
    cy.layout({ name: "preset", positions: (n: { id: () => string }) => pos.get(n.id()) ?? { x: 0, y: 0 }, animate: !first.current && cy.nodes().length < 800, animationDuration: 260, fit: false } as never).run();
    if (first.current) cy.fit(undefined, 40);
    first.current = false;
  }, [layout.pos]);
  useEffect(() => {
    first.current = true;
  }, [m.key, dir]);

  // selection / focus / pick classes
  useEffect(() => {
    const cy = cyRef.current!;
    cy.batch(() => {
      cy.elements().removeClass("sel faded hl blocked pickable");
      if (pick) {
        cy.nodes().forEach((n) => void n.addClass(blocked?.has(n.id()) ? "blocked" : "pickable"));
        cy.getElementById(pick.from).removeClass("blocked").addClass("sel");
        return;
      }
      if (!m.selected) return;
      const focus = new Set(pathToRoot(m.data, m.selected));
      for (const k of childrenOf(m.data, m.selected)) focus.add(k.id);
      for (const l of m.data.links) if (l.source === m.selected || l.target === m.selected) focus.add(l.source), focus.add(l.target);
      cy.getElementById(m.selected).addClass("sel");
      cy.nodes().forEach((n) => void (!focus.has(n.id()) && n.addClass("faded")));
      cy.edges().forEach((e) => {
        const s = e.source().id();
        const t = e.target().id();
        if (e.hasClass("primary") ? focus.has(s) && focus.has(t) && (pathToRoot(m.data, m.selected!).includes(t) || s === m.selected) : s === m.selected || t === m.selected) e.addClass("hl");
        else e.addClass("faded");
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.selected, m.data, pick, blocked, visible, secMode]);

  useEffect(() => {
    setPanel(null);
    setMenu(null);
  }, [m.selected]);

  useEffect(() => {
    reportStats({ engine: "flextree (sync) → Cytoscape preset", visible: visible.length, total: m.data.nodes.length, primary: visible.filter((n) => n.parentId).length, secondary: m.data.links.length, layoutMs: layout.ms, layoutRuns: layout.runs, stale: layout.stale, pending: false, dirty: false });
  });
  useEffect(() => () => reportStats(null), []);

  const center = (id: string) => {
    const cy = cyRef.current!;
    const el = cy.getElementById(id);
    if (el.nonempty()) cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 0.85) } as never, { duration: 300 });
  };
  const go = (id?: string) => {
    if (!id) return;
    m.select(id);
    center(id);
  };
  /** search result: in pick mode it is the picked target (off-screen nodes stay reachable), else select */
  const found = (id: string) => (pick ? (center(id), tapRef.current(id)) : go(id));

  /** Tree walk: ↑ parent · ↓ first child · ←/→ siblings · Enter add child · P pick parent · L link · Esc cancel */
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    if (e.key === "/") return e.preventDefault(), search.current?.focus();
    if (e.key === "Escape") return setPick(null), setMenu(null), m.select(undefined);
    const roots = visible.filter((n) => !n.parentId || !visible.some((x) => x.id === n.parentId));
    if (!node) {
      if (e.key.startsWith("Arrow")) e.preventDefault(), go(roots[0]?.id);
      return;
    }
    const sibs = node.parentId && visible.some((x) => x.id === node.parentId) ? childrenOf(m.data, node.parentId).filter((x) => visible.includes(x)) : roots;
    const i = sibs.findIndex((x) => x.id === node.id);
    const map: Record<string, string | undefined> = {
      ArrowUp: node.parentId,
      ArrowDown: childrenOf(m.data, node.id).find((x) => visible.includes(x))?.id,
      ArrowLeft: sibs[(i - 1 + sibs.length) % sibs.length]?.id,
      ArrowRight: sibs[(i + 1) % sibs.length]?.id,
    };
    if (e.key in map) return e.preventDefault(), go(map[e.key]);
    if (e.key === "a") return setPanel("add");
    if (e.key === "p") return setPick({ mode: "parent", from: node.id });
    if (e.key === "l") return setPick({ mode: "link", from: node.id });
  };

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? m.data.nodes.filter((n) => n.id.toLowerCase().includes(s) || n.title.toLowerCase().includes(s)).slice(0, 8) : [];
  }, [q, m.data.nodes]);

  const tb = (on: boolean) => `rounded-lg px-2 py-1 text-xs transition ${on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`;
  const pickFrom = pick && m.data.nodes.find((n) => n.id === pick.from);

  return (
    <div className="flex min-h-[560px] flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <input
            ref={search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) found(hits[0].id), setQ(""), box.current?.parentElement?.focus();
              if (e.key === "Escape") setQ(""), box.current?.parentElement?.focus();
            }}
            placeholder={pick ? "고를 노드 찾기 — Enter로 지정" : `노드 찾기 — ID·제목 (${m.data.nodes.length}개)   /`}
            className="w-full rounded-xl bg-white px-3.5 py-2 text-sm shadow-card ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-brand-400"
            aria-label="노드 찾기"
          />
          {hits.length > 0 && (
            <ul className="animate-pop-in absolute top-full right-0 left-0 z-30 mt-1 rounded-xl bg-white p-1 shadow-pop ring-1 ring-slate-200">
              {hits.map((n) => (
                <li key={n.id}>
                  <button onClick={() => (found(n.id), setQ(""))} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-50">
                    <KindTag kind={n.kind} className="shrink-0" />
                    <span className="shrink-0 text-slate-400">{n.id}</span>
                    <span className={`truncate ${n.status === "폐기" ? "text-slate-400 line-through" : ""}`}>{n.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex rounded-xl bg-white p-0.5 shadow-xs ring-1 ring-slate-200">
          <button className={tb(dir === "TB")} onClick={() => setDir("TB")}>↓</button>
          <button className={tb(dir === "LR")} onClick={() => setDir("LR")}>→</button>
        </div>
        <select value={secMode} onChange={(e) => setSecMode(e.target.value as SecMode)} className="rounded-xl bg-white px-2 py-1.5 text-xs shadow-xs ring-1 ring-slate-200" aria-label="보조 연결 표시">
          {(Object.keys(SEC_LABEL) as SecMode[]).map((k) => <option key={k} value={k}>{SEC_LABEL[k]}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input type="checkbox" checked={hideGone} onChange={(e) => setHideGone(e.target.checked)} /> 폐기 숨김
        </label>
        <button className="btn-soft py-1 text-xs" onClick={() => cyRef.current?.fit(undefined, 40)}>⤢ 전체</button>
        <div className="ml-auto hidden items-center gap-2 text-[11px] text-slate-500 xl:flex">
          {KINDS.map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm border-2" style={{ borderColor: KIND_STYLE[k].hex }} />
              {k}
            </span>
          ))}
        </div>
      </div>

      <div className="card relative min-h-[380px] flex-1 overflow-hidden">
        {pick && pickFrom && (
          <div className="animate-fade-up absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-xs text-white shadow-pop">
            {pick.mode === "parent" ? (
              <>{pickFrom.id}의 새 주 부모를 지도에서 누르거나 찾기(/)로 고르세요 · 흐린 노드(자기·후손)는 순환이라 불가</>
            ) : pick.target ? (
              <>
                {pick.from} → {pick.target} 연결 종류:
                {REL_KINDS.map((r: RelKind) => (
                  <button key={r} className="rounded-lg bg-white/10 px-2 py-0.5 hover:bg-white/25" onClick={() => m.apply(addLink(m.data, pick.from, pick.target!, r)) && setPick(null)}>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: REL_STYLE[r] }} />
                    {r}
                  </button>
                ))}
              </>
            ) : (
              <>{pickFrom.id}에서 보조 연결할 노드를 누르세요</>
            )}
            <button className="rounded-lg px-1.5 hover:bg-white/20" onClick={() => setPick(null)}>
              취소 Esc
            </button>
          </div>
        )}
        {!m.data.nodes.length && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-slate-500">
            <div>
              아직 연구 노드가 없습니다. 초기 연구 승인 뒤 Lead와 작업자가 노드를 만듭니다.
              <div className="mx-auto mt-3 max-w-xs text-left">
                <AddForm m={m} onDone={(id) => m.select(id)} />
              </div>
            </div>
          </div>
        )}
        {/* cytoscape rewrites its container's position, so it gets an inner box */}
        <div tabIndex={0} onKeyDown={onKey} className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-inset" data-map-canvas aria-label="연구 지도 캔버스 — 화살표로 트리 이동, /로 찾기">
          <div ref={box} className="h-full w-full" />
        </div>
        {zoom < 0.45 && <div className="pointer-events-none absolute bottom-2 left-2 rounded-lg bg-white/80 px-2 py-1 text-[11px] text-slate-500">축소 중 — 제목 숨김 · 확대하거나 찾기(/)</div>}
        <div className="pointer-events-none absolute right-2 bottom-2 hidden rounded-lg bg-white/80 px-2 py-1 text-[11px] text-slate-400 md:block">↑부모 ↓하위 ←→형제 · a 추가 · p 주 부모 · l 보조 · 우클릭 메뉴</div>
        {menu && (
          <div className="animate-pop-in absolute z-30 w-44 rounded-xl bg-white p-1 text-xs shadow-pop ring-1 ring-slate-200" style={{ left: Math.min(menu.x, (box.current?.clientWidth ?? 400) - 180), top: menu.y }}>
            {[
              ["＋ 하위 노드", () => setPanel("add")],
              ["주 부모 지정 (지도에서)", () => setPick({ mode: "parent", from: menu.id })],
              ["보조 연결 (지도에서)", () => setPick({ mode: "link", from: menu.id })],
            ].map(([l, f]) => (
              <button key={l as string} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-50" onClick={() => ((f as () => void)(), setMenu(null))}>
                {l as string}
              </button>
            ))}
          </div>
        )}
      </div>

      {node && !pick && (
        <section key={node.id} className="card animate-fade-up grid max-h-[45vh] gap-4 overflow-auto p-4 md:grid-cols-[1fr_1fr_16rem]" aria-label="노드 상세">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <KindTag kind={node.kind} />
              <span className="text-xs text-slate-400">{node.id}</span>
              <button className="btn-ghost ml-auto px-1.5 py-0.5 text-xs md:hidden" onClick={() => m.select(undefined)} aria-label="닫기">✕</button>
            </div>
            <TitleStatusForm key={node.title} m={m} node={node} />
          </div>
          <NodeFacts m={m} node={node} />
          <div className="space-y-1.5">
            <div className="flex">
              <button className="btn-ghost ml-auto hidden px-1.5 py-0.5 text-xs md:block" onClick={() => m.select(undefined)} aria-label="상세 닫기">✕</button>
            </div>
            {panel === "add" ? (
              <AddForm m={m} parent={node} onDone={(id) => (setPanel(null), go(id))} />
            ) : panel === "parent" ? (
              <ParentForm m={m} node={node} onDone={() => setPanel(null)} />
            ) : (
              <>
                <button className="btn-soft w-full text-xs" onClick={() => setPanel("add")}>＋ 하위 노드 <kbd className="text-slate-400">a</kbd></button>
                <div className="flex gap-1">
                  <button className="btn-soft flex-1 text-xs" onClick={() => setPick({ mode: "parent", from: node.id })}>주 부모: 지도에서 <kbd className="text-slate-400">p</kbd></button>
                  <button className="btn-ghost px-2 text-xs" onClick={() => setPanel("parent")} title="목록에서 고르기">목록</button>
                </div>
                <button className="btn-soft w-full text-xs" onClick={() => setPick({ mode: "link", from: node.id })}>보조 연결: 지도에서 <kbd className="text-slate-400">l</kbd></button>
                <DiscardButton m={m} node={node} className="w-full text-xs" />
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function parentPos(cy: Core, nodes: RNode[], id: string) {
  const p = nodes.find((n) => n.id === id)?.parentId;
  const el = p ? cy.getElementById(p) : null;
  return el && el.nonempty() ? { x: el.position("x") + 40, y: el.position("y") + 90 } : undefined;
}
