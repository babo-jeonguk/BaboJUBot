import { z } from "zod";
import { eventSchema } from "./event.ts";
import {
  runEndReasonSchema,
  runStatusSchema,
  runSummarySchema,
  type RunEndReason,
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
  /** 작업 상태별 수. */
  tasks: z.record(taskStatusSchema, count),
  /** 실행 시도 상태별 수. `running`은 아직 끝나지 않은 전부(취소 정리 중 포함)다. */
  runs: z.record(runStatusSchema, count),
  /** `running` 가운데 사용자 제어로 취소를 요청받아 실행기가 정리 중인 수. */
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

/** 홈 개요. 모든 조직의 진행 중 실행 시도 수와 그 합계를 한 조회에서 센다. */
export const overviewSchema = z.object({
  asOf: z.iso.datetime({ offset: true }),
  runs: runningCountSchema,
  /** 모든 조직. 진행 중 실행 시도가 없으면 0이다. */
  organizations: z.array(
    runningCountSchema.extend({ organizationId: z.uuid() })
  ),
});
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
