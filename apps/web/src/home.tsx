// 홈: 모든 연구 조직을 한눈에(docs/research/home-references.md D01~D05).
// 위에는 주의 필요·실행 중·조직 수, 아래에는 조직 카드를 주의 필요 → 진행 중으로 나누고 끝난 조직은 접어 둔다.
// 순서는 주의 수, 실행 중 여부, 마지막 활동 시각으로 정해서 사용자가 볼 조직이 먼저 온다.
import {
  activeRunCount,
  inboxOrganizationId,
  isClosedStage,
  needsAttention,
  type InboxItem,
  type Organization,
  type Overview,
} from "@babojubot/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useInbox, useOrganizations, useOverview } from "./api.ts";
import { useOpenCreateOrganization } from "./create-organization.tsx";
import { RunningCountText } from "./dashboard.tsx";
import { useInboxPanel } from "./inbox.tsx";
import {
  abbr,
  avatarStyle,
  formatTime,
  Loading,
  LoadError,
  Page,
  StageBadge,
} from "./ui.tsx";

type Row = {
  org: Organization;
  attention: number;
  running: Overview["organizations"][number] | undefined;
  /** 마지막 Event 시각. 개요를 아직 못 받았으면 만든 시각으로 정렬한다. */
  lastActivityAt: string | null;
};

const time = (row: Row) => Date.parse(row.lastActivityAt ?? row.org.createdAt);
const isRunning = (row: Row) =>
  !!row.running && activeRunCount(row.running) > 0;
/** 최근 활동이 먼저. */
const byActivity = (a: Row, b: Row) => time(b) - time(a);
/** 주의 수가 많은 조직이 먼저, 같으면 최근 활동이 먼저. */
const byAttention = (a: Row, b: Row) =>
  b.attention - a.attention || byActivity(a, b);
/** 실행 중인 조직이 먼저, 일시정지는 뒤로, 그 안에서는 최근 활동이 먼저. */
const byProgress = (a: Row, b: Row) =>
  Number(isRunning(b)) - Number(isRunning(a)) ||
  Number(a.org.stage === "paused") - Number(b.org.stage === "paused") ||
  byActivity(a, b);

/**
 * 홈 구역 나누기. 주의 수는 레일·Inbox와 같은 판정(`needsAttention`)이라 구역의 주의 수를 더하면 레일 배지와 같다.
 * 주의가 있으면 끝난 조직도 주의 필요에 둔다(예: 중단 뒤 읽지 않은 실패). 나머지 끝난 조직은 따로 접어 둔다.
 */
export function arrangeHome(
  organizations: Organization[],
  overview: Overview | undefined,
  inbox: InboxItem[]
) {
  const attentionOf = new Map<string, number>();
  for (const item of inbox)
    if (needsAttention(item)) {
      const id = inboxOrganizationId(item);
      attentionOf.set(id, (attentionOf.get(id) ?? 0) + 1);
    }
  const rows: Row[] = organizations.map((org) => {
    const running = overview?.organizations.find(
      (r) => r.organizationId === org.id
    );
    return {
      org,
      attention: attentionOf.get(org.id) ?? 0,
      running,
      lastActivityAt: running?.lastActivityAt ?? null,
    };
  });
  const quiet = rows.filter((r) => r.attention === 0);
  return {
    attention: rows.filter((r) => r.attention > 0).sort(byAttention),
    progress: quiet.filter((r) => !isClosedStage(r.org.stage)).sort(byProgress),
    closed: quiet.filter((r) => isClosedStage(r.org.stage)).sort(byActivity),
    totalAttention: [...attentionOf.values()].reduce((n, c) => n + c, 0),
  };
}

