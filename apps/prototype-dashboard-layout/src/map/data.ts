// PROTOTYPE (#51) — throwaway. In-memory research map fixtures + edit ops shared by all three map variants.
// Domain shape: each node has at most one primary parent (parentId); secondary links are separate records
// with their own IDs, so two relations between the same endpoints never collapse (research D03).
// The guards here are UX feedback only. The real rules live on the server (#56).

export const KINDS = ["문제", "가설", "검증 방법", "실험", "결과"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ["제안됨", "진행 중", "완료", "기각됨", "폐기"] as const;
export type Status = (typeof STATUSES)[number];
export const REL_KINDS = ["지지", "반박", "참고"] as const;
export type RelKind = (typeof REL_KINDS)[number];

export type RNode = { id: string; kind: Kind; title: string; status: Status; parentId?: string; prevStatus?: Status; by: string };
export type SLink = { id: string; source: string; target: string; rel: RelKind };
export type MapData = { nodes: RNode[]; links: SLink[] };

/** Not colour-only: every kind also has a short text tag and its own shape in the canvas variant. */
export const KIND_STYLE: Record<Kind, { tag: string; bg: string; fg: string; ring: string; hex: string; shape: string }> = {
  문제: { tag: "문제", bg: "bg-rose-50", fg: "text-rose-700", ring: "ring-rose-200", hex: "#e11d48", shape: "round-rectangle" },
  가설: { tag: "가설", bg: "bg-amber-50", fg: "text-amber-800", ring: "ring-amber-200", hex: "#d97706", shape: "round-diamond" },
  "검증 방법": { tag: "방법", bg: "bg-sky-50", fg: "text-sky-700", ring: "ring-sky-200", hex: "#0284c7", shape: "round-hexagon" },
  실험: { tag: "실험", bg: "bg-brand-50", fg: "text-brand-700", ring: "ring-brand-200", hex: "#5048e5", shape: "round-rectangle" },
  결과: { tag: "결과", bg: "bg-emerald-50", fg: "text-emerald-700", ring: "ring-emerald-200", hex: "#059669", shape: "round-tag" },
};
export const REL_STYLE: Record<RelKind, string> = { 지지: "#059669", 반박: "#e11d48", 참고: "#64748b" };

export const NODE_W = 232;
export const NODE_H = 76;

// ---------- fixtures ----------

/** Hand-written seed for the llm-eval org: 2 roots + 1 parentless node, long Korean titles, a 폐기 node,
 * a secondary cycle (H4⇄M3), and two different relations between the same endpoints (R1→H2 지지/참고). */
export function seedMap(): MapData {
  const n = (id: string, kind: Kind, title: string, status: Status, parentId?: string): RNode => ({ id, kind, title, status, parentId, by: "Research Lead" });
  return {
    nodes: [
      n("P1", "문제", "한국어 LLM 평가에 쓸 공개 벤치마크가 부족하고 라이선스가 제각각이다", "진행 중"),
      n("H1", "가설", "기존 영어 벤치마크를 번역하면 모델 순위 비교에 충분하다", "기각됨", "P1"),
      n("M1", "검증 방법", "번역셋과 원어민 작성셋에서 모델 순위 상관(Kendall τ)을 비교한다", "완료", "H1"),
      n("E2", "실험", "공개 모델 7종 × 2개 셋 순위 상관 측정", "완료", "M1"),
      n("R1", "결과", "τ=0.41 — 번역셋 순위가 원어민 셋과 크게 다르다", "완료", "E2"),
      n("H2", "가설", "원어민이 작성한 문항이 있어야 문화·어휘 편향을 잡는다", "진행 중", "P1"),
      n("M2", "검증 방법", "원어민 작성 문항 300개 표본으로 편향 유형을 분류한다", "제안됨", "H2"),
      n("M3", "검증 방법", "LLM 채점자와 사람 채점의 일치도를 측정한다", "진행 중", "H2"),
      n("E1", "실험", "채점 프롬프트 비교 실험 — 루브릭 vs 쌍대 비교", "제안됨", "M3"),
      n("H3", "가설", "자동 생성 문항만으로 규모를 키울 수 있다", "폐기", "P1"),
      n("P2", "문제", "채점 비용이 평가 대상 모델 수에 비례해 늘어난다", "제안됨"),
      n("H4", "가설", "작은 채점 모델로 증류해도 사람 일치도를 유지한다", "제안됨", "P2"),
      n("M4", "검증 방법", "채점 모델 크기별 사람 일치도 곡선을 그린다", "제안됨", "H4"),
      n("H5", "가설", "문항 난이도 보정이 상위권 순위를 바꾼다 (주 부모 미정)", "제안됨"),
    ],
    links: [
      { id: "s1", source: "R1", target: "H1", rel: "반박" },
      { id: "s2", source: "R1", target: "H2", rel: "지지" },
      { id: "s3", source: "R1", target: "H2", rel: "참고" },
      { id: "s4", source: "M3", target: "H4", rel: "참고" },
      { id: "s5", source: "H4", target: "M3", rel: "참고" },
      { id: "s6", source: "E2", target: "M2", rel: "참고" },
      { id: "s7", source: "P2", target: "E1", rel: "참고" },
    ],
  };
}

const TOPICS = ["번역 품질", "채점 일치도", "문항 난이도", "라이선스", "토크나이저", "문화 편향", "긴 문맥", "추론 단계", "데이터 오염", "비용", "재현성", "프롬프트 형식"];
const TAILS = [
  "",
  " — 공개 셋 3종에서 다시 확인",
  " (지난 반복 결과와 비교 필요)",
  "를 모델 크기·학습 데이터 출처별로 나눠 다시 측정하고, 상위권 순위 변화가 통계적으로 유의한지 본다",
];
const STEM: Record<Kind, (t: string) => string> = {
  문제: (t) => `${t} 때문에 평가 결과를 믿기 어렵다`,
  가설: (t) => `${t}이(가) 모델 순위를 바꾼다`,
  "검증 방법": (t) => `${t} 통제 전후 순위 상관 비교`,
  실험: (t) => `${t} 변형 셋으로 7개 모델 실행`,
  결과: (t) => `${t} 효과 관찰: τ 변화 0.${(t.length * 7) % 90}`,
};

/** Seeded forest of n nodes, 3 roots, ~3% parentless, ~5% 폐기, secondary links = sec% of n. */
export function generateMap(n: number, sec: number, seed = 51): MapData {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const nodes: RNode[] = [];
  const depth = new Map<string, number>();
  const attachable: RNode[] = []; // roots + nodes already in a tree (parentless strays never get children)
  for (let i = 0; i < n; i++) {
    const id = `N${i + 1}`;
    let parentId: string | undefined;
    if (i >= 3 && rnd() > 0.03) {
      // prefer recent tree nodes so trees grow deep-ish instead of one flat fan; cap depth at 6
      const k = attachable.length;
      const lo = Math.max(0, Math.floor(k * (0.3 + rnd() * 0.6)) - 6);
      let cand = attachable[lo + Math.floor(rnd() * (k - lo))];
      while (depth.get(cand.id)! >= 6) cand = attachable[Math.floor(rnd() * k)];
      parentId = cand.id;
    }
    const d = parentId ? depth.get(parentId)! + 1 : 0;
    depth.set(id, d);
    const kind = KINDS[Math.min(d, 4)];
    const r = rnd();
    const status: Status = r < 0.05 ? "폐기" : r < 0.15 ? "기각됨" : r < 0.45 ? "완료" : r < 0.7 ? "진행 중" : "제안됨";
    const node: RNode = { id, kind, title: `${STEM[kind](pick(TOPICS))}${pick(TAILS)}`, status, parentId, by: rnd() > 0.85 ? "사용자" : pick(["Research Lead", "데이터 수집가", "평가 설계자"]) };
    nodes.push(node);
    if (parentId || i < 3) attachable.push(node);
  }
  const links: SLink[] = [];
  const m = Math.round((n * sec) / 100);
  for (let i = 0; i < m; i++) {
    const a = pick(nodes).id;
    let b = pick(nodes).id;
    if (b === a) b = nodes[(nodes.findIndex((x) => x.id === a) + 1) % n].id;
    links.push({ id: `s${i + 1}`, source: a, target: b, rel: pick(REL_KINDS) });
  }
  return { nodes, links };
}

// ---------- queries ----------

export function childrenOf(d: MapData, id: string) {
  return d.nodes.filter((x) => x.parentId === id);
}
export function descendants(d: MapData, id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const x of d.nodes) if (x.parentId) kids.set(x.parentId, [...(kids.get(x.parentId) ?? []), x.id]);
  const out = new Set<string>();
  const st = [id];
  while (st.length) for (const c of kids.get(st.pop()!) ?? []) if (!out.has(c)) out.add(c), st.push(c);
  return out;
}
export function pathToRoot(d: MapData, id: string): string[] {
  const by = new Map(d.nodes.map((x) => [x.id, x]));
  const out: string[] = [];
  for (let c = by.get(id); c && !out.includes(c.id); c = c.parentId ? by.get(c.parentId) : undefined) out.push(c.id);
  return out;
}
/** Candidates for a new primary parent: everything except self and own descendants (would make a cycle). */
export function parentCandidates(d: MapData, id: string) {
  const bad = descendants(d, id);
  return d.nodes.filter((x) => x.id !== id && !bad.has(x.id));
}

