import { z } from "zod";
import { agentAppearanceSchema } from "./agent-profile.ts";
import { approvalKinds } from "./approval.ts";
import { eventSchema } from "./event.ts";
import { agentRoleSchema, lifecycleStageSchema } from "./organization.ts";
import {
  agentStatusSchema,
  runEndReasonSchema,
  runStatusSchema,
  runSummarySchema,
  type RunEndReason,
  type WakeKind,
} from "./run.ts";
import { taskStatusSchema } from "./task.ts";

/** 대시보드 차트의 날짜 수. 오늘(지금까지의 부분일)을 포함한다. */
export const dashboardDays = 14;
/** 조직 대시보드의 최근 활동 수. 전체는 조직 › 활동에서 본다. */
export const dashboardRecentEventLimit = 10;

/**
 * 날짜를 자를 IANA 시간대 이름(`Asia/Seoul`). 대시보드는 브라우저의 시간대를 보낸다.
 * 모양만 확인하며, 서버가 아는 이름인지는 DB가 확인한다(POSIX 표기 `UTC+9`처럼 부호가 뒤집히는 값은 받지 않는다).
 */
export const timeZoneSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/);

const count = z.number().int().nonnegative();

/** 하루치 집계. 날짜는 응답의 시간대로 자른 달력 날짜다. */
export const dashboardDaySchema = z.object({
  date: z.iso.date(),
  /** 이날 시작한 실행 시도의 지금 상태별 수. */
  runsStarted: z.record(runStatusSchema, count),
  /** 이날 끝난 실행 시도의 종료 상태별 수. 성공률은 이 수로 낸다. */
  runsFinished: z.record(runEndReasonSchema, count),
  /** 이날 만든 작업의 지금 상태별 수(생성일별 현재 상태). 그날의 과거 상태가 아니다. */
  tasksCreated: z.record(taskStatusSchema, count),
  /** 이날 기록한 산출물 수. */
  artifactsRecorded: count,
});
export type DashboardDay = z.infer<typeof dashboardDaySchema>;

/**
 * 조직 대시보드 요약. 한 읽기 snapshot에서 만들어 수·목록이 서로 맞는다.
 * 수는 모두 이 조직의 기록만 센다.
 */
export const organizationDashboardSchema = z.object({
  organizationId: z.uuid(),
  /** 기준 시각. 오늘 bucket은 이 시각까지다. */
  asOf: z.iso.datetime({ offset: true }),
  timeZone: z.string(),
  /**
   * 오늘이 끝나는 시각(이 시간대의 다음 자정, 서버의 시간대 자료로 계산). 이때부터 14일이 하루 밀린다.
   * 화면은 `asOf`부터 이 시각까지 기다렸다 다시 불러온다(브라우저 시계·시간대와 무관).
   */
  nextDayAt: z.iso.datetime({ offset: true }),
  /** 작업 상태별 수. */
  tasks: z.record(taskStatusSchema, count),
  /** 실행 시도 상태별 수. `running`은 아직 끝나지 않은 전부(취소 정리 중 포함)다. */
  runs: z.record(runStatusSchema, count),
  /** `running` 가운데 사용자 제어로 취소를 요청받아 프로바이더가 정리 중인 수. */
  cancelling: count,
  artifacts: count,
  /** 오래된 날부터 오늘까지 {@link dashboardDays}일. 기록이 없는 날도 0으로 있다. */
  days: z.array(dashboardDaySchema).length(dashboardDays),
  /** 진행 중 실행 시도 전부(에이전트당 하나라 자르지 않음). 최근 시작한 것이 먼저다. */
  runningRuns: z.array(runSummarySchema),
  /** 최근 Event {@link dashboardRecentEventLimit}개. 최근 것이 먼저다. */
  recentEvents: z.array(eventSchema),
});
export type OrganizationDashboard = z.infer<typeof organizationDashboardSchema>;

/** 진행 중 실행 시도 수. `running`은 취소 정리 중을 포함한 전부, `cancelling`은 그 가운데 정리 중인 수다. */
export const runningCountSchema = z.object({
  running: count,
  cancelling: count,
});
export type RunningCount = z.infer<typeof runningCountSchema>;

