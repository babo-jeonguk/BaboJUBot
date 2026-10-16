// PROTOTYPE (#51) — throwaway in-memory map store. One map per (org, fixture) so edits survive a
// variant switch: the same state can be judged in A/B/C. Reload wipes everything.
import { useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";
import type { Org, Stage } from "../data";
import { useStore } from "../shared";
import { generateMap, seedMap, type EditResult, type MapData } from "./data";

export type LogItem = { at: string; by: string; label: string };
type Entry = { data: MapData; log: LogItem[] };

const cache = new Map<string, Entry>();
let ver = 0;
const subs = new Set<() => void>();
const emit = () => {
  ver++;
  subs.forEach((f) => f());
};
const sub = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export const FIXTURES = ["seed", "50", "200", "500"] as const;
export const DENSITIES = ["0", "20", "100"] as const;

const preApproval = (s: Stage) => s === "목표 설정" || s === "계획 수립" || s === "승인 대기";

export function useFixture() {
  const [sp] = useSearchParams();
  const raw = sp.get("n");
  const fx = FIXTURES.includes(raw as never) ? (raw as (typeof FIXTURES)[number]) : "seed";
  const s = sp.get("sec");
  const sec = DENSITIES.includes(s as never) ? Number(s) : 20;
  return { fx, sec };
}

export function useResearchMap(org: Org) {
  const [sp, setSp] = useSearchParams();
  const { notify } = useStore();
  const { fx, sec } = useFixture();
  useSyncExternalStore(sub, () => ver);
  const key = `${org.id}|${fx}|${fx === "seed" ? "" : sec}`;
  if (!cache.has(key)) {
    const data = fx === "seed" ? (preApproval(org.stage) ? { nodes: [], links: [] } : seedMap()) : generateMap(Number(fx), sec);
    cache.set(key, { data, log: [] });
  }
  const e = cache.get(key)!;
  const fail = sp.get("fail") === "1";

  /** Simulated "server" write. ?fail=1 → rejected, nothing changes (V03: 실패 시 원래 상태 유지). */
  const apply = (r: EditResult): boolean => {
    if (!r.ok) {
      notify(`거부: ${r.reason}`, "error");
      return false;
    }
    if (fail) {
      notify("서버가 편집을 거부했습니다 · 원래 상태를 유지합니다 (?fail=1)", "error");
      return false;
    }
    e.data = r.data;
    e.log = [{ at: new Date().toLocaleTimeString("ko-KR"), by: "사용자", label: r.label }, ...e.log];
    emit();
    notify(`${r.label} · 편집자 기록 · Lead 깨우기 (stub)`);
    return true;
  };

  const selected = sp.get("node") ?? undefined;
  const select = (id?: string) => {
    if (id === selected) return;
    const n = new URLSearchParams(sp);
    if (id) n.set("node", id);
    else n.delete("node");
    setSp(n, { replace: true });
  };

  return { org, key, data: e.data, log: e.log, apply, selected, select, fx, sec };
}
export type MapApi = ReturnType<typeof useResearchMap>;

// ---------- stats the floating bar shows (surface the state) ----------

export type MapStats = {
  engine: string;
  visible: number;
  total: number;
  primary: number;
  secondary: number;
  layoutMs?: number;
  layoutRuns: number;
  stale: number;
  pending: boolean;
  dirty: boolean;
  pinned?: number;
};
let stats: MapStats | null = null;
const statSubs = new Set<() => void>();
export function reportStats(s: MapStats | null) {
  stats = s;
  statSubs.forEach((f) => f());
}
export function useMapStats() {
  return useSyncExternalStore(
    (f) => {
      statSubs.add(f);
      return () => void statSubs.delete(f);
    },
    () => stats,
  );
}
