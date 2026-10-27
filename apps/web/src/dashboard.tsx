import {
  activeRunCount,
  runEndReasonSchema,
  runSuccessRate,
  taskStatuses,
  type DashboardDay,
  type OrganizationDashboard,
  type OrganizationDetail,
  type RunningCount,
} from "@babojubot/contracts";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { EventRow } from "./activity.tsx";
import { useOrganizationDashboard } from "./api.ts";
import {
  avatarStyle,
  abbr,
  formatTime,
  Loading,
  LoadError,
  nameOf,
  runLabel,
  RunStatusBadge,
  runStatusLabel,
  taskStatusLabel,
} from "./ui.tsx";

// 조직 › 대시보드의 지표·14일 차트·실행 중인 에이전트·최근 활동(#62). 모두 서버 요약 하나에서 그리며,
// 조직 Event가 오면 다시 불러온다. 불러오는 중·오류를 0으로 보이지 않고, 갱신에 실패하면 마지막 값을 그대로 둔다.

/** 요약을 받은 뒤에만 그린다. 갱신에 실패해도 받은 값이 있으면 그 값을 보인다. */
function WithDashboard({
  orgId,
  children,
}: {
  orgId: string;
  children: (dashboard: OrganizationDashboard) => ReactNode;
}) {
  const dashboard = useOrganizationDashboard(orgId);
  if (dashboard.data) return children(dashboard.data);
  if (dashboard.isError)
    return (
      <LoadError
        what="대시보드 요약"
        onRetry={() => void dashboard.refetch()}
      />
    );
  return <Loading />;
}

// ---------- 지표 ----------

function Metric({
  label,
  value,
  testId,
  children,
}: {
  label: string;
  value: ReactNode;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div className="card p-4" data-testid={testId}>
      <div className="text-[13px] text-slate-500">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</div>
      {children && (
        <div className="mt-1 text-xs text-slate-500 tabular-nums">
          {children}
        </div>
      )}
    </div>
  );
}

const sum = (counts: Record<string, number>) =>
  Object.values(counts).reduce((n, v) => n + v, 0);
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

/** 조직 기록 전체의 수와 14일 실행 성공률. */
export function DashboardMetrics({ orgId }: { orgId: string }) {
  const dashboard = useOrganizationDashboard(orgId);
  return (
    <section aria-label="지표">
      {dashboard.isError && dashboard.data && (
        <p role="alert" className="mb-2 text-xs text-rose-600">
          최신 요약을 불러오지 못해 마지막으로 받은 값을 보입니다.{" "}
          <button
            className="font-semibold underline underline-offset-2"
            onClick={() => void dashboard.refetch()}
          >
            다시 시도
          </button>
        </p>
      )}
      <WithDashboard orgId={orgId}>
        {({ tasks, runs, cancelling, artifacts, days }) => {
          const finished = days.map((d) => d.runsFinished);
          const success = runSuccessRate(finished);
          return (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="작업" value={sum(tasks)} testId="metric-tasks">
                {taskStatuses
                  .map((s) => `${taskStatusLabel[s]} ${tasks[s]}`)
                  .join(" · ")}
              </Metric>
              <Metric label="실행 시도" value={sum(runs)} testId="metric-runs">
                <RunningCountText
                  count={{ running: runs.running, cancelling }}
                />
                <br />
                {endReasons
                  .filter((s) => runs[s] > 0)
                  .map((s) => `${runStatusLabel[s]} ${runs[s]}`)
                  .join(" · ")}
              </Metric>
              <Metric
                label="산출물"
                value={artifacts}
                testId="metric-artifacts"
              />
              <Metric
                label="실행 성공률 · 14일"
                value={success.rate === null ? "—" : percent(success.rate)}
                testId="metric-success"
              >
                {success.rate !== null &&
                  `완료 ${success.completed} · 실패 ${success.failed}`}
              </Metric>
            </div>
          );
        }}
      </WithDashboard>
    </section>
  );
}

/** `실행 중 N · 취소 정리 중 M`. 조직 제어와 같이 실행 중은 정리 중을 뺀 수이고, 정리 중은 있을 때만 보인다. */
export function RunningCountText({ count }: { count: RunningCount }) {
  return (
    <>
      실행 중 {activeRunCount(count)}
      {count.cancelling > 0 && ` · 취소 정리 중 ${count.cancelling}`}
    </>
  );
}

// ---------- 14일 차트 ----------

const endReasons = runEndReasonSchema.options;
const runStatusesInChart = [...endReasons, "running"] as const;

/** 범주 색. 고정 순서로 배정하고 순환하지 않는다(dataviz 기본 팔레트, 인접 쌍 색각 검사 통과). */
const slot = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"] as const;

type Series = {
  key: string;
  label: string;
  color: string;
  value: (day: DashboardDay) => number;
};

