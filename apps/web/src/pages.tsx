import { isClosedStage } from "@babojubot/contracts";
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
} from "./api.ts";
import { LeadChat } from "./chat.tsx";
import {
  DashboardCharts,
  DashboardMetrics,
  RecentActivity,
  RunningAgents,
} from "./dashboard.tsx";
import { Markdown } from "./markdown.tsx";
import { ResultReviewScreen } from "./results.tsx";
import { SettingsScreen } from "./settings.tsx";
import { defaultSection, findSection } from "./shell.tsx";
import { TasksScreen } from "./tasks.tsx";
import {
  approvalKindLabel,
  ApprovalStatusBadge,
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

/** 조직 화면. 대화 하나를 여는 주소(`/chat/:conversationId`)는 섹션이 경로에 없어 `section`으로 받는다. */
export function OrganizationScreen({ section: fixed }: { section?: string }) {
  const params = useParams();
  const { orgId = "", conversationId } = params;
  const section = fixed ?? params.section ?? defaultSection;
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
        <LeadChat orgId={orgId} lead={lead} conversationId={conversationId} />
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
              <dd className="min-w-0">
                <Markdown text={org.goal} data-testid="goal" />
              </dd>
              <dt className="text-slate-500">완료 기준</dt>
              <dd className="min-w-0">
                <Markdown
                  text={org.completionCriteria ?? ""}
                  data-testid="completion-criteria"
                />
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
