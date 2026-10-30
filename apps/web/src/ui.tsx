import type {
  Agent,
  AgentStatus,
  ApprovalDecision,
  ApprovalKind,
  ApprovalStatus,
  InboxItemKind,
  LifecycleStage,
  ResearchMapOperation,
  ResearchNodeStatus,
  ResultDecision,
  ResultSubmissionStatus,
  RunCancelReason,
  RunStatus,
  TaskStatus,
} from "@babojubot/contracts";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * 아이콘만 있는 버튼 등의 tooltip. 접근성 이름은 버튼의 `aria-label`이 맡고 tooltip은 보이는 이름이다.
 * 셸의 `Tooltip.Provider` 아래에서 쓴다.
 */
export function Tip({
  children,
  content,
  side = "top",
  tone = "dark",
}: {
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** `speech`는 캐릭터 머리 위 말풍선(흰 바탕, 한 줄). */
  tone?: "dark" | "speech";
}) {
  return (
    <Tooltip.Root disableHoverableContent={tone === "speech"}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={side === "right" ? 10 : 6}
          collisionPadding={8}
          className={
            tone === "speech"
              ? "animate-pop-in z-[80] max-w-56 truncate rounded-2xl bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-pop ring-1 ring-slate-900/10"
              : "animate-pop-in z-[80] max-w-64 rounded-xl bg-slate-900 px-3 py-2 text-xs text-white shadow-pop"
          }
        >
          {content}
          <Tooltip.Arrow
            className={tone === "speech" ? "fill-white" : "fill-slate-900"}
          />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const stageLabel: Record<LifecycleStage, string> = {
  goal_setting: "목표 설정",
  planning: "계획 수립",
  awaiting_approval: "승인 대기",
  researching: "연구 진행",
  paused: "일시정지",
  result_review: "결과 검토 중",
  completed: "최종 완료",
  stopped: "중단됨",
};
/** 좁은 레일에 쓰는 단계 글자. 전체 이름은 tooltip과 badge에 있다. */
export const stageShortLabel: Record<LifecycleStage, string> = {
  ...stageLabel,
  result_review: "결과 검토",
  completed: "완료",
};

const stageStyle: Record<LifecycleStage, [string, string]> = {
  goal_setting: ["bg-sky-50 text-sky-700", "bg-sky-500"],
  planning: ["bg-brand-50 text-brand-700", "bg-brand-500"],
  awaiting_approval: ["bg-amber-50 text-amber-800", "bg-amber-500"],
  researching: ["bg-emerald-50 text-emerald-700", "bg-emerald-500"],
  paused: ["bg-slate-100 text-slate-600", "bg-slate-400"],
  result_review: ["bg-fuchsia-50 text-fuchsia-700", "bg-fuchsia-500"],
  completed: ["bg-slate-50 text-slate-500", "bg-slate-300"],
  stopped: ["bg-rose-50 text-rose-700", "bg-rose-400"],
};

/** 단계는 색만이 아니라 항상 글자로 보인다. */
export function StageBadge({ stage }: { stage: LifecycleStage }) {
  const [c, dot] = stageStyle[stage];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${c}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {stageLabel[stage]}
    </span>
  );
}

export const runStatusLabel: Record<RunStatus, string> = {
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
  server_restart: "서버 재시작",
};
const runStatusStyle: Record<RunStatus, [string, string]> = {
  running: ["bg-brand-50 text-brand-700", "bg-brand-500 animate-pulse"],
  completed: ["bg-emerald-50 text-emerald-700", "bg-emerald-500"],
  failed: ["bg-rose-50 text-rose-700", "bg-rose-500"],
  cancelled: ["bg-slate-100 text-slate-600", "bg-slate-400"],
  server_restart: ["bg-amber-50 text-amber-800", "bg-amber-500"],
};

/** 사용자 제어가 실행 시도를 취소한 사유. 어느 범위의 명령이었는지 이름으로 보인다. */
export const runCancelReasonLabel: Record<RunCancelReason, string> = {
  organization_paused: "조직 일시정지",
  organization_stopped: "조직 중단",
  agent_paused: "에이전트 일시정지",
  owner_interrupt: "실행 중단",
};

/**
 * 실행 시도의 성공은 연구 완료가 아니다. 실행 시도 상태만 보인다.
 * 취소를 요청받고 프로바이더가 정리 중이면 `취소 중`이고, 사용자 제어로 취소됐으면 그 사유를 함께 보인다.
 */
export function RunStatusBadge({
  status,
  cancelReason = null,
}: {
  status: RunStatus;
  cancelReason?: RunCancelReason | null;
}) {
  const cancelling = status === "running" && cancelReason !== null;
  const [c, dot] = cancelling
    ? ["bg-amber-50 text-amber-800", "bg-amber-500 animate-pulse"]
    : runStatusStyle[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${c}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {cancelling ? "취소 중" : runStatusLabel[status]}
      {cancelReason && ` · ${runCancelReasonLabel[cancelReason]}`}
    </span>
  );
}

export const decisionLabel: Record<ApprovalDecision, string> = {
  approve: "승인",
  reject: "반려",
  request_changes: "수정 요청",
};
export const approvalKindLabel: Record<ApprovalKind, string> = {
  initial_research: "초기 연구 승인 요청",
  add_worker: "작업자 추가 승인 요청",
};
export const inboxKindLabel: Record<InboxItemKind, string> = {
  approval: "승인 요청",
  result_submission: "결과 제출",
  run_failure: "실패한 실행 시도",
};
export const approvalStatusLabel: Record<ApprovalStatus, string> = {
  pending: "결정 대기",
  approved: "승인됨",
  rejected: "반려됨",
  changes_requested: "수정 요청됨",
};
const approvalStatusStyle: Record<ApprovalStatus, string> = {
  pending: "bg-amber-50 text-amber-800",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-rose-50 text-rose-700",
  changes_requested: "bg-sky-50 text-sky-700",
};

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${approvalStatusStyle[status]}`}
    >
      {approvalStatusLabel[status]}
    </span>
  );
}

export const resultDecisionLabel: Record<ResultDecision, string> = {
  request_changes: "수정 요청",
  complete: "최종 완료",
};
export const resultStatusLabel: Record<ResultSubmissionStatus, string> = {
  pending: "검토 대기",
  changes_requested: "수정 요청됨",
  completed: "최종 완료",
};
const resultStatusStyle: Record<ResultSubmissionStatus, string> = {
  pending: "bg-amber-50 text-amber-800",
  changes_requested: "bg-sky-50 text-sky-700",
  completed: "bg-emerald-50 text-emerald-700",
};

/** 결과 제출 상태. 검토 대기는 사용자 결정이 필요하다는 뜻이다. */
export function ResultStatusBadge({
  status,
}: {
  status: ResultSubmissionStatus;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${resultStatusStyle[status]}`}
    >
      {resultStatusLabel[status]}
    </span>
  );
}