/** 깨우기 종류. 홈은 실행 중인 에이전트가 무엇 때문에 일하는지 짧게 보인다. */
export const wakeKinds = [
  "owner_message",
  "approval_decision",
  "task_assigned",
  "task_completed",
  "task_comment",
  "agent_to_agent_message",
  "research_map_edit",
  "instruction_edit",
  "result_changes_requested",
  "organization_created",
  "heartbeat",
] as const satisfies readonly WakeKind[];
// 깨우기 사유가 늘면 여기서 타입 오류가 나서 목록을 함께 고친다.
const allWakeKinds: Exclude<WakeKind, (typeof wakeKinds)[number]> extends never
  ? true
  : never = true;
void allWakeKinds;
export const wakeKindSchema = z.enum(wakeKinds);

/** 사용자 결정을 기다리는 일의 종류: 승인 요청 종류와 결과 제출. */
export const pendingDecisionKinds = [
  ...approvalKinds,
  "result_submission",
] as const;
export const pendingDecisionKindSchema = z.enum(pendingDecisionKinds);
export type PendingDecisionKind = z.infer<typeof pendingDecisionKindSchema>;

/** 홈 개요의 에이전트 하나: 자리·얼굴과 지금 상태. */
export const overviewAgentSchema = z.object({
  id: z.uuid(),
  role: agentRoleSchema,
  name: z.string(),
  appearance: agentAppearanceSchema,
  status: agentStatusSchema,
  /** 사용자가 이 에이전트를 일시정지했다(조직 일시정지와 따로). */
  paused: z.boolean(),
  /** 가장 최근 실행 시도가 실패로 끝났다. 실행 중이면 거짓이다. */
  lastRunFailed: z.boolean(),
  /**
   * 실행 중일 때 붙잡고 있는 작업 제목: 진행 중인 작업, 없으면 그 실행 시도가 받은 깨우기의 작업.
   * 실행 중이 아니거나 작업과 상관없는 일이면 없다.
   */
  currentTask: z.string().nullable(),
  /** 실행 중일 때 그 실행 시도가 받은 가장 최근 깨우기 종류. 실행 중이 아니면 없다. */
  wakeKind: wakeKindSchema.nullable(),
});
export type OverviewAgent = z.infer<typeof overviewAgentSchema>;

/**
 * 홈 개요. 모든 조직의 진행 중 실행 시도 수와 그 합계, 조직별 마지막 활동 시각, 방을 그릴 조직·에이전트 상태를
 * 한 읽기 snapshot에서 낸다. 조직은 만든 순서(오래된 것이 먼저)다.
 */
export const overviewSchema = z.object({
  asOf: z.iso.datetime({ offset: true }),
  runs: runningCountSchema,
  /** 모든 조직. 진행 중 실행 시도가 없으면 0이다. */
  organizations: z.array(
    runningCountSchema.extend({
      organizationId: z.uuid(),
      /** 그 조직의 가장 최근 Event 시각. Event가 하나도 없으면 없다. */
      lastActivityAt: z.iso.datetime({ offset: true }).nullable(),
      name: z.string(),
      goal: z.string().nullable(),
      stage: lifecycleStageSchema,
      createdAt: z.iso.datetime({ offset: true }),
      /** 들어온 순서(Lead가 먼저). */
      agents: z.array(overviewAgentSchema),
      /** 사용자 결정을 기다리는 승인 요청·결과 제출. 오래된 것이 먼저이며 끝난 조직은 비어 있다. */
      pendingDecisions: z.array(
        z.object({
          kind: pendingDecisionKindSchema,
          createdAt: z.iso.datetime({ offset: true }),
        })
      ),
    })
  ),
});
export type OverviewOrganization = Overview["organizations"][number];
export type Overview = z.infer<typeof overviewSchema>;

/** 화면의 `실행 중`은 취소 정리 중을 뺀 수다(조직 제어와 같은 뜻). 정리 중은 따로 보인다. */
export const activeRunCount = ({ running, cancelling }: RunningCount) =>
  running - cancelling;

/**
 * 실행 시도 성공률: 완료 / (완료 + 실패). 취소·서버 재시작은 분모에 넣지 않고 따로 보인다.
 * 여러 날을 합칠 때는 분자·분모를 각각 더한 뒤 나눈다. 끝난 시도가 없으면 `rate`는 없다(0%가 아님).
 * 실행 시도의 성공이며 연구의 최종 완료가 아니다.
 */
export function runSuccessRate(finished: Record<RunEndReason, number>[]) {
  const completed = finished.reduce((n, f) => n + f.completed, 0);
  const failed = finished.reduce((n, f) => n + f.failed, 0);
  const total = completed + failed;
  return { completed, failed, rate: total ? completed / total : null };
}
