import type { Agent, RunSummary } from "@babojubot/contracts";
import { Link, useParams } from "react-router";
import { EventRow } from "./activity.tsx";
import { ApiError, useAgent, useOrganization, useRun } from "./api.ts";
import {
  abbr,
  AgentStatusBadge,
  avatarStyle,
  formatTime,
  Loading,
  LoadError,
  NotFound,
  Page,
  runLabel,
  runStatusLabel,
  RunStatusBadge,
} from "./ui.tsx";

const roleLabel = { lead: "Research Lead", worker: "작업자" } as const;

/** 조직 › 에이전트: Lead·작업자 팀과 상태. 첫 판에는 Lead만 있다. */
export function AgentsScreen({
  orgId,
  agents,
}: {
  orgId: string;
  agents: Agent[];
}) {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">에이전트</h1>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => (
          <AgentCard key={a.id} orgId={orgId} agent={a} />
        ))}
      </ul>
    </>
  );
}

function AgentCard({ orgId, agent }: { orgId: string; agent: Agent }) {
  const detail = useAgent(orgId, agent.id);
  return (
    <li>
      <Link
        to={`/orgs/${orgId}/agents/${agent.id}`}
        className="card card-hover flex items-center gap-3 p-4"
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold text-white"
          style={avatarStyle(agent.id)}
        >
          {abbr(agent.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{agent.name}</div>
          <div className="text-xs text-slate-500">{roleLabel[agent.role]}</div>
        </div>
        {detail.data && <AgentStatusBadge status={detail.data.status} />}
      </Link>
    </li>
  );
}

/** 조직 › 에이전트 › <에이전트>: 상태와 최근 실행 시도. 각 실행 시도는 상세로 이어진다. */
export function AgentDetailPage() {
  const { orgId = "", agentId = "" } = useParams();
  const agent = useAgent(orgId, agentId);
  if (agent.isPending) return <Loading />;
  if (agent.isError)
    return agent.error instanceof ApiError && agent.error.status === 404 ? (
      <NotFound what="에이전트" />
    ) : (
      <LoadError what="에이전트" onRetry={() => void agent.refetch()} />
    );
  const a = agent.data;
  const live = a.recentRuns.find((r) => r.status === "running");
  return (
    <Page width="standard">
      <div className="mb-6 flex items-center gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-base font-semibold text-white"
          style={avatarStyle(a.id)}
        >
          {abbr(a.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{a.name}</h1>
          <div className="text-sm text-slate-500">{roleLabel[a.role]}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <AgentStatusBadge status={a.status} />
          {live && (
            <Link
              to={`/orgs/${orgId}/runs/${live.id}`}
              className="text-xs text-brand-600 hover:underline"
            >
              {runLabel(live.id)} 보기
            </Link>
          )}
        </div>
      </div>
      <section aria-label="최근 실행 시도">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">
          최근 실행 시도
        </h2>
        {!a.recentRuns.length ? (
          <div className="card p-6 text-sm text-slate-500">
            아직 실행 시도가 없습니다. Lead 대화에 메시지를 보내면 깨어납니다.
          </div>
        ) : (
          <ul className="card divide-y divide-slate-100">
            {a.recentRuns.map((r) => (
              <RunRow key={r.id} orgId={orgId} run={r} />
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

function RunRow({ orgId, run }: { orgId: string; run: RunSummary }) {
  return (
    <li>
      <Link
        to={`/orgs/${orgId}/runs/${run.id}`}
        className="flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-slate-50"
      >
        <RunStatusBadge status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-800">{runLabel(run.id)}</div>
          <div className="truncate text-xs text-slate-500">
            깨우기 {run.wakeCount}개
            {(run.error ?? run.summary) && ` · ${run.error ?? run.summary}`}
          </div>
        </div>
        <time
          dateTime={run.startedAt}
          className="shrink-0 text-xs text-slate-400 tabular-nums"
        >
          {formatTime(run.startedAt)}
        </time>
      </Link>
    </li>
  );
}

/** 조직 › 실행 시도 상세: 깨우기 사유, 공개 활동 transcript, 종료 사유와 요약. */
export function RunDetailPage() {
  const { orgId = "", runId = "" } = useParams();
  const run = useRun(orgId, runId);
  const org = useOrganization(orgId);
  if (run.isPending) return <Loading />;
  if (run.isError)
    return run.error instanceof ApiError && run.error.status === 404 ? (
      <NotFound what="실행 시도" />
    ) : (
      <LoadError what="실행 시도" onRetry={() => void run.refetch()} />
    );
  const r = run.data;
  const agents = org.data?.agents ?? [];
  const agent = agents.find((a) => a.id === r.agentId);
  return (
    <Page width="standard">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{runLabel(r.id)}</h1>
        <RunStatusBadge status={r.status} />
        <div className="w-full text-sm text-slate-500">
          <Link
            to={`/orgs/${orgId}/agents/${r.agentId}`}
            className="hover:text-slate-800 hover:underline"
          >
            {agent?.name ?? "에이전트"}
          </Link>
          {" · "}
          {formatTime(r.startedAt)} 시작
          {r.finishedAt && ` · ${formatTime(r.finishedAt)} 종료`}
        </div>
      </div>

      <section aria-label="깨우기 사유" className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">
          깨우기 사유 {r.wakeReasons.length}개
        </h2>
        <ol className="card divide-y divide-slate-100">
          {r.wakeReasons.map((w) => (
            <li key={w.wakeId} className="px-4 py-2.5 text-sm">
              <div className="text-xs text-slate-400">사용자 메시지</div>
              <div className="break-words whitespace-pre-wrap">{w.body}</div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="활동" className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">
          활동 transcript
        </h2>
        <p className="mb-2 text-xs text-slate-400">
          실행기가 공개로 낸 활동과 조직 도구 호출 요약만 보입니다. 모델 내부
          추론은 담지 않습니다.
        </p>
        <ol className="card divide-y divide-slate-100">
          {r.transcript.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              orgId={orgId}
              agents={agents}
              showRunLink={false}
            />
          ))}
        </ol>
      </section>

      <section aria-label="종료">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">종료</h2>
        <dl className="card grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 p-4 text-sm">
          <dt className="text-slate-500">종료 사유</dt>
          <dd data-testid="run-stop-reason">
            {r.status === "running" ? "아직 실행 중" : runStatusLabel[r.status]}
          </dd>
          <dt className="text-slate-500">요약</dt>
          <dd className="break-words whitespace-pre-wrap">
            {r.summary ?? <span className="text-slate-400">없음</span>}
          </dd>
          {r.error && (
            <>
              <dt className="text-slate-500">오류</dt>
              <dd className="text-rose-700">{r.error}</dd>
            </>
          )}
          {r.usage && (
            <>
              <dt className="text-slate-500">사용량</dt>
              <dd className="tabular-nums">
                입력 {r.usage.inputTokens} · 출력 {r.usage.outputTokens} 토큰
                {r.usage.costUsd !== null && ` · $${r.usage.costUsd}`}
              </dd>
            </>
          )}
        </dl>
      </section>
    </Page>
  );
}