const runSeries: Series[] = runStatusesInChart.map((status, i) => ({
  key: status,
  label: runStatusLabel[status],
  color: slot[i]!,
  value: (d) => d.runsStarted[status],
}));
const taskSeries: Series[] = taskStatuses.map((status, i) => ({
  key: status,
  label: taskStatusLabel[status],
  color: slot[i]!,
  value: (d) => d.tasksCreated[status],
}));
const artifactSeries: Series[] = [
  {
    key: "artifacts",
    label: "산출물",
    color: slot[0],
    value: (d) => d.artifactsRecorded,
  },
];

const chartHeight = 96;
const shortDate = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
};

/**
 * 날짜별 막대 14개. 막대마다 hover·keyboard focus로 그날의 수를 보이고, `숫자로 보기` 표가 같은 값을 모두 담는다.
 * 여러 계열이면 아래에서부터 쌓고 범례를 둔다. `display`가 있으면 막대 높이(0~1)와 표시 값을 직접 정한다(비율).
 */
function DayChart({
  title,
  days,
  series,
  display,
}: {
  title: string;
  days: DashboardDay[];
  series: Series[];
  display?: (day: DashboardDay) => { height: number | null; label: string };
}) {
  const [active, setActive] = useState<number>();
  const max = Math.max(
    1,
    ...days.map((d) => series.reduce((n, s) => n + s.value(d), 0))
  );
  const describe = (d: DashboardDay) =>
    display
      ? `${shortDate(d.date)}: ${display(d).label}`
      : `${shortDate(d.date)}: ${series.map((s) => `${s.label} ${s.value(d)}`).join(", ")}`;
  return (
    <figure className="card min-w-0 p-4" aria-label={title}>
      <figcaption className="text-sm font-semibold text-slate-700">
        {title}
      </figcaption>
      {series.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1">
              <span
                className="h-2 w-2.5 rounded-[2px]"
                style={{ background: s.color }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <div className="mb-1 text-right text-[10px] text-slate-400 tabular-nums">
          {display ? "100%" : `최대 ${max}`}
        </div>
        <div
          className="flex items-end gap-1 border-b border-slate-200"
          style={{ height: chartHeight + 12 }}
        >
          {days.map((d, i) => {
            const shown = display?.(d);
            return (
              <div
                key={d.date}
                tabIndex={0}
                role="img"
                aria-label={describe(d)}
                data-date={d.date}
                className="relative flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(undefined)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(undefined)}
              >
                <div
                  className={`mx-auto flex w-full max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] ${active === i ? "opacity-80" : ""}`}
                >
                  {shown ? (
                    shown.height === null ? (
                      // 값이 없는 날(분모 0)은 0%와 구별해 막대 대신 —를 둔다.
                      <span className="text-center text-[10px] leading-none text-slate-300">
                        —
                      </span>
                    ) : (
                      <span
                        style={{
                          height: Math.max(2, shown.height * chartHeight),
                          background: slot[0],
                        }}
                      />
                    )
                  ) : (
                    series.map((s) => {
                      const v = s.value(d);
                      return v ? (
                        <span
                          key={s.key}
                          style={{
                            height: Math.max(2, (v / max) * chartHeight),
                            background: s.color,
                          }}
                        />
                      ) : null;
                    })
                  )}
                </div>
                {active === i && (
                  <div
                    role="tooltip"
                    className={`pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-48 rounded-lg bg-slate-900 px-2 py-1.5 text-[11px] text-white shadow-pop ${i < days.length / 2 ? "left-0" : "right-0"}`}
                  >
                    <div className="font-semibold">
                      {shortDate(d.date)}
                      {i === days.length - 1 && " (오늘)"}
                    </div>
                    {shown ? (
                      <div>{shown.label}</div>
                    ) : (
                      series.map((s) => (
                        <div key={s.key} className="flex items-center gap-1.5">
                          <span
                            className="h-0.5 w-2.5"
                            style={{ background: s.color }}
                          />
                          <span className="font-semibold tabular-nums">
                            {s.value(d)}
                          </span>
                          <span className="text-slate-300">{s.label}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-slate-400 tabular-nums">
          <span>{shortDate(days[0]!.date)}</span>
          <span>오늘</span>
        </div>
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-slate-500">숫자로 보기</summary>
        <div className="scrollbar-thin mt-1 max-h-60 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">날짜</th>
                {display ? (
                  <th className="py-1 pr-2 font-medium">{title}</th>
                ) : (
                  series.map((s) => (
                    <th key={s.key} className="py-1 pr-2 font-medium">
                      {s.label}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.date} className="border-t border-slate-100">
                  <td className="py-1 pr-2">{d.date}</td>
                  {display ? (
                    <td className="py-1 pr-2">{display(d).label}</td>
                  ) : (
                    series.map((s) => (
                      <td key={s.key} className="py-1 pr-2">
                        {s.value(d)}
                      </td>
                    ))
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 실행 시도·성공률·작업·산출물의 14일. 날짜는 브라우저 시간대로 자른다. */
export function DashboardCharts({ orgId }: { orgId: string }) {
  return (
    <section aria-label="14일 차트">
      <WithDashboard orgId={orgId}>
        {({ days, timeZone }) => (
          <>
            <h2
              className="mb-2 text-xs font-medium text-slate-500"
              title={timeZone}
            >
              최근 14일
              {timeZone !== browserTimeZone && ` · ${timeZone} 기준`}
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              <DayChart title="실행 시도" days={days} series={runSeries} />
              <DayChart
                title="실행 성공률"
                days={days}
                series={[]}
                display={(d) => {
                  const { completed, failed, rate } = runSuccessRate([
                    d.runsFinished,
                  ]);
                  const { cancelled, server_restart } = d.runsFinished;
                  const others = `취소 ${cancelled} · 서버 재시작 ${server_restart} 제외`;
                  return rate === null
                    ? { height: null, label: `— (완료·실패 없음, ${others})` }
                    : {
                        height: rate,
                        label: `${percent(rate)} (완료 ${completed} / ${completed + failed}, ${others})`,
                      };
                }}
              />
              <DayChart title="작업" days={days} series={taskSeries} />
              <DayChart title="산출물" days={days} series={artifactSeries} />
            </div>
          </>
        )}
      </WithDashboard>
    </section>
  );
}

// ---------- 실행 중인 에이전트 ----------

/** 진행 중 실행 시도 전부. 취소를 요청받아 정리 중인 것도 끝날 때까지 여기에 남는다. */
export function RunningAgents({ org }: { org: OrganizationDetail }) {
  return (
    <section aria-label="실행 중인 에이전트" className="card text-sm">
      <h2 className="px-4 pt-4 pb-2 font-semibold text-slate-600">
        실행 중인 에이전트
      </h2>
      <WithDashboard orgId={org.id}>
        {({ runningRuns, runs, cancelling }) =>
          !runningRuns.length ? (
            <p className="px-4 pb-4 text-slate-500">
              지금 실행 중인 에이전트가 없습니다.
            </p>
          ) : (
            <>
              <p
                className="px-4 pb-2 text-xs text-slate-500"
                data-testid="running-agent-counts"
              >
                <RunningCountText
                  count={{ running: runs.running, cancelling }}
                />
              </p>
              <ul className="divide-y divide-slate-100">
                {runningRuns.map((run) => (
                  <li
                    key={run.id}
                    className="px-4 py-2.5"
                    data-agent-id={run.agentId}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold text-white"
                        style={avatarStyle(run.agentId)}
                      >
                        {abbr(nameOf(org.agents, run.agentId))}
                      </span>
                      <Link
                        to={`/orgs/${org.id}/agents/${run.agentId}`}
                        className="min-w-0 truncate font-medium text-slate-800 hover:underline"
                      >
                        {nameOf(org.agents, run.agentId)}
                      </Link>
                      <span className="ml-auto">
                        <RunStatusBadge
                          status={run.status}
                          cancelReason={run.cancelReason}
                        />
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
                      <span className="text-slate-400 tabular-nums">
                        {formatTime(run.startedAt)} 시작
                      </span>
                      <Link
                        to={`/orgs/${org.id}/runs/${run.id}`}
                        className="text-brand-600 hover:underline"
                      >
                        {runLabel(run.id)}
                      </Link>
                      <Link
                        to={`/orgs/${org.id}/activity?agent=${run.agentId}`}
                        className="text-brand-600 hover:underline"
                      >
                        활동 보기
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </WithDashboard>
    </section>
  );
}

// ---------- 최근 활동 ----------

export function RecentActivity({ org }: { org: OrganizationDetail }) {
  return (
    <section aria-label="최근 활동" className="card text-sm">
      <div className="flex items-center px-4 pt-4 pb-2">
        <h2 className="font-semibold text-slate-600">최근 활동</h2>
        <Link
          to={`/orgs/${org.id}/activity`}
          className="ml-auto text-xs text-brand-600 hover:underline"
        >
          전체 활동 →
        </Link>
      </div>
      <WithDashboard orgId={org.id}>
        {({ recentEvents }) =>
          !recentEvents.length ? (
            <p className="px-4 pb-4 text-slate-500">아직 활동이 없습니다.</p>
          ) : (
            <ol className="divide-y divide-slate-100">
              {recentEvents.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  orgId={org.id}
                  agents={org.agents}
                />
              ))}
            </ol>
          )
        }
      </WithDashboard>
    </section>
  );
}
