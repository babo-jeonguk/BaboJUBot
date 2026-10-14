// PROTOTYPE (#50) — throwaway mock data. In-memory only; no server, DB, or model calls.

export const STAGES = [
  "목표 설정",
  "계획 수립",
  "승인 대기",
  "연구 진행",
  "일시정지",
  "결과 검토 중",
  "최종 완료",
  "중단됨",
] as const;
export type Stage = (typeof STAGES)[number];

export const ORG_TABS = [
  { slug: "dashboard", label: "대시보드" },
  { slug: "chat", label: "Lead 대화" },
  { slug: "activity", label: "활동" },
  { slug: "tasks", label: "작업" },
  { slug: "map", label: "연구 지도" },
  { slug: "agents", label: "에이전트" },
  { slug: "review", label: "결과 검토" },
  { slug: "settings", label: "설정" },
] as const;
export type OrgTab = (typeof ORG_TABS)[number]["slug"];

export type Agent = { id: string; name: string; role: string; status: "실행 중" | "대기" | "일시정지"; heartbeat: string };
export type Task = { id: string; title: string; status: "할 일" | "진행 중" | "완료" | "막힘"; assignee: string; node?: string };
export type Run = {
  id: string;
  agent: string;
  status: "실행 중" | "성공" | "실패" | "취소";
  wake: string;
  started: string;
  summary: string;
};
export type Activity = { id: string; at: string; agent: string; text: string; runId?: string };
export type ChatMsg = { from: "사용자" | "Lead"; text: string; at: string };

export type Org = {
  id: string;
  name: string;
  goal: string;
  stage: Stage;
  agents: Agent[];
  tasks: Task[];
  runs: Run[];
  activity: Activity[];
  chat: ChatMsg[];
  daily: number[]; // 14일 실행 시도 수
  artifacts: number;
  lastActivity: string;
};

export type InboxKind = "초기 연구 승인" | "작업자 추가 승인" | "결과 제출" | "실패한 실행 시도";
export type Decision =
  | "미결"
  | "전송 중"
  | "전송 실패"
  | "승인됨"
  | "반려됨"
  | "수정 요청됨"
  | "최종 완료"
  | "해당 없음";
export type InboxItem = {
  id: string;
  orgId: string;
  kind: InboxKind;
  title: string;
  reason: string;
  from: string;
  at: string;
  read: boolean;
  archived: boolean;
  decision: Decision;
  runId?: string;
};

const runs = (orgId: string, liveCount: number, extra: Run[] = []): Run[] => [
  ...Array.from({ length: liveCount }, (_, i) => ({
    id: `${orgId}-r${120 + i}`,
    agent: i === 0 ? "Research Lead" : `작업자 ${i}`,
    status: "실행 중" as const,
    wake: i === 0 ? "하위 작업 완료" : "작업 할당",
    started: `${3 + i}분 전`,
    summary: "진행 중…",
  })),
  ...extra,
];

function org(
  id: string,
  name: string,
  stage: Stage,
  live: number,
  over: Partial<Org> = {},
): Org {
  const agents: Agent[] =
    stage === "목표 설정" || stage === "계획 수립" || stage === "승인 대기"
      ? [{ id: "lead", name: "Research Lead", role: "Lead", status: live > 0 ? "실행 중" : "대기", heartbeat: "꺼짐" }]
      : [
          { id: "lead", name: "Research Lead", role: "Lead", status: live > 0 ? "실행 중" : "대기", heartbeat: "30분" },
          { id: "w1", name: "데이터 수집가", role: "조사", status: live > 1 ? "실행 중" : "대기", heartbeat: "꺼짐" },
          { id: "w2", name: "평가 설계자", role: "검증", status: "대기", heartbeat: "꺼짐" },
          { id: "w3", name: "종합 작성자", role: "종합", status: stage === "일시정지" ? "일시정지" : "대기", heartbeat: "꺼짐" },
        ];
  return {
    id,
    name,
    goal: `${name}의 연구 목표 (mock)`,
    stage,
    agents,
    tasks: [],
    runs: runs(id, live),
    activity: [
      { id: "a1", at: "2분 전", agent: "Research Lead", text: "작업 '평가셋 후보 조사' 생성 → 데이터 수집가에게 할당" },
      { id: "a2", at: "9분 전", agent: "데이터 수집가", text: "산출물 'candidates.csv' 기록", runId: `${id}-r108` },
      { id: "a3", at: "14분 전", agent: "사용자", text: "Lead 대화에 메시지: 우선 공개 데이터만 써 주세요" },
      { id: "a4", at: "1시간 전", agent: "시스템", text: `조직 단계 변경 → ${stage}` },
    ],
    chat: [
      { from: "사용자", text: "연구 목표를 같이 정리해 봅시다.", at: "어제" },
      { from: "Lead", text: "완료 기준 초안: 공개 벤치마크 3종 이상, 재현 스크립트 포함.", at: "어제" },
    ],
    daily: Array.from({ length: 14 }, (_, i) => ((i * 7 + id.length * 3) % 9) + (i > 9 ? live * 2 : 0)),
    artifacts: (id.length * 5) % 23,
    lastActivity: "2분 전",
    ...over,
  };
}

