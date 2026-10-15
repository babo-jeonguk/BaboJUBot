// PROTOTYPE (#51) — throwaway small pieces shared by the map variants (facts + edit forms).
// Layout, placement and the primary affordance stay inside each variant.
import { useMemo, useState } from "react";
import { L } from "../shared";
import {
  addLink,
  addNode,
  childrenOf,
  discard,
  KIND_STYLE,
  KINDS,
  parentCandidates,
  patchNode,
  REL_KINDS,
  REL_STYLE,
  restore,
  setParent,
  STATUSES,
  type Kind,
  type RelKind,
  type RNode,
} from "./data";
import type { MapApi } from "./store";

export function KindTag({ kind, className = "" }: { kind: Kind; className?: string }) {
  const s = KIND_STYLE[kind];
  return <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${s.bg} ${s.fg} ${s.ring} ${className}`}>{s.tag}</span>;
}
export function StatusText({ status }: { status: RNode["status"] }) {
  const tone = status === "폐기" ? "text-slate-400 line-through" : status === "기각됨" ? "text-rose-600" : status === "완료" ? "text-emerald-600" : status === "진행 중" ? "text-brand-600" : "text-slate-500";
  return <span className={`text-[11px] font-medium ${tone}`}>{status}</span>;
}

export const nextKind = (k?: Kind): Kind => (k ? KINDS[Math.min(KINDS.indexOf(k) + 1, 4)] : "문제");

export function tasksFor(m: MapApi, id: string) {
  const ts = m.org.tasks.filter((t) => t.node === id);
  return ts.map((t) => ({ t, arts: m.org.artifacts.filter((a) => a.taskId === t.id) }));
}

/** Read-only facts: parent, children, secondary links in/out (each relation by its own ID), tasks/artifacts. */
export function NodeFacts({ m, node, compact }: { m: MapApi; node: RNode; compact?: boolean }) {
  const by = useMemo(() => new Map(m.data.nodes.map((x) => [x.id, x])), [m.data]);
  const parent = node.parentId ? by.get(node.parentId) : undefined;
  const kids = childrenOf(m.data, node.id);
  const out = m.data.links.filter((l) => l.source === node.id);
  const inn = m.data.links.filter((l) => l.target === node.id);
  const tasks = tasksFor(m, node.id);
  const Ref = ({ id }: { id: string }) => {
    const x = by.get(id);
    return (
      <button onClick={() => m.select(id)} className="max-w-full truncate text-left text-brand-600 hover:underline" title={x?.title}>
        {id} {x && <span className={x.status === "폐기" ? "text-slate-400 line-through" : "text-slate-600"}>{x.title}</span>}
      </button>
    );
  };
  const row = "grid grid-cols-[4.5rem_1fr] gap-2 text-xs";
  return (
    <div className="space-y-2.5 text-sm">
      <div className={row}>
        <span className="text-slate-400">주 부모</span>
        {parent ? <Ref id={parent.id} /> : <span className="text-slate-400">없음 (최상위)</span>}
      </div>
      {!compact && (
        <div className={row}>
          <span className="text-slate-400">하위 {kids.length}</span>
          <div className="min-w-0 space-y-0.5">{kids.length ? kids.slice(0, 6).map((k) => <Ref key={k.id} id={k.id} />) : <span className="text-slate-400">없음</span>}{kids.length > 6 && <div className="text-slate-400">외 {kids.length - 6}개</div>}</div>
        </div>
      )}
      <div className={row}>
        <span className="text-slate-400">보조 {out.length + inn.length}</span>
        <div className="min-w-0 space-y-0.5">
          {!out.length && !inn.length && <span className="text-slate-400">없음</span>}
          {out.map((l) => (
            <div key={l.id} className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 font-medium" style={{ color: REL_STYLE[l.rel] }}>
                ─{l.rel}→
              </span>
              <Ref id={l.target} />
              <span className="shrink-0 text-[10px] text-slate-300">{l.id}</span>
            </div>
          ))}
          {inn.map((l) => (
            <div key={l.id} className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 font-medium" style={{ color: REL_STYLE[l.rel] }}>
                ←{l.rel}─
              </span>
              <Ref id={l.source} />
              <span className="shrink-0 text-[10px] text-slate-300">{l.id}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={row}>
        <span className="text-slate-400">연결 작업</span>
        <div className="min-w-0 space-y-0.5">
          {!tasks.length && <span className="text-slate-400">없음</span>}
          {tasks.map(({ t, arts }) => (
            <div key={t.id}>
              <L to={`/orgs/${m.org.id}/tasks/${t.id}`} className="font-medium text-brand-600 hover:underline">
                {t.id} {t.title} →
              </L>
              {arts.map((a) => (
                <L key={a.id} to={`/orgs/${m.org.id}/artifacts/${a.id}`} className="block text-brand-600 hover:underline">
                  📄 {a.name}
                </L>
              ))}
            </div>
          ))}
        </div>
      </div>
      {!compact && (
        <div className={row}>
          <span className="text-slate-400">만든 이</span>
          <span className="text-slate-600">{node.by}</span>
        </div>
      )}
    </div>
  );
}

/** Searchable node picker. Big maps (500) make a plain <select> unusable, so it filters by id/title. */
export function NodePicker({ nodes, value, onChange, placeholder, allowNone, autoFocus }: { nodes: RNode[]; value?: string; onChange: (id?: string) => void; placeholder: string; allowNone?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const xs = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? nodes.filter((n) => n.id.toLowerCase().includes(s) || n.title.toLowerCase().includes(s)) : nodes).slice(0, 40);
  }, [nodes, q]);
  return (
    <div className="rounded-xl ring-1 ring-slate-200">
      <input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="w-full rounded-t-xl border-b border-slate-100 px-2.5 py-1.5 text-sm outline-none focus:bg-brand-50/40" />
      <ul className="scrollbar-thin max-h-44 overflow-auto p-1 text-xs" role="listbox">
        {allowNone && (
          <li>
            <button role="option" aria-selected={value === undefined} onClick={() => onChange(undefined)} className={`w-full rounded-lg px-2 py-1 text-left ${value === undefined ? "bg-brand-50 font-medium" : "hover:bg-slate-50"}`}>
              {allowNone}
            </button>
          </li>
        )}
        {xs.map((n) => (
          <li key={n.id}>
            <button role="option" aria-selected={value === n.id} onClick={() => onChange(n.id)} className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left ${value === n.id ? "bg-brand-50 font-medium" : "hover:bg-slate-50"}`}>
              <KindTag kind={n.kind} className="shrink-0 !px-1 !py-0 !text-[10px]" />
              <span className="shrink-0 text-slate-400">{n.id}</span>
              <span className={`truncate ${n.status === "폐기" ? "text-slate-400 line-through" : ""}`}>{n.title}</span>
            </button>
          </li>
        ))}
        {!xs.length && <li className="px-2 py-1 text-slate-400">일치하는 노드 없음</li>}
        {nodes.length > 40 && xs.length === 40 && <li className="px-2 py-1 text-slate-400">… 검색어로 좁히세요 ({nodes.length}개)</li>}
      </ul>
    </div>
  );
}

