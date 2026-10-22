import {
  heartbeatIntervalMaxMinutes,
  isClosedStage,
  type Agent,
  type AgentDetail,
  type InstructionKind,
  type LifecycleStage,
  type RunSummary,
  type WakeReason,
} from "@babojubot/contracts";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { EventRow } from "./activity.tsx";
import {
  ApiError,
  useAgent,
  useAgentInstructions,
  useControlAgent,
  useOrganization,
  useRun,
  useUpdateHeartbeat,
} from "./api.ts";
import {
  abbr,
  AgentStatusBadge,
  approvalKindLabel,
  avatarStyle,
  decisionLabel,
  formatTime,
  Loading,
  LoadError,
  NotFound,
  Page,
  PausedBadge,
  runLabel,
  runStatusLabel,
  RunStatusBadge,
} from "./ui.tsx";

const roleLabel = { lead: "Research Lead", worker: "작업자" } as const;

/** 조직 › 에이전트: Lead·작업자 팀과 상태. 작업자는 초기 연구 승인 때 생기고, 연구 진행 중 Lead가 더한다. */
export function AgentsScreen({
  orgId,
  agents,
}: {
  orgId: string;
  agents: Agent[];
}) {
  const leads = agents.filter((a) => a.role === "lead");
  const workers = agents.filter((a) => a.role === "worker");
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">에이전트</h1>
      <section aria-label="Research Lead" className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">
          Research Lead
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {leads.map((a) => (
            <AgentCard key={a.id} orgId={orgId} agent={a} />
          ))}
        </ul>
      </section>
      <section aria-label="작업자 팀">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">
          작업자 팀 {workers.length}명
        </h2>
        {!workers.length ? (
          <div className="card p-6 text-sm text-slate-500">
            아직 작업자가 없습니다. 초기 연구 승인 요청을 승인하면 제안된 팀이
            생깁니다.
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {workers.map((a) => (
              <AgentCard key={a.id} orgId={orgId} agent={a} />
            ))}
          </ul>
        )}
      </section>
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
        <span className="flex flex-col items-end gap-1">
          {detail.data && <AgentStatusBadge status={detail.data.status} />}
          {detail.data?.paused && <PausedBadge />}
        </span>
      </Link>
    </li>
  );
}

