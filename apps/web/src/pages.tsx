import { lifecycleStages } from "@babojubot/contracts";
import { lazy, Suspense } from "react";
import { Link, useParams } from "react-router";
import type { OrganizationDetail } from "@babojubot/contracts";
import { ActivityScreen } from "./activity.tsx";
import { AgentsScreen } from "./agents.tsx";
import {
  ApiError,
  useApprovals,
  useFlowTemplate,
  useResultSubmissions,
  useOrganization,
  useOrganizations,
} from "./api.ts";
import { approvalKindLabel } from "./approvals.tsx";
import { LeadChat } from "./chat.tsx";
import { useOpenCreateOrganization } from "./create-organization.tsx";
import { ResultReviewScreen } from "./results.tsx";
import { defaultSection, findSection } from "./shell.tsx";
import { TasksScreen } from "./tasks.tsx";
import {
  abbr,
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
                {xs.map((o) => (
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
                  </Link>
                ))}
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
      <p className="mt-1 text-sm text-slate-500">
        연구 목표 하나가 조직 하나가 됩니다.
      </p>
      <button className="btn-primary mt-4" onClick={openCreate}>
        ＋ 새 연구 조직
      </button>
    </div>
  );
}

// ---------- 조직 화면 ----------

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
      <Page width={width} className="flex flex-1 flex-col">
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
  return (
    <Page width={width}>
      <div className="card animate-fade-up p-6">
        <h1 className="text-lg font-semibold">{label}</h1>
        <p className="mt-2 text-sm text-slate-500">
          이 화면은 판 1의 후속 이슈에서 만듭니다.
        </p>
      </div>
    </Page>
  );
}

/** 조직 › 대시보드: 단계, 연구 목표·완료 기준, 결정을 기다리는 승인 요청·결과 제출과 승인 이력, 팀과 연구 흐름 템플릿. */
function OrganizationDashboard({ org }: { org: OrganizationDetail }) {
  const approvals = useApprovals(org.id);
  const results = useResultSubmissions(org.id);
  const template = useFlowTemplate(org.id);
  const pending = approvals.data?.find((a) => a.status === "pending");
  const pendingResult = results.data?.find((r) => r.status === "pending");
  const workers = org.agents.filter((a) => a.role === "worker").length;
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{org.name}</h1>
          <StageBadge stage={org.stage} />
        </div>
        {pending && (
          <Link
            to={`/orgs/${org.id}/approvals/${pending.id}`}
            className="card card-hover flex items-center gap-3 p-4 ring-2 ring-amber-200"
          >
            <span className="text-xl">📝</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {approvalKindLabel[pending.kind]}이 결정을 기다립니다
              </div>
              <div className="text-xs text-slate-500">
                계획·팀·연구 환경 명세를 검토하고 결정하세요.
              </div>
            </div>
            <span className="text-sm text-brand-600">검토하기 →</span>
          </Link>
        )}
        {pendingResult && (
          <Link
            to={`/orgs/${org.id}/results/${pendingResult.id}`}
            className="card card-hover flex items-center gap-3 p-4 ring-2 ring-amber-200"
          >
            <span className="text-xl">📦</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">제출된 결과가 검토를 기다립니다</div>
              <div className="text-xs text-slate-500">
                요약·완료 기준·근거 산출물을 보고 수정 요청 또는 최종 완료를
                결정하세요.
              </div>
            </div>
            <span className="text-sm text-brand-600">검토하기 →</span>
          </Link>
        )}
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
            <p className="text-sm text-slate-500">
              아직 기록되지 않았습니다.{" "}
              <Link
                to={`/orgs/${org.id}/chat`}
                className="text-brand-600 hover:underline"
              >
                Lead 대화
              </Link>
              에서 합의하면 Lead가 기록합니다.
            </p>
          )}
        </section>
      </div>
      <div className="space-y-4">
        <section aria-label="팀" className="card p-4 text-sm">
          <h2 className="mb-2 font-semibold text-slate-600">팀</h2>
          <Link
            to={`/orgs/${org.id}/agents`}
            className="text-brand-600 hover:underline"
          >
            Research Lead · 작업자 {workers}명
          </Link>
          <div className="mt-2 text-xs text-slate-500">
            연구 흐름 템플릿:{" "}
            {template.isPending
              ? "…"
              : template.isError
                ? "불러오지 못함"
                : (template.data?.label ?? "초기 연구 승인 뒤 정해집니다")}
          </div>
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
