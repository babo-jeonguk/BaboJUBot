// 홈(에이전트 로비)의 배치 규칙. 조직 하나가 방 하나이고, 에이전트마다 들어온 순서로 정한 고정 자리가 있다.
// 상태는 자리를 바꾸지 않고 캐릭터가 방 안 어디에 어떤 모습으로 있는지로 보인다(docs/research/home-references.md 결정).
import {
  inboxOrganizationId,
  isClosedStage,
  needsAttention,
  type InboxItem,
  type Overview,
  type OverviewAgent,
  type OverviewOrganization,
  type PendingDecisionKind,
  type WakeKind,
} from "@babojubot/contracts";
import type { FaceMood } from "./agent-face.tsx";
import { stageLabel } from "./ui.tsx";

/** 방 분위기: 일하는 방, 일시정지한 방(모두 졸음), 끝난 방(불 꺼진 작은 방). */
export type RoomMode = "active" | "paused" | "closed";
export const roomModeOf = (org: Pick<OverviewOrganization, "stage">) =>
  isClosedStage(org.stage)
    ? "closed"
    : org.stage === "paused"
      ? "paused"
      : "active";

/**
 * 방 순서와 구역. 끝나지 않은 방은 조직을 만든 순서(오래된 것이 먼저)라 새 조직은 맨 뒤에 붙고, 주의·실행 상태가
 * 바뀌어도 방이 움직이지 않는다. 끝난 조직만 아래 접힌 구역으로 한 번 옮겨 간다.
 * 주의 수는 레일·Inbox와 같은 판정(`needsAttention`)이다.
 */
export function arrangeHome(overview: Overview, inbox: InboxItem[]) {
  const attentionOf = new Map<string, number>();
  for (const item of inbox)
    if (needsAttention(item)) {
      const id = inboxOrganizationId(item);
      attentionOf.set(id, (attentionOf.get(id) ?? 0) + 1);
    }
  const rooms = [...overview.organizations]
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.organizationId.localeCompare(b.organizationId)
    )
    .map((org) => ({
      org,
      attention: attentionOf.get(org.organizationId) ?? 0,
    }));
  return {
    open: rooms.filter((r) => !isClosedStage(r.org.stage)),
    closed: rooms.filter((r) => isClosedStage(r.org.stage)),
    totalAttention: [...attentionOf.values()].reduce((n, c) => n + c, 0),
  };
}
export type HomeRoom = ReturnType<typeof arrangeHome>["open"][number];

/**
 * 반 폭 방에 들어가는 최대 인원(Lead 포함). 이보다 많으면 한 줄 전체를 쓰고, 더 많아지면 줄을 늘려 아래로 자란다.
 * 1440px 화면의 반 폭 방에 Lead와 작업자 다섯이 한 줄로 들어가는지 홈 E2E가 확인한다.
 */
export const halfRoomMaxAgents = 6;
export const isWideRoom = (
  org: Pick<OverviewOrganization, "agents" | "stage">
) => !isClosedStage(org.stage) && org.agents.length > halfRoomMaxAgents;

/** 작업자 책상 열 수. 한 줄에 여섯까지, 넘으면 줄마다 고르게 나눈다(9명 → 5 + 4). */
export const columnsOf = (workers: number) =>
  workers <= 0 ? 0 : Math.ceil(workers / Math.ceil(workers / 6));

const decisionLabel: Record<PendingDecisionKind, string> = {
  initial_research: "계획 승인",
  add_worker: "작업자 추가 승인",
  result_submission: "결과 검토",
};
/** Lead 머리 위 물음표 말풍선. 가장 오래 기다린 결정 하나와 나머지 수. */
export function decisionBubble(
  org: Pick<OverviewOrganization, "pendingDecisions">
) {
  const [first, ...rest] = org.pendingDecisions;
  if (!first) return null;
  const label = decisionLabel[first.kind];
  return rest.length ? `${label} 외 ${rest.length}` : label;
}

