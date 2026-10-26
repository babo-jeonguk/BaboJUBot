import {
  dashboardDays,
  dashboardRecentEventLimit,
  runStatuses,
  taskStatuses,
  type DashboardDay,
  type OrganizationDashboard,
  type Overview,
  type RunEndReason,
  type RunStatus,
  type TaskStatus,
} from "@babojubot/contracts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import { isUuid, toEvent } from "./rows.ts";
import { listRunningRuns } from "./runs.ts";
import { artifacts, events, organizations, runs, tasks } from "./schema.ts";

/** 서버 Postgres가 아는 시간대 이름. tz 자료는 서버가 도는 동안 바뀌지 않으므로 처음 한 번 읽는다. */
const timeZoneNames = new WeakMap<Database, Promise<Set<string>>>();
function knownTimeZones(db: Database) {
  let names = timeZoneNames.get(db);
  if (!names) {
    names = db
      .execute<{ name: string }>(sql`select name from pg_timezone_names`)
      .then((result) => new Set(result.rows.map((r) => r.name)));
    names.catch(() => timeZoneNames.delete(db));
    timeZoneNames.set(db, names);
  }
  return names;
}

const zeros = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const endReasons = runStatuses.filter(
  (s): s is RunEndReason => s !== "running"
);

export type DashboardResult =
  | { kind: "not_found" }
  | { kind: "invalid_time_zone" }
  | { kind: "ok"; dashboard: OrganizationDashboard };

/**
 * 조직 대시보드 요약. 수·날짜별 수·진행 중 목록·최근 활동을 한 READ ONLY REPEATABLE READ snapshot에서 읽어 서로 맞춘다.
 * 날짜는 `timeZone`의 달력 날짜로 자르며, 오늘(`now`가 속한 날)까지 {@link dashboardDays}일이다. 각 날은 그 시간대의
 * 자정부터 다음 자정 전까지다(서머타임으로 23·25시간인 날도 하루). 조회만 하며 잠금을 잡지 않는다.
 */
