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

/** 판 1 조직 화면 (A/B 1차 변형이 쓰는 평면 목록). */
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

/** C의 세로 섹션 목록. `later` 항목은 이후 판 화면으로, 판 1 구현에는 나오지 않는다. */
export type Section = { slug: string; label: string; later?: string };
export const SECTION_GROUPS: { label?: string; items: Section[] }[] = [
  {
    items: [
      { slug: "dashboard", label: "대시보드" },
      { slug: "chat", label: "Lead 대화" },
    ],
  },
  {
    label: "연구",
    items: [
      { slug: "tasks", label: "작업" },
      { slug: "map", label: "연구 지도" },
      { slug: "review", label: "결과 검토" },
      { slug: "artifacts", label: "산출물", later: "목록, 문서 revision, 갤러리. 판 1에는 단건 보기만 있고 작업·결과 검토·노드 패널에서 연결합니다." },
      { slug: "memory", label: "기억·명시적 공유", later: "기억 이슈에서 내용을 정합니다." },
    ],
  },
  {
    label: "팀과 실행",
    items: [
      { slug: "agents", label: "에이전트" },
      { slug: "activity", label: "활동" },
      { slug: "jobs", label: "외부 job", later: "상태·로그·비용, 이 job만 중지." },
      { slug: "routines", label: "정기 작업", later: "일정, 실행 이력, Test run." },
    ],
  },
  {
    label: "운영",
    items: [
      { slug: "costs", label: "비용·예산", later: "agent·모델별 비용, 추정치와 실제 청구 분리, 예산 정책·incident." },
      { slug: "audit", label: "감사·Timeline", later: "제어 명령을 포함한 모든 변경 feed, 외부 job 구간을 포함한 Gantt." },
      { slug: "settings", label: "설정" },
    ],
  },
];
export const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.items);

// ---------- Role·Soul·Skill: 에이전트마다 따로 둔 사본 ----------

export type InstrRev = { n: number; by: string; at: string; text: string };
export type InstrDoc = { key: string; kind: "Role" | "Soul" | "Skill"; file: string; title: string; revs: InstrRev[] };

const ROLE_TEXT: Record<string, string> = {
  Lead: `# Research Lead

연구 조직의 계획·작업 분담·조정과 사용자 소통을 맡는다.

## 할 일
- 사용자와 연구 목표·완료 기준을 합의한다
- 작업을 나누어 작업자에게 맡긴다
- 하위 작업 완료 보고를 검토하고 다음 행동을 정한다

## 하지 않는 일
- 최종 완료를 스스로 선언하지 않는다`,
  조사: `# 조사

맡은 작업의 자료를 찾아 정리하고 출처를 남긴다.

## 입력
- 작업 설명, 연결된 연구 노드

## 출력
- 산출물(표·메모)과 자기 보고 요약`,
  검증: `# 검증

가설을 확인할 검증 방법을 설계하고 실험을 수행한다.

## 출력
- 실험 설정, 지표, 결과 산출물`,
  종합: `# 종합

여러 작업의 결과를 모아 보고서 초안을 쓴다. 근거 산출물을 반드시 연결한다.`,
};
const soulText = (name: string) => `# ${name}

- 근거가 약하면 약하다고 쓴다
- 모르면 추측하지 말고 묻는다
- 짧고 정확하게 보고한다`;
const SKILL_TEXT = `---
name: 연구 노드 기록
description: 조사·실험 결과를 연구 지도의 노드로 남긴다
---

1. 결과가 어느 가설·검증 방법에 속하는지 찾는다
2. 노드를 만들고 주 부모를 지정한다
3. 근거 산출물을 노드에 연결한다`;

function instr(name: string, role: string, at: string): InstrDoc[] {
  const r1 = (text: string): InstrRev[] => [{ n: 1, by: "하네스 라이브러리에서 복사", at, text }];
  return [
    { key: "role", kind: "Role", file: "AGENTS.md", title: role, revs: r1(ROLE_TEXT[role]) },
    { key: "soul", kind: "Soul", file: "SOUL.md", title: name, revs: r1(soulText(name)) },
    ...(role === "Lead"
      ? []
      : [{ key: "skill-node", kind: "Skill" as const, file: "skills/연구-노드-기록/SKILL.md", title: "연구 노드 기록", revs: r1(SKILL_TEXT) }]),
  ];
}

