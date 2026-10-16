// PROTOTYPE (#50, #51) — throwaway floating variant switcher. Dev builds only.
// On 조직 › 연구 지도 the arrows switch ?map= (research map variants) instead of the shell ?variant=.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { SCENARIOS } from "./data";
import { MAP_VARIANTS } from "./map/ResearchMap";
import { DENSITIES, FIXTURES, useMapStats } from "./map/store";
import { tabLabel, useRouteInfo, useStore, WIDTH_LABEL, widthFor } from "./shared";

type V = { key: string; name: string };

export function PrototypeSwitcher({ variants, current }: { variants: V[]; current: string }) {
  const [sp, setSp] = useSearchParams();
  const { scenario, orgById, inbox, status } = useStore();
  const r = useRouteInfo();
  const onMap = !!r.orgId && r.tab === "map" && !r.itemId;
  const stats = useMapStats();
  const mapKey = MAP_VARIANTS.find((x) => x.key === sp.get("map"))?.key ?? "A";
  const list = onMap ? MAP_VARIANTS : variants;
  const cur = onMap ? mapKey : current;
  const param = onMap ? "map" : "variant";
  const i = list.findIndex((v) => v.key === cur);

  const set = (k: string, val: string | null) => {
    const n = new URLSearchParams(sp);
    if (val === null) n.delete(k);
    else n.set(k, val);
    setSp(n, { replace: true });
  };
  const go = (d: number) => set(param, list[(i + d + list.length) % list.length].key);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable], [role=tablist], [role=menu], [data-map-canvas], .react-flow")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const org = orgById(r.orgId);
  const scope = r.orgId
    ? `조직 ${org ? org.name : `${r.orgId} (없음)`} › ${r.runId ? `실행 시도 ${r.runId}` : `${tabLabel(r.tab)}${r.itemId ? ` › ${r.itemId}` : ""}${r.sub ? ` › ${r.sub}` : ""}`}`
    : r.global === "home"
      ? "전역 › 홈"
      : r.global === "inbox"
        ? `전역 › Inbox${r.inboxId ? ` › ${r.inboxId}` : ""}`
        : r.global === "settings"
          ? "전역 › 설정"
          : r.pathname;
  const item = inbox.find((x) => x.id === r.inboxId);

  return (
    <div className="fixed bottom-3 left-1/2 z-[100] flex max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-2xl bg-black/85 backdrop-blur px-3 py-2 text-xs text-white shadow-2xl ring-2 ring-fuchsia-500">
      <span className="rounded bg-fuchsia-500 px-1.5 font-bold">PROTOTYPE</span>
      <button aria-label="이전 배치" className="rounded px-2 hover:bg-white/20" onClick={() => go(-1)}>
        ◀
      </button>
      <span className="min-w-40 text-center font-semibold">
        {onMap && "지도 "}
        {cur} ({list[i].name})
      </span>
      <button aria-label="다음 배치" className="rounded px-2 hover:bg-white/20" onClick={() => go(1)}>
        ▶
      </button>
      {onMap && (
        <>
          <label className="flex items-center gap-1 border-l border-white/30 pl-2">
            노드
            <select className="rounded bg-white/10 px-1" value={sp.get("n") ?? "seed"} onChange={(e) => set("n", e.target.value === "seed" ? null : e.target.value)}>
              {FIXTURES.map((s) => (
                <option key={s} className="text-black">
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            보조%
            <select className="rounded bg-white/10 px-1" value={sp.get("sec") ?? "20"} onChange={(e) => set("sec", e.target.value === "20" ? null : e.target.value)} disabled={!sp.get("n")} title="seed 자료는 고정 보조 연결">
              {DENSITIES.map((s) => (
                <option key={s} className="text-black">
                  {s}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="flex items-center gap-1 border-l border-white/30 pl-2">
        자료
        <select className="rounded bg-white/10 px-1" value={scenario} onChange={(e) => set("data", e.target.value === "normal" ? null : e.target.value)}>
          {SCENARIOS.map((s) => (
            <option key={s} className="text-black">
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={sp.get("fail") === "1"} onChange={(e) => set("fail", e.target.checked ? "1" : null)} />
        결정 실패
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={sp.get("later") !== "0"} onChange={(e) => set("later", e.target.checked ? null : "0")} />
        이후 판 메뉴
      </label>
      <span className="max-w-[28rem] truncate border-l border-white/30 pl-2 text-white/80" title={scope}>
        범위: {scope} · 폭: {WIDTH_LABEL[widthFor(r)]}
        {item && ` · 읽음=${item.read} 보관=${item.archived} 결정=${item.decision}`}
        {status !== "ok" && ` · status=${status}`}
      </span>
      {onMap && stats && (
        <span className="border-l border-white/30 pl-2 font-mono text-[11px] text-emerald-300">
          {stats.engine} · 노드 {stats.visible}/{stats.total} · 주 {stats.primary} · 보조 {stats.secondary} · 배치 {stats.layoutMs?.toFixed(1) ?? "–"}ms ×{stats.layoutRuns}
          {stats.pending && " · 계산 중"}
          {stats.dirty && " · 구조 바뀜(재배치 대기)"}
          {stats.stale > 0 && ` · 버린 늦은 결과 ${stats.stale}`}
          {!!stats.pinned && ` · 직접 옮긴 노드 ${stats.pinned}`}
          {sp.get("node") && ` · 선택 ${sp.get("node")}`}
        </span>
      )}
    </div>
  );
}
