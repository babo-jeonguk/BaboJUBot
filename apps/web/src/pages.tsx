import {
  activeRunCount,
  isClosedStage,
  lifecycleStages,
} from "@babojubot/contracts";
import { lazy, Suspense, useState } from "react";
import { Link, useParams } from "react-router";
import type {
  OrganizationCommand,
  OrganizationDetail,
} from "@babojubot/contracts";
import { ActivityScreen } from "./activity.tsx";
import { AgentsScreen } from "./agents.tsx";
import {
  ApiError,
  useApprovals,
  useControlOrganization,
  useResultSubmissions,
  useOrganization,
  useOrganizations,
  useOverview,
} from "./api.ts";
import { LeadChat } from "./chat.tsx";
import {
  DashboardCharts,
  DashboardMetrics,
  RecentActivity,
  RunningAgents,
  RunningCountText,
} from "./dashboard.tsx";
import { useOpenCreateOrganization } from "./create-organization.tsx";
import { ResultReviewScreen } from "./results.tsx";
import { SettingsScreen } from "./settings.tsx";
import { defaultSection, findSection } from "./shell.tsx";
import { TasksScreen } from "./tasks.tsx";
import {
  abbr,
  approvalKindLabel,
  ApprovalStatusBadge,
  avatarStyle,
  formatTime,
  Loading,
  LoadError,
  NotFound,
  Page,
  StageBadge,
  stageLabel,
} from "./ui.tsx";

/** 연구 지도는 React Flow·Dagre를 쓰므로 그 화면을 열 때만 불러온다. */
const ResearchMapScreen = lazy(() =>
  import("./research-map.tsx").then((m) => ({ default: m.ResearchMapScreen }))
);

// ---------- 홈: 전체 조직 개요 ----------