export type Agent = {
  id: string;
  name: string;
  role: string;
  status: "실행 중" | "대기" | "일시정지";
  hb: { on: boolean; every: string };
  docs: InstrDoc[];
};
export type Comment = { from: string; text: string; at: string };
export type Task = {
  id: string;
  title: string;
  status: "할 일" | "진행 중" | "완료" | "막힘";
  assignee: string;
  createdBy: string;
  node?: string;
  summary?: string;
  comments: Comment[];
};
export type Artifact = { id: string; name: string; by: string; taskId?: string; runId?: string; at: string; content: string };
export type Run = {
  id: string;
  agent: string;
  status: "실행 중" | "성공" | "실패" | "취소";
  wake: string;
  started: string;
  summary: string;
};
export type Activity = { id: string; at: string; agent: string; text: string; runId?: string; artifactId?: string };
export type ChatMsg = { from: "사용자" | "Lead"; text: string; at: string };

export type Org = {
  id: string;
  name: string;
  goal: string;
  stage: Stage;
  agents: Agent[];
  tasks: Task[];
  artifacts: Artifact[];
  runs: Run[];
  activity: Activity[];
  chat: ChatMsg[];
  daily: number[]; // 14일 실행 시도 수
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

const preApproval = (s: Stage) => s === "목표 설정" || s === "계획 수립" || s === "승인 대기";

export function makeOrg(id: string, name: string, stage: Stage, live: number, over: Partial<Org> = {}): Org {
  const agent = (aid: string, n: string, role: string, i: number, hb = false): Agent => ({
    id: aid,
    name: n,
    role,
    status: stage === "일시정지" ? "일시정지" : live > i ? "실행 중" : "대기",
    hb: { on: hb, every: "30분" },
    docs: instr(n, role, aid === "lead" ? "조직 생성 때" : "초기 연구 승인 때"),
  });
  const agents: Agent[] = preApproval(stage)
    ? [agent("lead", "Research Lead", "Lead", 0)]
    : [
        agent("lead", "Research Lead", "Lead", 0, true),
        agent("w1", "데이터 수집가", "조사", 1),
        agent("w4", "문헌 조사자", "조사", 9),
        agent("w2", "평가 설계자", "검증", 9),
        agent("w3", "종합 작성자", "종합", 9),
      ];
  return {
    id,
    name,
    goal: `${name}의 연구 목표 (mock)`,
    stage,
    agents,
    tasks: [],
    artifacts: [],
    runs: Array.from({ length: live }, (_, i) => ({
      id: `${id}-r${120 + i}`,
      agent: agents[i]?.name ?? "Research Lead",
      status: "실행 중" as const,
      wake: i === 0 ? "하위 작업 완료" : "작업 할당",
      started: `${3 + i}분 전`,
      summary: "진행 중…",
    })),
    activity: [
      { id: "a1", at: "2분 전", agent: "Research Lead", text: "작업 '평가셋 후보 조사' 생성 → 데이터 수집가에게 할당" },
      { id: "a2", at: "9분 전", agent: "데이터 수집가", text: "산출물 'candidates.csv' 기록", runId: `${id}-r112`, artifactId: "A-1" },
      { id: "a3", at: "14분 전", agent: "사용자", text: "Lead 대화에 메시지: 우선 공개 데이터만 써 주세요" },
      { id: "a4", at: "1시간 전", agent: "시스템", text: `조직 단계 변경 → ${stage}` },
    ],
    chat: [
      { from: "사용자", text: "연구 목표를 같이 정리해 봅시다.", at: "어제" },
      { from: "Lead", text: "완료 기준 초안: 공개 벤치마크 3종 이상, 재현 스크립트 포함.", at: "어제" },
    ],
    daily: Array.from({ length: 14 }, (_, i) => ((i * 7 + id.length * 3) % 9) + (i > 9 ? live * 2 : 0)),
    lastActivity: "2분 전",
    ...over,
  };
}

/** 대시보드에서 새로 만든 조직: 목표 설정 단계, Lead 하나, 기록 없음. */
export function newOrg(id: string, name: string): Org {
  return makeOrg(id, name, "목표 설정", 0, {
    goal: "아직 정하지 않음 — Lead 대화에서 합의합니다",
    activity: [{ id: "a1", at: "방금", agent: "시스템", text: "조직 생성 · Research Lead 생성 · 단계 목표 설정" }],
    chat: [],
    daily: Array(14).fill(0),
    lastActivity: "방금",
  });
}

function normalOrgs(): Org[] {
  const llm = makeOrg("llm-eval", "한국어 LLM 평가 벤치마크 구축", "연구 진행", 2, {
    tasks: [
      {
        id: "T-12",
        title: "평가셋 후보 조사",
        status: "진행 중",
        assignee: "데이터 수집가",
        createdBy: "Research Lead",
        node: "H2",
        comments: [
          { from: "Research Lead", text: "라이선스가 불분명한 셋은 후보 표에 따로 표시해 주세요.", at: "30분 전" },
          { from: "데이터 수집가", text: "확인했습니다. '라이선스' 열을 추가했습니다.", at: "20분 전" },
        ],
      },
      { id: "T-13", title: "채점 프롬프트 비교 실험", status: "할 일", assignee: "평가 설계자", createdBy: "Research Lead", node: "E1", comments: [] },
      {
        id: "T-11",
        title: "기존 벤치마크 라이선스 정리",
        status: "완료",
        assignee: "문헌 조사자",
        createdBy: "Research Lead",
        summary: "공개 벤치마크 9종의 라이선스를 정리했습니다. 상업 사용 불가 3종은 평가셋 후보에서 뺐습니다. (자기 보고)",
        comments: [],
      },
      { id: "T-10", title: "GPU 계정 준비 대기", status: "막힘", assignee: "Research Lead", createdBy: "Research Lead", comments: [] },
    ],
    artifacts: [
      {
        id: "A-1",
        name: "candidates.csv",
        by: "데이터 수집가",
        taskId: "T-12",
        runId: "llm-eval-r112",
        at: "9분 전",
        content: "이름,문항 수,출처,라이선스\nKoBEST,5 tasks,공개,CC BY-SA\nKLUE,8 tasks,공개,CC BY-SA\nKMMLU,35k,공개,CC BY-ND\nHAE-RAE,1.5k,공개,확인 필요",
      },
      {
        id: "A-2",
        name: "license-notes.md",
        by: "문헌 조사자",
        taskId: "T-11",
        at: "어제",
        content: "# 라이선스 정리\n\n- 9종 검토, 상업 사용 불가 3종 제외\n- ND 라이선스는 변형 금지 — 번역본 생성 불가\n- 출처 링크는 각 행 참조",
      },
    ],
  });
  llm.agents[1].docs[0].revs.push({
    n: 2,
    by: "사용자",
    at: "어제",
    text: `${llm.agents[1].docs[0].revs[0].text}\n\n## 제약\n- 공개 데이터만 사용한다`,
  });
  llm.runs.push(
    { id: "llm-eval-r108", agent: "데이터 수집가", status: "실패", wake: "작업 할당", started: "40분 전", summary: "timeout: 외부 사이트 응답 없음" },
    { id: "llm-eval-r112", agent: "데이터 수집가", status: "성공", wake: "재시도", started: "20분 전", summary: "후보 14개 수집" },
    { id: "llm-eval-r104", agent: "문헌 조사자", status: "성공", wake: "작업 할당", started: "어제", summary: "라이선스 9종 정리" },
  );
  const ocr = makeOrg("receipt-ocr", "영수증 OCR 오류 분석", "결과 검토 중", 0, {
    artifacts: [
      { id: "A-1", name: "report-v1.md", by: "종합 작성자", at: "1시간 전", content: "# OCR 오류 유형 보고서 v1\n\n## 요약\n오류의 62%가 저해상도 금액 칸에서 나온다.\n\n## 근거\n- error-taxonomy.csv\n- 재현 스크립트: scripts/repro.py" },
      { id: "A-2", name: "error-taxonomy.csv", by: "데이터 수집가", at: "2시간 전", content: "유형,비율\n금액 숫자 혼동,0.41\n날짜 형식,0.21\n상호명 잘림,0.18\n기타,0.20" },
    ],
  });
  return [
    llm,
    makeOrg("protein", "단백질 구조 예측 문헌 조사", "계획 수립", 1),
    makeOrg("boardgame-rl", "보드게임 강화학습 에이전트 — 자기대국 기반 정책 개선과 평가 자동화 파이프라인", "승인 대기", 0),
    ocr,
    makeOrg("power-forecast", "전력 수요 예측 모델 비교", "일시정지", 0),
    makeOrg("speech-emotion", "새 연구: 음성 감정 인식", "목표 설정", 0),
    makeOrg("recsys-ab", "추천 시스템 A/B 실험 재분석", "최종 완료", 0, { lastActivity: "3일 전" }),
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
    return [...base, ...names.map((n, i) => makeOrg(`extra-${i}`, n, st[i], i < 2 ? 1 : 0))];
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