const wakeDoing: Record<WakeKind, string> = {
  owner_message: "사용자 메시지 읽는 중",
  approval_decision: "결정 내용 반영 중",
  task_assigned: "맡은 작업 시작하는 중",
  task_completed: "작업 결과 확인 중",
  task_comment: "댓글 확인 중",
  agent_to_agent_message: "동료 메시지 읽는 중",
  research_map_edit: "연구 지도 변경 확인 중",
  instruction_edit: "지침 변경 확인 중",
  result_changes_requested: "결과 고치는 중",
  organization_created: "연구 계획 세우는 중",
  heartbeat: "정기 점검 중",
};

/** 캐릭터의 자세. `away`는 자리에 없음(라운지에 있거나 끝난 조직). */
export type Pose = "seated" | "standing" | "doze" | "away";
/** 책상 모니터: 흐르는 글(작업 중), 문서(결정 기다림), 빨간 ✕(실패), 꺼짐. */
export type Screen = "code" | "doc" | "error" | "off";

export type Place = {
  /** 라운지 소파에서 쉬는 중이면 참. 책상은 이름표와 빈 의자만 남는다. */
  lounge: boolean;
  pose: Pose;
  screen: Screen;
  mood: FaceMood;
  /** 상태 이름. 접근 이름 `이름 · 상태`와 hover 말풍선에 쓴다. */
  state: string;
  /** hover·keyboard focus 때 머리 위 말풍선. 작업 중이면 하는 일이다. */
  saying: string;
  /** 늘 떠 있는 물음표 말풍선(Lead가 사용자 결정을 기다릴 때만). */
  asking: string | null;
};

/**
 * 에이전트가 방 안 어디에 어떤 모습으로 있는지. 앞의 규칙이 이긴다.
 * 끝난 조직 → 모두 퇴근, 결정을 기다리는 Lead → 일어서서 물음표, 일시정지(조직·에이전트) → 책상에서 졸음,
 * 실행 중 → 앉아서 작업, 마지막 실행 실패 → 걱정하는 얼굴과 빨간 화면, 그 밖 → 라운지 소파에서 쉼.
 */
export function placeOf(
  agent: OverviewAgent,
  org: Pick<OverviewOrganization, "stage" | "pendingDecisions">
): Place {
  const mode = roomModeOf(org);
  const at = (
    pose: Pose,
    screen: Screen,
    mood: FaceMood,
    state: string,
    rest: Partial<Place> = {}
  ): Place => ({
    lounge: false,
    pose,
    screen,
    mood,
    state,
    saying: state,
    asking: null,
    ...rest,
  });
  if (mode === "closed")
    return at("away", "off", "idle", stageLabel[org.stage]);
  const asking = agent.role === "lead" ? decisionBubble(org) : null;
  if (asking)
    return at("standing", "doc", "idle", `${asking} 기다림`, { asking });
  if (mode === "paused" || agent.paused)
    return at("doze", "off", "sleepy", "일시정지");
  if (agent.status === "running")
    return at("seated", "code", "working", "작업 중", {
      saying:
        agent.currentTask ??
        (agent.wakeKind ? wakeDoing[agent.wakeKind] : "작업 중"),
    });
  if (agent.lastRunFailed)
    return at("seated", "error", "worried", "마지막 실행 실패");
  return at("away", "off", "idle", "쉬는 중", { lounge: true });
}

/** 방 머리의 `작업 중 N`. 실행 중인 에이전트 수다. */
export const workingCount = (org: Pick<OverviewOrganization, "agents">) =>
  org.agents.filter((a) => a.status === "running").length;

const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
const dateOnly = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
});
/** 방금 · N분 전 · N시간 전 · 어제 · N일 전, 일주일이 넘으면 날짜. */
export function relativeTime(iso: string, now: number) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return relative.format(-days, "day");
  return dateOnly.format(new Date(iso));
}