export function Home() {
  const orgs = useOrganizations();
  const overview = useOverview();
  const openCreate = useOpenCreateOrganization();
  if (orgs.isPending) return <Loading />;
  if (orgs.isError)
    return <LoadError what="조직 목록" onRetry={() => void orgs.refetch()} />;
  if (!orgs.data.length) return <NoOrganizations />;
  return (
    <Page width="full">
      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div className="card px-4 py-3">
          <div className="text-[13px] text-slate-500">연구 조직</div>
          <div
            className="text-2xl font-semibold"
            data-testid="organization-count"
          >
            {orgs.data.length}
          </div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[13px] text-slate-500">실행 중</div>
          {overview.data ? (
            <>
              <div
                className="text-2xl font-semibold tabular-nums"
                data-testid="running-run-count"
              >
                {activeRunCount(overview.data.runs)}
              </div>
              {overview.data.runs.cancelling > 0 && (
                <div
                  className="text-xs text-amber-700"
                  data-testid="cancelling-run-count"
                >
                  취소 정리 중 {overview.data.runs.cancelling}
                </div>
              )}
            </>
          ) : overview.isError ? (
            <button
              role="alert"
              className="text-sm text-rose-700 underline underline-offset-2"
              onClick={() => void overview.refetch()}
            >
              불러오지 못함 · 다시 시도
            </button>
          ) : (
            <div className="text-2xl font-semibold text-slate-300" aria-busy>
              …
            </div>
          )}
        </div>
        <button className="btn-primary ml-auto" onClick={openCreate}>
          ＋ 새 연구 조직
        </button>
      </div>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-4">
        {lifecycleStages.map((stage) => {
          const xs = orgs.data.filter((o) => o.stage === stage);
          if (!xs.length)
            return (
              <div
                key={stage}
                className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-xl border border-dashed border-slate-200 py-3 text-[11px] text-slate-400"
                title={`${stageLabel[stage]} · 0`}
              >
                <span className="[writing-mode:vertical-rl]">
                  {stageLabel[stage]}
                </span>
                <span>0</span>
              </div>
            );
          return (
            <section
              key={stage}
              aria-label={stageLabel[stage]}
              className="w-60 shrink-0 rounded-2xl bg-slate-200/40 p-2"
            >
              <div className="mb-2 flex items-center gap-2 px-1">
                <StageBadge stage={stage} />
                <span className="text-xs text-slate-400">{xs.length}</span>
              </div>
              <div className="space-y-2">
                {xs.map((o) => {
                  const runs = overview.data?.organizations.find(
                    (r) => r.organizationId === o.id
                  );
                  return (
                    <Link
                      key={o.id}
                      to={`/orgs/${o.id}`}
                      className="card card-hover block p-3 text-sm"
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white"
                          style={avatarStyle(o.id)}
                        >
                          {abbr(o.name)}
                        </span>
                        <div className="line-clamp-3 font-medium text-slate-800">
                          {o.name}
                        </div>
                      </div>
                      {runs && runs.running > 0 && (
                        <div
                          className="mt-2 text-xs text-brand-700 tabular-nums"
                          data-testid="organization-running"
                        >
                          <RunningCountText count={runs} />
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </Page>
  );
}

function NoOrganizations() {
  const openCreate = useOpenCreateOrganization();
  return (
    <div className="card animate-fade-up mx-auto mt-10 max-w-md p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-xl">
        🧭
      </div>
      <div className="font-semibold">아직 연구 조직이 없습니다</div>
      <button className="btn-primary mt-4" onClick={openCreate}>
        ＋ 새 연구 조직
      </button>
    </div>
  );
}

// ---------- 조직 화면 ----------

/**
 * 조직 전체의 일시정지·재개·중단. 서버가 확정한 단계만 보이고, 요청 중에는 버튼을 잠근다.
 * 중단은 되돌릴 수 없으므로 한 번 더 확인한다. 최종 완료·중단 조직에서는 버튼을 보이되 누를 수 없다.
 */
function OrganizationControl({ org }: { org: OrganizationDetail }) {
  const control = useControlOrganization(org.id);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const closed = isClosedStage(org.stage);
  const paused = org.stage === "paused";
  const busy = closed || control.isPending;
  const send = (command: OrganizationCommand) =>
    control.mutate(command, { onSettled: () => setConfirmingStop(false) });
  return (
    <section
      aria-label="조직 제어"
      aria-busy={control.isPending || undefined}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      {paused ? (
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => send("resume")}
        >
          ▶ 재개
        </button>
      ) : (
        <button
          className="btn-soft"
          disabled={busy}
          onClick={() => send("pause")}
        >
          ⏸ 일시정지
        </button>
      )}
      {!confirmingStop ? (
        <button
          className="btn-danger"
          disabled={busy}
          onClick={() => setConfirmingStop(true)}
        >
          ⏹ 중단…
        </button>
      ) : (
        <span
          role="group"
          aria-label="조직 중단 확인"
          className="flex flex-wrap items-center gap-2 rounded-xl bg-rose-50 px-2 py-1"
        >
          <span className="text-xs text-rose-700">
            되돌릴 수 없습니다. 중단할까요?
          </span>
          <button
            className="btn-danger"
            disabled={busy}
            onClick={() => send("stop")}
          >
            중단 확정
          </button>
          <button
            className="btn-ghost"
            disabled={control.isPending}
            onClick={() => setConfirmingStop(false)}
          >
            취소
          </button>
        </span>
      )}
      {!control.isPending && control.isError && (
        <p role="alert" className="w-full text-xs text-rose-600">
          {control.error instanceof ApiError &&
          control.error.code === "organization_closed"
            ? "이미 끝난 조직입니다."
            : "처리하지 못했습니다. 다시 시도하세요."}
        </p>
      )}
    </section>
  );
}

export function OrganizationScreen() {
  const { orgId = "", section = defaultSection } = useParams();
  const org = useOrganization(orgId);
  if (org.isPending) return <Loading />;
  if (org.isError)
    return org.error instanceof ApiError && org.error.status === 404 ? (
      <NotFound what="조직" />
    ) : (
      <LoadError what="조직" onRetry={() => void org.refetch()} />
    );
  const current = findSection(section);
  if (!current) return <NotFound what="화면" />;
  const { label, width } = current;
  const { agents } = org.data;
  const lead = agents.find((a) => a.role === "lead");
  if (section === "chat" && lead)
    return (
      <Page width={width} fill>
        <LeadChat orgId={orgId} lead={lead} />
      </Page>
    );
  if (section === "activity")
    return (
      <Page width={width}>
        <ActivityScreen orgId={orgId} agents={agents} />
      </Page>
    );
  if (section === "tasks")
    return (
      <Page width={width}>
        <TasksScreen orgId={orgId} agents={agents} />
      </Page>
    );
  if (section === "map")
    return (
      <Page width={width} className="flex flex-1 flex-col">
        <Suspense fallback={<Loading />}>
          <ResearchMapScreen
            orgId={orgId}
            stage={org.data.stage}
            agents={agents}
          />
        </Suspense>
      </Page>
    );
  if (section === "review")
    return (
      <Page width={width}>
        <ResultReviewScreen orgId={orgId} stage={org.data.stage} />
      </Page>
    );
  if (section === "agents")
    return (
      <Page width={width}>
        <AgentsScreen orgId={orgId} agents={agents} />
      </Page>
    );
  if (section === "dashboard")
    return (
      <Page width={width}>
        <OrganizationDashboard org={org.data} />
      </Page>
    );
  if (section === "settings")
    return (
      <Page width={width}>
        <SettingsScreen org={org.data} />
      </Page>
    );
  return (
    <Page width={width}>
      <div className="card animate-fade-up p-6">
        <h1 className="text-lg font-semibold">{label}</h1>
        <p className="mt-2 text-sm text-slate-500">준비 중</p>
      </div>
    </Page>
  );
}

/**
 * 조직 › 대시보드: 단계와 조직 제어(일시정지·재개·중단), 결정을 기다리는 승인 요청·결과 제출, 지표·14일 차트·최근 활동,
 * 연구 목표·완료 기준, 실행 중인 에이전트, 팀과 연구 흐름 템플릿, 승인 이력.
 */
function OrganizationDashboard({ org }: { org: OrganizationDetail }) {
  const approvals = useApprovals(org.id);
  const results = useResultSubmissions(org.id);
  const pending = approvals.data?.filter((a) => a.status === "pending") ?? [];
  const pendingResult = results.data?.find((r) => r.status === "pending");
  const workers = org.agents.filter((a) => a.role === "worker").length;
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{org.name}</h1>
          <span
            data-testid="org-stage"
            title={
              org.stage === "paused" && org.pausedFrom
                ? `${stageLabel[org.pausedFrom]}에서 멈춤`
                : undefined
            }
          >
            <StageBadge stage={org.stage} />
          </span>
          <div className="ml-auto">
            <OrganizationControl org={org} />
          </div>
        </div>
        {pending.map((a) => (
          <Link
            key={a.id}
            to={`/orgs/${org.id}/approvals/${a.id}`}
            className="card card-hover flex items-center gap-3 p-4 ring-2 ring-amber-200"
          >
            <span className="text-xl">📝</span>
            <div className="min-w-0 flex-1 font-medium">
              {approvalKindLabel[a.kind]}
            </div>
            <span className="text-sm text-brand-600">검토하기 →</span>
          </Link>
        ))}
        {pendingResult && (
          <Link
            to={`/orgs/${org.id}/results/${pendingResult.id}`}
            className="card card-hover flex items-center gap-3 p-4 ring-2 ring-amber-200"
          >
            <span className="text-xl">📦</span>
            <div className="min-w-0 flex-1 font-medium">결과 제출</div>
            <span className="text-sm text-brand-600">검토하기 →</span>
          </Link>
        )}
        <DashboardMetrics orgId={org.id} />
        <DashboardCharts orgId={org.id} />
        <RecentActivity org={org} />
        <section aria-label="연구 목표" className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-600">
            연구 목표와 완료 기준
          </h2>
          {org.goal ? (
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[6rem_1fr]">
              <dt className="text-slate-500">연구 목표</dt>
              <dd
                className="break-words whitespace-pre-wrap"
                data-testid="goal"
              >
                {org.goal}
              </dd>
              <dt className="text-slate-500">완료 기준</dt>
              <dd
                className="break-words whitespace-pre-wrap"
                data-testid="completion-criteria"
              >
                {org.completionCriteria}
              </dd>
            </dl>
          ) : (
            <Link
              to={`/orgs/${org.id}/chat`}
              className="text-sm text-brand-600 hover:underline"
            >
              Lead 대화에서 정하기 →
            </Link>
          )}
        </section>
      </div>
      <div className="space-y-4">
        <RunningAgents org={org} />
        <section aria-label="팀" className="card p-4 text-sm">
          <h2 className="mb-2 font-semibold text-slate-600">팀</h2>
          <Link
            to={`/orgs/${org.id}/agents`}
            className="text-brand-600 hover:underline"
          >
            Research Lead · 작업자 {workers}명
          </Link>
        </section>
        <section aria-label="승인 요청 이력" className="card text-sm">
          <h2 className="px-4 pt-4 pb-2 font-semibold text-slate-600">
            승인 요청
          </h2>
          {approvals.isPending ? (
            <Loading />
          ) : approvals.isError ? (
            <LoadError
              what="승인 요청"
              onRetry={() => void approvals.refetch()}
            />
          ) : !approvals.data.length ? (
            <p className="px-4 pb-4 text-slate-500">아직 없습니다.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {approvals.data.map((a) => (
                <li key={a.id}>
                  <Link
                    to={`/orgs/${org.id}/approvals/${a.id}`}
                    className="flex items-center gap-2 px-4 py-2.5 transition hover:bg-slate-50"
                  >
                    <ApprovalStatusBadge status={a.status} />
                    <span className="truncate text-slate-700">
                      {approvalKindLabel[a.kind]}
                    </span>
                    <span className="ml-auto text-xs text-slate-400 tabular-nums">
                      {formatTime(a.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