// ---------- edits ----------
// Each returns either the new map or a rejection reason. The caller records the editor + "Lead 깨우기 (stub)".

export type EditResult = { ok: true; data: MapData; label: string; touched: string } | { ok: false; reason: string };

let nextId = 1;
export function addNode(d: MapData, kind: Kind, title: string, parentId?: string): EditResult {
  const id = `U${nextId++}`;
  return {
    ok: true,
    data: { ...d, nodes: [...d.nodes, { id, kind, title: title.trim() || "제목 없음", status: "제안됨", parentId, by: "사용자" }] },
    label: `노드 추가 ${id}${parentId ? ` (주 부모 ${parentId})` : " (주 부모 없음)"}`,
    touched: id,
  };
}

export function patchNode(d: MapData, id: string, p: Partial<Pick<RNode, "title" | "status" | "kind">>): EditResult {
  const old = d.nodes.find((x) => x.id === id);
  if (!old) return { ok: false, reason: "노드를 찾을 수 없음" };
  const what = Object.keys(p).map((k) => ({ title: "제목", status: "상태", kind: "종류" })[k]).join("·");
  return { ok: true, data: { ...d, nodes: d.nodes.map((x) => (x.id === id ? { ...x, ...p } : x)) }, label: `${id} ${what} 수정`, touched: id };
}

