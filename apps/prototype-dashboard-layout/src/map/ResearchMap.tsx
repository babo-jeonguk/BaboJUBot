// PROTOTYPE (#51) — throwaway. Research map variants on the existing 조직 › 연구 지도 route of the #50 shell,
// switchable via ?map=A|B|C (floating bar ◀ ▶ while on this route). Fixture: ?n=seed|50|200|500, ?sec=0|20|100.
// Question: which renderer + layout engine + edit interaction should #56 build on?
import "@xyflow/react/dist/style.css";
import { useSearchParams } from "react-router";
import type { Org } from "../data";
import { useResearchMap } from "./store";
import { MapA } from "./VariantA";
import { MapB } from "./VariantB";
import { MapC } from "./VariantC";

export const MAP_VARIANTS = [
  { key: "A", name: "React Flow + Dagre · 상세 패널·폼" },
  { key: "B", name: "React Flow + ELK · 캔버스 직접 조작" },
  { key: "C", name: "Cytoscape + flextree · 찾기·지도에서 고르기" },
];

export function ResearchMap({ org }: { org: Org }) {
  const [sp] = useSearchParams();
  const m = useResearchMap(org);
  const v = MAP_VARIANTS.find((x) => x.key === sp.get("map"))?.key ?? "A";
  // key: remount per variant + fixture so each variant starts with its own fresh viewport/layout
  const k = `${v}|${m.key}`;
  return v === "B" ? <MapB key={k} m={m} /> : v === "C" ? <MapC key={k} m={m} /> : <MapA key={k} m={m} />;
}