export function Home() {
  const orgs = useOrganizations();
  const overview = useOverview();
  const inbox = useInbox();
  if (orgs.isPending) return <Loading />;
  if (orgs.isError)
    return <LoadError what="조직 목록" onRetry={() => void orgs.refetch()} />;
  if (!orgs.data.length) return <NoOrganizations />;

  // 주의 수를 불러오는 중에는 카드를 그리지 않는다(받은 뒤 구역이 뒤바뀌지 않게).
  const { attention, progress, closed, totalAttention } = arrangeHome(
    orgs.data,
    overview.data,
    inbox.data ?? []
  );

  return (
    <Page width="full">
      <div className="mx-auto max-w-6xl">
        <Summary
          organizations={orgs.data.length}
          attention={
            inbox.isError ? "error" : inbox.data ? totalAttention : undefined
          }
          onRetryAttention={() => void inbox.refetch()}
          overview={overview}
        />
        {inbox.isPending ? (
          <Loading />
        ) : (
          <div className="space-y-8">
            {attention.length > 0 && (
              <Group
                id="attention"
                label="주의 필요"
                tone="attention"
                rows={attention}
              />
            )}
            {progress.length > 0 && (
              <Group id="progress" label="진행 중" rows={progress} />
            )}
            {closed.length > 0 && (
              <Closed
                rows={closed}
                defaultOpen={!attention.length && !progress.length}
              />
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

// ---------- 위쪽 요약 ----------

function Summary({
  organizations,
  attention,
  onRetryAttention,
  overview,
}: {
  organizations: number;
  attention: number | "error" | undefined;
  onRetryAttention: () => void;
  overview: ReturnType<typeof useOverview>;
}) {
  const openCreate = useOpenCreateOrganization();
  const panel = useInboxPanel();
  const hot = typeof attention === "number" && attention > 0;
  return (
    <div className="mb-8 flex flex-wrap items-stretch gap-3">
      <div className="card grid min-w-0 flex-1 grid-cols-3 divide-x divide-slate-100 overflow-hidden sm:flex sm:flex-none">
        <button
          onClick={
            attention === "error" ? onRetryAttention : () => panel.show()
          }
          aria-label={
            attention === "error"
              ? "주의 수를 불러오지 못함 · 다시 시도"
              : `주의 필요 ${attention ?? "…"}개 · Inbox 열기`
          }
          className={`${cell} text-left transition duration-150 ${hot ? "bg-amber-50 hover:bg-amber-100/70" : "hover:bg-slate-50"}`}
        >
          <Label dot={hot ? "bg-amber-500" : "bg-slate-300"}>주의 필요</Label>
          <span
            className={`text-2xl font-semibold tabular-nums ${hot ? "text-amber-800" : attention === "error" ? "text-rose-600" : "text-slate-800"}`}
            data-testid="attention-count"
          >
            {attention === "error" ? "!" : (attention ?? "…")}
          </span>
        </button>
        <div className={cell}>
          <Label
            dot={
              overview.data && activeRunCount(overview.data.runs) > 0
                ? "animate-pulse bg-brand-500"
                : "bg-slate-300"
            }
          >
            실행 중
          </Label>
          {overview.data ? (
            <span className="flex items-baseline gap-2">
              <span
                className="text-2xl font-semibold text-slate-800 tabular-nums"
                data-testid="running-run-count"
              >
                {activeRunCount(overview.data.runs)}
              </span>
              {overview.data.runs.cancelling > 0 && (
                <span
                  className="text-xs text-amber-700"
                  data-testid="cancelling-run-count"
                >
                  취소 정리 중 {overview.data.runs.cancelling}
                </span>
              )}
            </span>
          ) : overview.isError ? (
            <button
              role="alert"
              className="py-1 text-sm text-rose-700 underline underline-offset-2"
              onClick={() => void overview.refetch()}
            >
              불러오지 못함 · 다시 시도
            </button>
          ) : (
            <span className="text-2xl font-semibold text-slate-300" aria-busy>
              …
            </span>
          )}
        </div>
        <div className={cell}>
          <Label>연구 조직</Label>
          <span
            className="text-2xl font-semibold text-slate-800 tabular-nums"
            data-testid="organization-count"
          >
            {organizations}
          </span>
        </div>
      </div>
      <button
        className="btn-primary w-full self-center py-2 sm:ml-auto sm:w-auto"
        onClick={openCreate}
      >
        ＋ 새 연구 조직
      </button>
    </div>
  );
}

const cell =
  "flex min-w-0 flex-col items-start gap-0.5 px-4 py-2.5 sm:min-w-32 sm:px-5";

function Label({ children, dot }: { children: ReactNode; dot?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-slate-500">
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
      {children}
    </span>
  );
}

// ---------- 조직 카드 ----------

function Group({
  id,
  label,
  tone,
  rows,
}: {
  id: string;
  label: string;
  tone?: "attention";
  rows: Row[];
}) {
  return (
    <section aria-labelledby={`home-${id}`}>
      <div className="mb-3 flex items-center gap-2 text-sm">
        {tone === "attention" && (
          <span className="h-2 w-2 rounded-full bg-amber-500" />
        )}
        <h2 id={`home-${id}`} className="font-semibold text-slate-700">
          {label}
        </h2>
        <span className="text-slate-400 tabular-nums">{rows.length}</span>
      </div>
      <Cards rows={rows} />
    </section>
  );
}

function Cards({ rows }: { rows: Row[] }) {
  const now = useNow();
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3">
      {rows.map((row) => (
        <li key={row.org.id}>
          <OrganizationCard row={row} now={now} />
        </li>
      ))}
    </ul>
  );
}

function OrganizationCard({ row, now }: { row: Row; now: number }) {
  const { org, attention, running } = row;
  return (
    <Link
      to={`/orgs/${org.id}`}
      data-org-id={org.id}
      className="card card-hover relative flex h-full flex-col gap-3 overflow-hidden p-4"
    >
      {attention > 0 && (
        <span
          className="absolute inset-y-0 left-0 w-1 bg-amber-400"
          aria-hidden
        />
      )}
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-semibold text-white shadow-sm"
          style={avatarStyle(org.id)}
        >
          {abbr(org.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 leading-snug font-semibold text-slate-900">
            {org.name}
          </div>
          {org.goal && (
            <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-slate-500">
              {org.goal}
            </div>
          )}
        </div>
        {attention > 0 && (
          <span
            className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 tabular-nums"
            data-testid="organization-attention"
          >
            주의 {attention}
          </span>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <StageBadge stage={org.stage} />
        {running && running.running > 0 && (
          <span
            className="inline-flex items-center gap-1.5 font-medium text-brand-700 tabular-nums"
            data-testid="organization-running"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
            <RunningCountText count={running} />
          </span>
        )}
        <ActivityTime iso={row.lastActivityAt} now={now} className="ml-auto" />
      </div>
    </Link>
  );
}

function ActivityTime({
  iso,
  now,
  className = "",
}: {
  iso: string | null;
  now: number;
  className?: string;
}) {
  if (!iso) return null;
  return (
    <time
      dateTime={iso}
      title={`마지막 활동 ${formatTime(iso)}`}
      className={`text-xs whitespace-nowrap text-slate-400 tabular-nums ${className}`}
      data-testid="organization-last-activity"
    >
      {relativeTime(iso, now)}
    </time>
  );
}

// ---------- 끝난 조직 ----------

function Closed({ rows, defaultOpen }: { rows: Row[]; defaultOpen: boolean }) {
  const now = useNow();
  return (
    <details className="group" open={defaultOpen}>
      <summary className="mb-3 flex w-fit cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-semibold text-slate-500 transition select-none hover:text-slate-700 [&::-webkit-details-marker]:hidden">
        <span className="text-[10px] transition group-open:rotate-90">▶</span>
        끝난 조직
        <span
          className="font-normal text-slate-400 tabular-nums"
          data-testid="closed-organization-count"
        >
          {rows.length}
        </span>
      </summary>
      <ul
        aria-label="끝난 조직"
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2"
      >
        {rows.map(({ org, lastActivityAt }) => (
          <li key={org.id}>
            <Link
              to={`/orgs/${org.id}`}
              data-org-id={org.id}
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm ring-1 ring-slate-900/[0.06] transition hover:bg-white hover:shadow-card"
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white opacity-60 grayscale"
                style={avatarStyle(org.id)}
              >
                {abbr(org.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-600">
                {org.name}
              </span>
              <StageBadge stage={org.stage} />
              <ActivityTime
                iso={lastActivityAt}
                now={now}
                className="hidden sm:inline"
              />
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------- 시각 ----------

/** 상대 시각을 1분마다 다시 그린다. 개요는 Event가 올 때만 다시 불러오므로 시계는 따로 둔다. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

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

export function NoOrganizations() {
  const openCreate = useOpenCreateOrganization();
  return (
    <div className="card animate-fade-up mx-auto mt-16 max-w-sm p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-xl">
        🧭
      </div>
      <div className="font-semibold">아직 연구 조직이 없습니다</div>
      <button className="btn-primary mt-5" onClick={openCreate}>
        ＋ 새 연구 조직
      </button>
    </div>
  );
}