export const taskStatusLabel: Record<TaskStatus, string> = {
  open: "할당됨",
  in_progress: "진행 중",
  completed: "완료",
};
const taskStatusStyle: Record<TaskStatus, [string, string]> = {
  open: ["bg-slate-100 text-slate-600", "bg-slate-400"],
  in_progress: ["bg-brand-50 text-brand-700", "bg-brand-500"],
  completed: ["bg-emerald-50 text-emerald-700", "bg-emerald-500"],
};

/** 작업 상태. 완료는 담당자의 자기 보고일 뿐 검증된 결과가 아니다. */
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const [c, dot] = taskStatusStyle[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${c}`}
      data-testid="task-status"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {taskStatusLabel[status]}
    </span>
  );
}

export const researchNodeStatusLabel: Record<ResearchNodeStatus, string> = {
  proposed: "제안됨",
  in_progress: "진행 중",
  done: "완료",
  rejected: "기각됨",
  discarded: "폐기",
};

export const mapOperationLabel: Record<ResearchMapOperation, string> = {
  create_node: "노드 추가",
  update_node: "노드 수정",
  assign_parent: "주 부모 지정",
  change_parent: "주 부모 변경",
  add_link: "보조 연결 추가",
  discard_node: "노드 폐기",
  restore_node: "폐기 취소",
  link_task: "작업 연결",
  relink_task: "작업 재연결",
  unlink_task: "작업 연결 해제",
};

export const agentStatusLabel: Record<AgentStatus, string> = {
  idle: "대기",
  running: "실행 중",
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const on = status === "running";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${on ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600"}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${on ? "animate-pulse bg-brand-500" : "bg-slate-400"}`}
      />
      {agentStatusLabel[status]}
    </span>
  );
}

/** 사용자가 에이전트를 일시정지했다. 실행 상태와 따로 보인다. */
export function PausedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">
      <span aria-hidden>⏸</span>
      <span>일시정지</span>
    </span>
  );
}

const timeFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
/** 실행 시도를 짧게 부르는 이름. 전체 ID는 주소에 있다. */
export const formatLabel = { markdown: "Markdown", text: "텍스트" } as const;
export const nameOf = (agents: Agent[], id: string | null) =>
  agents.find((a) => a.id === id)?.name ?? "에이전트";

export const runLabel = (runId: string) => `실행 시도 ${runId.slice(0, 8)}`;

/** 본문 폭 3단계: 좁게 768px, 중간 1024px, 전체 폭. 창이 좁으면 창 폭을 따른다. */
export type Width = "reading" | "standard" | "full";
const widthClass: Record<Width, string> = {
  reading: "max-w-3xl",
  standard: "max-w-5xl",
  full: "max-w-none",
};

/** `fill`이면 본문 높이를 창에 맞추고 스크롤은 화면 안쪽이 맡는다(대화처럼 입력창이 아래에 붙는 화면). */
export function Page({
  width,
  children,
  className = "",
  fill = false,
}: {
  width: Width;
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  return (
    <div
      data-fill-height={fill || undefined}
      className={`mx-auto w-full px-4 sm:px-6 ${fill ? "flex min-h-0 flex-1 flex-col pt-5 pb-3" : "py-5"} ${widthClass[width]} ${className}`}
    >
      {children}
    </div>
  );
}

export const abbr = (name: string) => [...name].slice(0, 2).join("");
export const hue = (id: string) =>
  [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
export const avatarStyle = (id: string) => {
  const h = hue(id);
  return {
    background: `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 40) % 360} 65% 48%))`,
  };
};

/** 불러오는 중·오류는 빈 상태나 숫자 0으로 보이지 않는다. */
export function Loading() {
  return (
    <div className="space-y-2 p-4" aria-busy>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-xl bg-slate-200/70"
        />
      ))}
    </div>
  );
}

export function LoadError({
  what,
  onRetry,
}: {
  what: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="animate-fade-up m-4 rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200"
    >
      {what}을 불러오지 못했습니다.{" "}
      <button
        className="font-semibold underline underline-offset-2"
        onClick={onRetry}
      >
        다시 시도
      </button>
    </div>
  );
}

export function NotFound({ what }: { what: string }) {
  return (
    <div className="card animate-fade-up m-4 max-w-lg p-6 text-sm">
      <div className="font-semibold">찾을 수 없는 {what}</div>
      <Link to="/" className="btn-soft mt-4">
        홈으로
      </Link>
    </div>
  );
}
