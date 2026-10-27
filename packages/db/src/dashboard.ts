import {
  closedStages,
  dashboardDays,
  dashboardRecentEventLimit,
  runStatuses,
  taskStatuses,
  type DashboardDay,
  type AgentRole,
  type OrganizationDashboard,
  type Overview,
  type PendingDecisionKind,
  type RunEndReason,
  type RunStatus,
  type TaskStatus,
  type WakeKind,
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
import { isUuid, resolveAppearance, toEvent } from "./rows.ts";
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
      // 오늘이 끝나는 시각. 서머타임으로 23·25시간인 날도 이 시간대의 다음 자정이다.
      const {
        rows: [nextDay],
      } = await tx.execute<{ at: string }>(
        sql`select to_char((${today} + 1)::timestamp at time zone ${timeZone} at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`
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
          nextDayAt: nextDay!.at,
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
 * 홈 개요: 모든 조직의 진행 중 실행 시도 수(취소 정리 중 포함)와 그 가운데 정리 중인 수, 조직마다 마지막 Event 시각,
 * 방을 그릴 조직·에이전트 상태와 사용자 결정을 기다리는 일. 조직 수와 상관없이 SQL 세 개를 한 읽기 snapshot에서
 * 실행하므로 수·상태가 서로 맞는다. 조직은 만든 순서, 에이전트는 들어온 순서(Lead가 먼저)다.
 */
export async function getOverview(db: Database, now: Date): Promise<Overview> {
  return db.transaction(
    async (tx) => {
      const orgRows = await tx
        .select({
          organizationId: organizations.id,
          name: organizations.name,
          goal: organizations.goal,
          stage: organizations.stage,
          createdAt: organizations.createdAt,
          running: count(runs.id),
          cancelling:
            sql<number>`count(${runs.id}) filter (where ${runs.cancelReason} is not null)`.mapWith(
              Number
            ),
          // 조직별 마지막 Event. id 순서가 기록 순서라 조직 index(organization_id, id)로 한 행만 읽는다.
          lastActivityAt:
            sql<Date | null>`(select ${events.createdAt} from ${events} where ${events.organizationId} = ${organizations.id} order by ${events.id} desc limit 1)`.mapWith(
              events.createdAt
            ),
        })
        .from(organizations)
        .leftJoin(
          runs,
          and(
            eq(runs.organizationId, organizations.id),
            eq(runs.status, "running")
          )
        )
        .groupBy(organizations.id)
        .orderBy(asc(organizations.createdAt), asc(organizations.id));

      // 에이전트마다 진행 중 실행 시도(에이전트당 하나), 가장 최근 실행 시도의 상태, 실행 중이면 붙잡은 작업과 깨우기.
      // 마지막 실행 시도는 (조직, 에이전트, seq) index로 한 행만 읽고, 하는 일은 실행 중인 에이전트만 찾는다.
      const { rows: agentRows } = await tx.execute<{
        id: string;
        organization_id: string;
        role: AgentRole;
        name: string;
        appearance: unknown;
        paused: boolean;
        running: boolean;
        last_run_failed: boolean;
        task_title: string | null;
        wake_kind: WakeKind | null;
      }>(sql`
        select a.id, a.organization_id, a.role, a.name, a.appearance, a.paused,
          r.id is not null as running,
          coalesce(last_run.status = 'failed', false) as last_run_failed,
          doing.task_title, doing.wake_kind
        from agents a
        left join runs r on r.agent_id = a.id and r.status = 'running'
        left join lateral (
          select lr.status from runs lr
          where lr.organization_id = a.organization_id and lr.agent_id = a.id
          order by lr.seq desc limit 1
        ) last_run on true
        left join lateral (
          select
            coalesce(
              (select t.title from tasks t
                where t.organization_id = a.organization_id
                  and t.assignee_agent_id = a.id
                  and t.status = 'in_progress'
                order by t.started_at desc, t.seq desc limit 1),
              wake_task.title
            ) as task_title,
            w.kind as wake_kind
          from (select 1) as one
          left join lateral (
            select w.kind, coalesce(w.task_id, c.task_id) as task_id
            from wakes w
            left join task_comments c on c.id = w.comment_id
            where w.run_id = r.id
            order by w.seq desc limit 1
          ) w on true
          left join tasks wake_task on wake_task.id = w.task_id
          where r.id is not null
        ) doing on true
        order by a.organization_id, a.role <> 'lead', a.created_at, a.id`);

      // 끝난 조직의 결정은 화면에서 할 수 없으므로 뺀다(Inbox와 같은 기준).
      const { rows: decisionRows } = await tx.execute<{
        organization_id: string;
        kind: PendingDecisionKind;
        created_at: Date | string;
      }>(sql`
        select d.organization_id, d.kind, d.created_at
        from (
          select organization_id, kind, created_at, seq from approvals where status = 'pending'
          union all
          select organization_id, 'result_submission', created_at, seq from result_submissions where status = 'pending'
        ) d
        join organizations o on o.id = d.organization_id
        where o.stage not in (${sql.join(
          closedStages.map((s) => sql`${s}`),
          sql`, `
        )})
        order by d.created_at, d.seq`);

      const agentsOf = byOrganization(agentRows);
      const decisionsOf = byOrganization(decisionRows);
      return {
        asOf: now.toISOString(),
        runs: {
          running: orgRows.reduce((n, r) => n + r.running, 0),
          cancelling: orgRows.reduce((n, r) => n + r.cancelling, 0),
        },
        organizations: orgRows.map(({ lastActivityAt, createdAt, ...r }) => ({
          ...r,
          createdAt: createdAt.toISOString(),
          lastActivityAt: lastActivityAt?.toISOString() ?? null,
          agents: (agentsOf.get(r.organizationId) ?? []).map((a) => ({
            id: a.id,
            role: a.role,
            name: a.name,
            appearance: resolveAppearance(a.id, a.appearance),
            status: a.running ? ("running" as const) : ("idle" as const),
            paused: a.paused,
            lastRunFailed: a.last_run_failed,
            currentTask: a.running ? a.task_title : null,
            wakeKind: a.running ? a.wake_kind : null,
          })),
          pendingDecisions: (decisionsOf.get(r.organizationId) ?? []).map(
            (d) => ({
              kind: d.kind,
              createdAt: new Date(d.created_at).toISOString(),
            })
          ),
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/** 행을 조직별로 묶는다. 조직 안의 순서는 행의 순서 그대로다. */
function byOrganization<T extends { organization_id: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.organization_id);
    if (list) list.push(row);
    else map.set(row.organization_id, [row]);
  }
  return map;
}
