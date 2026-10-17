import { lifecycleStages } from "@babojubot/contracts";
import { Link, useParams } from "react-router";
import { ApiError, useOrganization, useOrganizations } from "./api.ts";
import { useOpenCreateOrganization } from "./create-organization.tsx";
import { defaultSection, findSection } from "./shell.tsx";
import {
  abbr,
  avatarStyle,
  Loading,
  LoadError,
  NotFound,
  Page,
  StageBadge,
  stageLabel,
} from "./ui.tsx";

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
  if (section === "chat") {
    const lead = org.data.agents.find((a) => a.role === "lead");
    return (
      <Page width={width}>
        <h1 className="mb-1 text-xl font-semibold">Lead 대화</h1>
        <p className="mb-6 text-sm text-slate-500">{lead?.name}</p>
        <div
          className="card animate-fade-up p-8 text-center"
          data-testid="lead-chat-empty"
        >
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-xl">
            🎯
          </div>
          <div className="font-semibold">연구 목표와 완료 기준을 정하세요</div>
          <p className="mt-1 text-sm text-slate-500">
            Research Lead와 대화로 이 조직의 연구 목표와 완료 기준을 합의하는
            것부터 시작합니다.
          </p>
        </div>
      </Page>
    );
  }
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