export function setParent(d: MapData, id: string, parentId: string | undefined): EditResult {
  if (parentId === id) return { ok: false, reason: "자기 자신을 주 부모로 지정할 수 없습니다" };
  if (parentId && descendants(d, id).has(parentId)) return { ok: false, reason: `${parentId}는 ${id}의 후손입니다 · 주 연결 순환은 허용하지 않습니다` };
  const old = d.nodes.find((x) => x.id === id)?.parentId;
  if (old === parentId) return { ok: false, reason: "이미 그 주 부모입니다" };
  return {
    ok: true,
    data: { ...d, nodes: d.nodes.map((x) => (x.id === id ? { ...x, parentId } : x)) },
    label: `${id} 주 부모 ${old ?? "없음"} → ${parentId ?? "없음"}`,
    touched: id,
  };
}

let nextLink = 1;
export function addLink(d: MapData, source: string, target: string, rel: RelKind): EditResult {
  // 같은 endpoint 중복·self-link 정책은 #56 결정 전. 프로토타입은 self-link만 거부하고 다른 종류의 중복은 둔다.
  if (source === target) return { ok: false, reason: "자기 자신과의 보조 연결 (정책 미정 #56 · 프로토타입은 거부)" };
  const id = `us${nextLink++}`;
  return { ok: true, data: { ...d, links: [...d.links, { id, source, target, rel }] }, label: `보조 연결 ${source} ─${rel}→ ${target} (${id})`, touched: source };
}

/** 삭제 대신 폐기: 상태만 바꾸고 노드·주 연결·보조 연결·작업 참조를 그대로 둔다. */
export function discard(d: MapData, id: string): EditResult {
  const x = d.nodes.find((n) => n.id === id);
  if (!x) return { ok: false, reason: "노드를 찾을 수 없음" };
  if (x.status === "폐기") return { ok: false, reason: "이미 폐기됨" };
  return { ok: true, data: { ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, status: "폐기", prevStatus: n.status } : n)) }, label: `${id} 폐기 (기록·연결 보존)`, touched: id };
}
export function restore(d: MapData, id: string): EditResult {
  const x = d.nodes.find((n) => n.id === id);
  if (!x || x.status !== "폐기") return { ok: false, reason: "폐기된 노드가 아님" };
  return { ok: true, data: { ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, status: n.prevStatus ?? "제안됨", prevStatus: undefined } : n)) }, label: `${id} 폐기 취소`, touched: id };
}

/** Structural signature of the layout input: primary links + visible node set only. Secondary links and
 * title/status edits deliberately do not change it, so they never trigger a relayout (research D02/D06). */
export function layoutKey(nodes: RNode[], dir: string) {
  return dir + "|" + nodes.map((x) => `${x.id}<${x.parentId ?? ""}`).join(",");
}