export async function getOrganizationDashboard(
  db: Database,
  organizationId: string,
  { now, timeZone }: { now: Date; timeZone: string }
): Promise<DashboardResult> {
  if (!isUuid(organizationId)) return { kind: "not_found" };
  if (!(await knownTimeZones(db)).has(timeZone))
    return { kind: "invalid_time_zone" };
  const asOf = now.toISOString();
  const today = sql`(${asOf}::timestamptz at time zone ${timeZone})::date`;
  const windowStart = sql`(${today} - ${dashboardDays - 1}::int)::timestamp at time zone ${timeZone}`;
  const localDate = (column: PgColumn) =>
    sql<string>`to_char(${column} at time zone ${timeZone}, 'YYYY-MM-DD')`;
  const ofOrg = (column: PgColumn) => eq(column, organizationId);

  return db.transaction(
    async (tx) => {
      const [org] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(ofOrg(organizations.id));
      if (!org) return { kind: "not_found" } as const;

      const { rows: dates } = await tx.execute<{ date: string }>(
        sql`select to_char(${today} - i, 'YYYY-MM-DD') as date
          from generate_series(${dashboardDays - 1}::int, 0, -1) as i`
      );
      const days = new Map(
        dates.map(({ date }): [string, DashboardDay] => [
          date,
          {
            date,
            runsStarted: zeros(runStatuses),
            runsFinished: zeros(endReasons),
            tasksCreated: zeros(taskStatuses),
            artifactsRecorded: 0,
          },
        ])
      );
      // 기간 안의 기록을 날짜·상태로 세어 그날에 더한다. 기준 시각 뒤 날짜의 기록은 어느 날에도 넣지 않는다.
      const countByDay = async <S extends string>(
        table: PgTable,
        time: PgColumn,
        status: SQL<S>,
        where: SQL | undefined,
        add: (day: DashboardDay, status: S, n: number) => void
      ) => {
        const rows = await tx
          .select({ date: localDate(time), status, n: count() })
          .from(table)
          .where(and(where, gte(time, windowStart)))
          .groupBy(sql`1`, sql`2`);
        for (const row of rows) {
          const day = days.get(row.date);
          if (day) add(day, row.status, row.n);
        }
      };
      await countByDay(
        runs,
        runs.startedAt,
        sql<RunStatus>`${runs.status}`,
        ofOrg(runs.organizationId),
        (day, status, n) => (day.runsStarted[status] = n)
      );
      await countByDay(
        runs,
        runs.finishedAt,
        sql<RunEndReason>`${runs.status}`,
        and(ofOrg(runs.organizationId), ne(runs.status, "running")),
        (day, status, n) => (day.runsFinished[status] = n)
      );
      await countByDay(
        tasks,
        tasks.createdAt,
        sql<TaskStatus>`${tasks.status}`,
        ofOrg(tasks.organizationId),
        (day, status, n) => (day.tasksCreated[status] = n)
      );
      await countByDay(
        artifacts,
        artifacts.createdAt,
        sql<"artifact">`'artifact'`,
        ofOrg(artifacts.organizationId),
        (day, _status, n) => (day.artifactsRecorded = n)
      );

      const runTotals = zeros(runStatuses);
      for (const { status, n } of await tx
        .select({ status: runs.status, n: count() })
        .from(runs)
        .where(ofOrg(runs.organizationId))
        .groupBy(runs.status))
        runTotals[status] = n;
      const [cancelling] = await tx
        .select({ n: count() })
        .from(runs)
        .where(
          and(
            ofOrg(runs.organizationId),
            eq(runs.status, "running"),
            isNotNull(runs.cancelReason)
          )
        );
      const taskTotals = zeros(taskStatuses);
      for (const { status, n } of await tx
        .select({ status: tasks.status, n: count() })
        .from(tasks)
        .where(ofOrg(tasks.organizationId))
        .groupBy(tasks.status))
        taskTotals[status] = n;
      const [artifactTotal] = await tx
        .select({ n: count() })
        .from(artifacts)
        .where(ofOrg(artifacts.organizationId));
      const recent = await tx
        .select()
        .from(events)
        .where(ofOrg(events.organizationId))
        .orderBy(desc(events.id))
        .limit(dashboardRecentEventLimit);

      return {
        kind: "ok",
        dashboard: {
          organizationId,
          asOf,
          timeZone,
          tasks: taskTotals,
          runs: runTotals,
          cancelling: cancelling!.n,
          artifacts: artifactTotal!.n,
          days: [...days.values()],
          runningRuns: await listRunningRuns(tx, organizationId),
          recentEvents: recent.map(toEvent),
        },
      } as const;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/**
 * 홈 개요: 모든 조직의 진행 중 실행 시도 수(취소 정리 중 포함)와 그 가운데 정리 중인 수. 조직별 수와 합계를 같은
 * SQL 하나의 결과에서 내므로 서로 맞는다. 진행 중 실행 시도가 없는 조직도 0으로 있다.
 */
export async function getOverview(db: Database, now: Date): Promise<Overview> {
  const rows = await db
    .select({
      organizationId: organizations.id,
      running: count(runs.id),
      cancelling:
        sql<number>`count(${runs.id}) filter (where ${runs.cancelReason} is not null)`.mapWith(
          Number
        ),
    })
    .from(organizations)
    .leftJoin(
      runs,
      and(eq(runs.organizationId, organizations.id), eq(runs.status, "running"))
    )
    .groupBy(organizations.id)
    .orderBy(asc(organizations.createdAt), asc(organizations.id));
  return {
    asOf: now.toISOString(),
    runs: {
      running: rows.reduce((n, r) => n + r.running, 0),
      cancelling: rows.reduce((n, r) => n + r.cancelling, 0),
    },
    organizations: rows,
  };
}