function normalOrgs(): Org[] {
  const llm = org("llm-eval", "한국어 LLM 평가 벤치마크 구축", "연구 진행", 2, {
    tasks: [
      { id: "T-12", title: "평가셋 후보 조사", status: "진행 중", assignee: "데이터 수집가", node: "H2" },
      { id: "T-13", title: "채점 프롬프트 비교 실험", status: "할 일", assignee: "평가 설계자", node: "E1" },
      { id: "T-11", title: "기존 벤치마크 라이선스 정리", status: "완료", assignee: "데이터 수집가" },
      { id: "T-10", title: "GPU 계정 준비 대기", status: "막힘", assignee: "Research Lead" },
    ],
  });
  llm.runs.push(
    { id: "llm-eval-r108", agent: "데이터 수집가", status: "실패", wake: "작업 할당", started: "40분 전", summary: "timeout: 외부 사이트 응답 없음" },
    { id: "llm-eval-r112", agent: "데이터 수집가", status: "성공", wake: "재시도", started: "20분 전", summary: "후보 14개 수집" },
  );
  return [
    llm,
    org("protein", "단백질 구조 예측 문헌 조사", "계획 수립", 1),
    org(
      "boardgame-rl",
      "보드게임 강화학습 에이전트 — 자기대국 기반 정책 개선과 평가 자동화 파이프라인",
      "승인 대기",
      0,
    ),
    org("receipt-ocr", "영수증 OCR 오류 분석", "결과 검토 중", 0),
    org("power-forecast", "전력 수요 예측 모델 비교", "일시정지", 0),
    org("speech-emotion", "새 연구: 음성 감정 인식", "목표 설정", 0),
    org("recsys-ab", "추천 시스템 A/B 실험 재분석", "최종 완료", 0, { lastActivity: "3일 전" }),
  ];
}

export type Scenario = "normal" | "many" | "one" | "empty" | "loading" | "error";
export const SCENARIOS: Scenario[] = ["normal", "many", "one", "empty", "loading", "error"];

export function buildOrgs(s: Scenario): Org[] {
  if (s === "empty" || s === "loading" || s === "error") return [];
  const base = normalOrgs();
  if (s === "one") return [base[0]];
  if (s === "many") {
    const names = ["소형 비전 모델 증류", "논문 재현: 희소 어텐션", "의료 영상 라벨 품질", "기후 데이터 이상 탐지", "코드 생성 평가 자동화", "교통량 시뮬레이션 보정"];
    const st: Stage[] = ["연구 진행", "연구 진행", "승인 대기", "중단됨", "계획 수립", "최종 완료"];
    return [...base, ...names.map((n, i) => org(`extra-${i}`, n, st[i], i < 2 ? 1 : 0))];
  }
  return base;
}

export function buildInbox(orgs: Org[]): InboxItem[] {
  const has = (id: string) => orgs.some((o) => o.id === id);
  const items: InboxItem[] = [
    { id: "i1", orgId: "boardgame-rl", kind: "초기 연구 승인", title: "초기 연구 계획·팀·연구 환경 명세", reason: "연구 시작 전 사용자 결정 필요", from: "Research Lead", at: "12분 전", read: false, archived: false, decision: "미결" },
    { id: "i2", orgId: "receipt-ocr", kind: "결과 제출", title: "OCR 오류 유형 보고서 v1", reason: "완료 기준 충족 판단 — 최종 완료 검토 요청", from: "Research Lead", at: "1시간 전", read: false, archived: false, decision: "미결" },
    { id: "i3", orgId: "llm-eval", kind: "실패한 실행 시도", title: "데이터 수집가 실행 시도 실패 (timeout)", reason: "이후 재시도 r112는 성공 — 원 실패 기록은 유지", from: "시스템", at: "40분 전", read: false, archived: false, decision: "해당 없음", runId: "llm-eval-r108" },
    { id: "i4", orgId: "llm-eval", kind: "작업자 추가 승인", title: "작업자 '통계 검토자' 추가", reason: "승인 정책 '작업자 추가'가 켜져 있음", from: "Research Lead", at: "2시간 전", read: true, archived: false, decision: "미결" },
    { id: "i5", orgId: "llm-eval", kind: "작업자 추가 승인", title: "작업자 '데이터 수집가' 추가", reason: "승인 정책 '작업자 추가'", from: "Research Lead", at: "어제", read: true, archived: false, decision: "승인됨" },
    { id: "i6", orgId: "protein", kind: "실패한 실행 시도", title: "Research Lead 실행 시도 실패 (adapter 오류)", reason: "가짜 실행기 시나리오 오류", from: "시스템", at: "어제", read: true, archived: true, decision: "해당 없음", runId: "protein-r090" },
  ];
  return items.filter((i) => has(i.orgId));
}

export const needsAttention = (i: InboxItem) =>
  !i.archived && (i.decision === "미결" || i.decision === "전송 실패" || (i.kind === "실패한 실행 시도" && !i.read));
// "작업 중" 정의는 #61 소유. 프로토타입에서는 결정 전송 중인 항목으로 둔다.
export const inProgress = (i: InboxItem) => !i.archived && i.decision === "전송 중";