/** 조직 › 에이전트 › <에이전트>: 상태·일시정지·재개와 최근 실행 시도. 각 실행 시도는 상세로 이어진다. */
export function AgentDetailPage() {
  const { orgId = "", agentId = "" } = useParams();
  const agent = useAgent(orgId, agentId);
  const stage = useOrganization(orgId).data?.stage;
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
          <div className="flex items-center gap-1.5">
            <AgentStatusBadge status={a.status} />
            {a.paused && <PausedBadge />}
          </div>
          {live && (
            <Link
              to={`/orgs/${orgId}/runs/${live.id}`}
              className="flex items-center gap-1.5 text-xs text-brand-600 hover:underline"
            >
              {runLabel(live.id)} 보기
              {live.cancelReason && (
                <RunStatusBadge
                  status={live.status}
                  cancelReason={live.cancelReason}
                />
              )}
            </Link>
          )}
        </div>
      </div>
      <AgentControl orgId={orgId} agent={a} stage={stage} />
      <HeartbeatSettings orgId={orgId} agent={a} stage={stage} />
      <InstructionCopies key={a.id} orgId={orgId} agentId={a.id} />
      <section aria-label="최근 실행 시도">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">
          최근 실행 시도
        </h2>
        {!a.recentRuns.length ? (
          <div className="card p-6 text-sm text-slate-500">
            아직 실행 시도가 없습니다.{" "}
            {a.role === "lead"
              ? "Lead 대화에 메시지를 보내면 깨어납니다."
              : "작업을 맡거나 작업 댓글·메시지를 받으면 깨어납니다."}
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

/**
 * 에이전트 일시정지·재개. 이 에이전트 하나에만 걸리며 조직 일시정지와 따로다(조직을 재개해도 풀리지 않는다).
 * 서버가 확정한 상태만 보이고, 요청 중에는 버튼을 잠근다. 끝난 조직에서는 버튼을 보이되 누를 수 없다.
 */
function AgentControl({
  orgId,
  agent,
  stage,
}: {
  orgId: string;
  agent: AgentDetail;
  stage: LifecycleStage | undefined;
}) {
  const control = useControlAgent(orgId, agent.id);
  const closed = stage !== undefined && isClosedStage(stage);
  const command = agent.paused ? "resume" : "pause";
  return (
    <section aria-label="에이전트 제어" className="card mb-6 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-soft"
          disabled={closed || control.isPending}
          onClick={() => control.mutate(command)}
        >
          {agent.paused ? "▶ 에이전트 재개" : "⏸ 에이전트 일시정지"}
        </button>
        {control.isPending && (
          <span role="status" className="text-xs text-slate-500">
            요청하는 중…
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {closed
          ? "끝난 조직의 에이전트는 일시정지·재개할 수 없습니다."
          : agent.paused
            ? "이 에이전트만 멈춰 있습니다. 그동안 받은 깨우기는 재개하면 실행 시도 하나로 전달됩니다. 조직을 재개해도 풀리지 않습니다."
            : "이 에이전트 하나만 멈춥니다. 진행 중 실행 시도는 취소하고, 다른 에이전트는 계속 일합니다."}
      </p>
      {!control.isPending && control.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {control.error instanceof ApiError &&
          control.error.code === "organization_closed"
            ? "조직이 이미 끝나 명령을 받지 않았습니다."
            : "명령을 처리하지 못했습니다. 상태는 그대로이니 다시 시도하세요."}
        </p>
      )}
    </section>
  );
}

/**
 * 에이전트 heartbeat: 켜기·끄기와 간격(분), 서버가 정한 다음 heartbeat. 고치는 동안의 값은 지역 상태에 두고,
 * 고치지 않을 때는 서버 값(다른 탭의 변경 포함)을 그대로 보인다. 저장에 실패하면 입력을 그대로 두고 저장된 값을 함께 알린다.
 * 다음 heartbeat는 서버가 깨우기를 만드는 예정 시각이며 실행 시도 시작을 보장하지 않는다.
 */
function HeartbeatSettings({
  orgId,
  agent,
  stage,
}: {
  orgId: string;
  agent: AgentDetail;
  stage: LifecycleStage | undefined;
}) {
  const update = useUpdateHeartbeat(orgId, agent.id);
  const saved = agent.heartbeat;
  const [draft, setDraft] = useState<{
    enabled: boolean;
    interval: string;
  } | null>(null);
  const enabled = draft?.enabled ?? saved.enabled;
  const interval = draft?.interval ?? String(saved.intervalMinutes);
  const minutes = Number(interval);
  const valid =
    /^\d+$/.test(interval) &&
    minutes >= 1 &&
    minutes <= heartbeatIntervalMaxMinutes;
  const changed =
    enabled !== saved.enabled ||
    (valid && minutes !== saved.intervalMinutes) ||
    !valid;
  const closed = stage !== undefined && isClosedStage(stage);
  const held = agent.paused || stage === "paused";
  const edit = (next: Partial<{ enabled: boolean; interval: string }>) =>
    setDraft({ enabled, interval, ...next });
  const save = () =>
    update.mutate(
      { enabled, intervalMinutes: minutes },
      { onSuccess: () => setDraft(null) }
    );
  const status = () => {
    if (closed) return "끝난 조직이라 heartbeat로 깨우지 않습니다.";
    if (!saved.enabled || !saved.nextAt) return "꺼져 있습니다.";
    const next = `다음 heartbeat ${formatTime(saved.nextAt)} · ${saved.intervalMinutes}분마다`;
    return held
      ? `${next}. 일시정지 중이라 깨우지 않으며, 재개 뒤 예정이 지나 있으면 한 번 깨웁니다.`
      : next;
  };
  return (
    <section aria-label="Heartbeat" className="card mb-6 p-4 text-sm">
      <h2 className="mb-1 text-sm font-semibold">Heartbeat</h2>
      <p className="mb-3 text-xs text-slate-500">
        사건이 없어도 간격마다 이 에이전트를 깨웁니다. 깨울 때 기다리는 다른
        깨우기가 있으면 실행 시도 하나로 합칩니다.
      </p>
      <form
        className="flex flex-wrap items-end gap-x-4 gap-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && changed && !closed) save();
        }}
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand-600"
            checked={enabled}
            disabled={closed || update.isPending}
            onChange={(e) => edit({ enabled: e.currentTarget.checked })}
          />
          <span className="font-medium">heartbeat 켜기</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">간격(분)</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={heartbeatIntervalMaxMinutes}
            step={1}
            className="w-28 rounded-xl bg-slate-50 px-3 py-1.5 text-sm tabular-nums ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400 disabled:opacity-60 aria-[invalid=true]:ring-rose-400"
            value={interval}
            disabled={closed || update.isPending}
            aria-invalid={!valid}
            aria-describedby="heartbeat-interval-help"
            onChange={(e) => edit({ interval: e.currentTarget.value })}
          />
        </label>
        <button
          type="submit"
          className="btn-soft"
          disabled={closed || update.isPending || !valid || !changed}
        >
          {update.isPending ? "저장하는 중…" : "저장"}
        </button>
        {draft && !update.isPending && (
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-800"
            onClick={() => {
              setDraft(null);
              update.reset();
            }}
          >
            되돌리기
          </button>
        )}
      </form>
      <p id="heartbeat-interval-help" className="mt-2 text-xs text-slate-500">
        {valid
          ? `Role 기본값 ${saved.roleDefaultMinutes}분. 켜거나 간격을 바꾸면 그때부터 간격만큼 뒤에 깨웁니다.`
          : `간격은 1분부터 ${heartbeatIntervalMaxMinutes}분(7일)까지 분 단위 정수로 적으세요.`}
      </p>
      <p role="status" className="mt-2 text-xs text-slate-700">
        {status()}
      </p>
      {!update.isPending && update.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {update.error instanceof ApiError &&
          update.error.code === "organization_closed"
            ? "조직이 이미 끝나 설정을 바꾸지 않았습니다."
            : `저장하지 못했습니다. 저장된 설정(${saved.enabled ? `켜짐, ${saved.intervalMinutes}분` : "꺼짐"})은 그대로이니 다시 시도하세요.`}
        </p>
      )}
    </section>
  );
}

const kindLabel: Record<InstructionKind, string> = {
  role: "Role",
  soul: "Soul",
  skill: "Skill",
};

/**
 * 에이전트 상세 › Role·Soul·Skill 사본. 이 에이전트가 소유한 사본을 읽기 전용으로 보인다.
 * 편집·revision은 후속 이슈(#64)에서 연다. 에이전트가 바뀌면 key로 선택을 초기화한다.
 */
function InstructionCopies({
  orgId,
  agentId,
}: {
  orgId: string;
  agentId: string;
}) {
  const found = useAgentInstructions(orgId, agentId);
  const [selected, setSelected] = useState(0);
  const body = () => {
    if (found.isPending) return <Loading />;
    if (found.isError)
      return (
        <LoadError
          what="Role·Soul·Skill 사본"
          onRetry={() => void found.refetch()}
        />
      );
    const { copies, bundleVersion } = found.data;
    if (!copies.length)
      return (
        <div className="card p-6 text-sm text-slate-500">
          이 에이전트에게는 사본이 없습니다. 사본이 생기기 전에 만든 에이전트일
          수 있습니다.
        </div>
      );
    const copy = copies[Math.min(selected, copies.length - 1)]!;
    return (
      <div className="card overflow-hidden">
        <div
          role="tablist"
          aria-label="사본 파일"
          className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-slate-100 px-2 pt-2"
        >
          {copies.map((c, i) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === copy.id}
              onClick={() => setSelected(i)}
              className={`shrink-0 rounded-t-lg px-3 py-1.5 text-xs transition ${c.id === copy.id ? "bg-slate-100 font-semibold text-slate-900" : "text-slate-500 hover:text-slate-800"}`}
            >
              {kindLabel[c.kind]} · {c.path}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={copy.path}>
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-3 text-xs text-slate-500">
            <dt>사본</dt>
            <dd className="font-mono break-all" data-testid="copy-id">
              {copy.id}
            </dd>
            <dt>복사한 원본</dt>
            <dd className="font-mono break-all">
              harness/{copy.source} · {copy.sourceDigest.slice(0, 12)}
            </dd>
            <dt>지침 bundle</dt>
            <dd className="font-mono break-all">
              {bundleVersion?.slice(0, 19) ?? "없음"}
            </dd>
          </dl>
          {copy.content ? (
            <pre className="max-h-[28rem] overflow-auto px-4 py-3 font-sans text-sm break-words whitespace-pre-wrap text-slate-800">
              {copy.content}
            </pre>
          ) : (
            <p className="px-4 py-3 text-sm text-slate-400">빈 파일</p>
          )}
        </div>
      </div>
    );
  };
  return (
    <section aria-label="Role·Soul·Skill 사본" className="mb-6">
      <h2 className="mb-1 text-sm font-semibold text-slate-600">
        Role·Soul·Skill 사본
      </h2>
      <p className="mb-2 text-xs text-slate-400">
        이 에이전트만의 사본입니다. 같은 Role의 다른 에이전트와 공유하지 않으며
        여기서는 읽기만 합니다.
      </p>
      {body()}
    </section>
  );
}

function RunRow({ orgId, run }: { orgId: string; run: RunSummary }) {
  return (
    <li>
      <Link
        to={`/orgs/${orgId}/runs/${run.id}`}
        className="flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-slate-50"
      >
        <RunStatusBadge status={run.status} cancelReason={run.cancelReason} />
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
        <RunStatusBadge status={r.status} cancelReason={r.cancelReason} />
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
            <WakeReasonRow key={w.wakeId} orgId={orgId} reason={w} />
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

function WakeReasonRow({
  orgId,
  reason,
}: {
  orgId: string;
  reason: WakeReason;
}) {
  const row = (label: string, body: ReactNode, detail?: string | null) => (
    <li className="px-4 py-2.5 text-sm">
      <div className="text-xs text-slate-400">{label}</div>
      {body}
      {detail && (
        <div className="mt-0.5 break-words whitespace-pre-wrap">{detail}</div>
      )}
    </li>
  );
  const link = (to: string, text: string) => (
    <Link to={to} className="text-brand-600 hover:underline">
      {text}
    </Link>
  );
  const task = (taskId: string) => `/orgs/${orgId}/tasks/${taskId}`;
  switch (reason.kind) {
    case "owner_message":
      return row(
        "사용자 메시지",
        <div className="break-words whitespace-pre-wrap">{reason.body}</div>
      );
    case "approval_decision":
      return row(
        "승인 결정",
        link(
          `/orgs/${orgId}/approvals/${reason.approvalId}`,
          `${approvalKindLabel[reason.approvalKind]} ${decisionLabel[reason.decision]}`
        ),
        reason.note
      );
    case "task_assigned":
      return row("작업 할당", link(task(reason.taskId), reason.title));
    case "task_completed":
      return row(
        "작업 완료 · 자기 보고",
        link(task(reason.taskId), reason.title),
        reason.summary
      );
    case "task_comment":
      return row(
        "사용자 작업 댓글",
        link(task(reason.taskId), "작업 보기"),
        reason.body
      );
    case "agent_to_agent_message":
      return row(
        "같은 조직 에이전트 메시지",
        link(`/orgs/${orgId}/agents/${reason.senderAgentId}`, "보낸 에이전트"),
        reason.body
      );
    case "research_map_edit":
      return row(
        "사용자 연구 지도 편집",
        reason.nodeId ? (
          link(`/orgs/${orgId}/map?node=${reason.nodeId}`, "지도에서 보기")
        ) : (
          <span className="text-slate-500">연구 지도</span>
        ),
        reason.summary
      );
    case "result_changes_requested":
      return row(
        "결과 수정 요청",
        link(`/orgs/${orgId}/results/${reason.submissionId}`, "제출 보기"),
        reason.note
      );
    case "heartbeat":
      return row(
        "Heartbeat",
        <span className="text-slate-700">heartbeat 간격이 지났습니다</span>
      );
  }
}