export function ParentForm({ m, node, onDone }: { m: MapApi; node: RNode; onDone?: () => void }) {
  const cands = useMemo(() => parentCandidates(m.data, node.id), [m.data, node.id]);
  const [v, setV] = useState<string | undefined>(node.parentId);
  const blocked = m.data.nodes.length - 1 - cands.length;
  return (
    <div className="space-y-2">
      <NodePicker nodes={cands} value={v} onChange={setV} placeholder="새 주 부모 검색 (ID·제목)" allowNone="주 부모 없음 (최상위로)" />
      <p className="text-[11px] text-slate-400">자기 자신과 후손 {blocked}개는 순환이 되므로 목록에서 뺐습니다.</p>
      <button className="btn-primary w-full" disabled={v === node.parentId} onClick={() => m.apply(setParent(m.data, node.id, v)) && onDone?.()}>
        주 부모를 {v ?? "없음"}(으)로 변경
      </button>
    </div>
  );
}

export function LinkForm({ m, node, target: t0, onDone }: { m: MapApi; node: RNode; target?: string; onDone?: () => void }) {
  const [t, setT] = useState<string | undefined>(t0);
  const [rel, setRel] = useState<RelKind>("참고");
  const [rev, setRev] = useState(false);
  const others = useMemo(() => m.data.nodes.filter((x) => x.id !== node.id), [m.data, node.id]);
  const [a, b] = rev ? [t, node.id] : [node.id, t];
  return (
    <div className="space-y-2">
      {!t0 && <NodePicker nodes={others} value={t} onChange={setT} placeholder="연결할 노드 검색" />}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {REL_KINDS.map((r) => (
          <button key={r} onClick={() => setRel(r)} className={`chip ${rel === r ? "bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}>
            <span className="h-2 w-2 rounded-full" style={{ background: REL_STYLE[r] }} />
            {r}
          </button>
        ))}
        <button onClick={() => setRev(!rev)} className="chip ml-auto bg-white ring-1 ring-slate-200" title="방향 바꾸기">
          ⇄ 방향
        </button>
      </div>
      <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
        {a ?? "?"} ─{rel}→ {b ?? "?"} <span className="text-slate-400">· 주 배치는 바뀌지 않습니다</span>
      </div>
      <button className="btn-primary w-full" disabled={!t} onClick={() => t && m.apply(addLink(m.data, a!, b!, rel)) && onDone?.()}>
        보조 연결 추가
      </button>
    </div>
  );
}

export function AddForm({ m, parent, onDone }: { m: MapApi; parent?: RNode; onDone?: (id: string) => void }) {
  const [kind, setKind] = useState<Kind>(nextKind(parent?.kind));
  const [title, setTitle] = useState("");
  const submit = () => {
    const r = addNode(m.data, kind, title, parent?.id);
    if (m.apply(r) && r.ok) onDone?.(r.touched);
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="text-xs text-slate-500">{parent ? `${parent.id} 아래에 추가` : "최상위(주 부모 없음)에 추가"}</div>
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button type="button" key={k} onClick={() => setKind(k)} className={`chip ${kind === k ? "bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}>
            {k}
          </button>
        ))}
      </div>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목" className="w-full rounded-xl px-2.5 py-1.5 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400" />
      <button className="btn-primary w-full">노드 추가</button>
    </form>
  );
}

export function TitleStatusForm({ m, node }: { m: MapApi; node: RNode }) {
  const [title, setTitle] = useState(node.title);
  return (
    <div className="space-y-2">
      <textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={2} className="w-full resize-none rounded-xl px-2.5 py-1.5 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400" />
      <div className="flex items-center gap-2">
        <select
          value={node.status}
          onChange={(e) => m.apply(patchNode(m.data, node.id, { status: e.target.value as RNode["status"] }))}
          className="rounded-lg bg-white px-2 py-1 text-xs ring-1 ring-slate-200"
          aria-label="상태"
        >
          {STATUSES.filter((s) => s !== "폐기" || node.status === "폐기").map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button className="btn-soft ml-auto py-1 text-xs" disabled={title.trim() === node.title || !title.trim()} onClick={() => m.apply(patchNode(m.data, node.id, { title: title.trim() }))}>
          제목 저장
        </button>
      </div>
    </div>
  );
}

/** 폐기 is a status change with a confirm step, never a library delete (research D05). */
export function DiscardButton({ m, node, className = "" }: { m: MapApi; node: RNode; className?: string }) {
  const [ask, setAsk] = useState(false);
  if (node.status === "폐기")
    return (
      <button className={`btn-soft ${className}`} onClick={() => m.apply(restore(m.data, node.id))}>
        폐기 취소
      </button>
    );
  if (!ask)
    return (
      <button className={`btn-danger ${className}`} onClick={() => setAsk(true)}>
        폐기…
      </button>
    );
  const t = tasksFor(m, node.id).length;
  const l = m.data.links.filter((x) => x.source === node.id || x.target === node.id).length;
  const k = childrenOf(m.data, node.id).length;
  return (
    <div className={`space-y-2 rounded-xl bg-rose-50 p-2.5 text-xs text-rose-800 ring-1 ring-rose-200 ${className}`}>
      <div>
        <b>{node.id}</b>를 폐기합니다. 기록은 지우지 않습니다: 하위 {k}개의 주 연결, 보조 연결 {l}개, 연결 작업 {t}개가 그대로 남습니다.
      </div>
      <div className="flex gap-1.5">
        <button className="btn-soft py-1 text-xs" onClick={() => setAsk(false)} autoFocus>
          취소
        </button>
        <button className="btn bg-rose-600 py-1 text-xs text-white hover:bg-rose-700" onClick={() => m.apply(discard(m.data, node.id)) && setAsk(false)}>
          폐기
        </button>
      </div>
    </div>
  );
}

// ---------- view filters shared by all variants (the policy is the open question, not the code) ----------

export type SecMode = "all" | "focus" | "off";
export const SEC_LABEL: Record<SecMode, string> = { all: "보조 전체(연하게)", focus: "보조: 선택 주변만", off: "보조 숨김" };
