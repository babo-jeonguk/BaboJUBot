import {
  heartbeatIntervalMaxMinutes,
  heartbeatIntervalSchema,
  isClosedStage,
  type Agent,
  type AgentDetail,
  type InstructionEditor,
  type InstructionKind,
  type LifecycleStage,
  type RunSummary,
  type WakeReason,
} from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { Link, useBeforeUnload, useBlocker, useParams } from "react-router";
import { EventRow } from "./activity.tsx";
import { AgentNameEditor, FaceCustomizer } from "./agent-profile.tsx";
import {
  ApiError,
  useAgent,
  useAgentInstructions,
  useControlAgent,
  useEditInstructionCopy,
  useInstructionRevision,
  useInstructionRevisions,
  useOrganization,
  useRun,
  useUpdateHeartbeat,
} from "./api.ts";
import { Markdown } from "./markdown.tsx";
import {
  AgentStatusBadge,
  approvalKindLabel,
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

export const roleLabel = { lead: "Research Lead", worker: "작업자" } as const;

const OrgChart = lazy(() => import("./org-chart.tsx"));

/**
 * 조직 › 에이전트: Lead 아래 작업자 팀을 잇는 팀 그래프(org-chart.tsx). 카드마다 얼굴·이름·역할·상태가 보이고 누르면 상세로 간다.
 * 작업자는 초기 연구 승인 때 생기고, 연구 진행 중 Lead가 더한다.
 */
export function AgentsScreen({
  orgId,
  agents,
}: {
  orgId: string;
  agents: Agent[];
}) {
  const workers = agents.filter((a) => a.role === "worker").length;
  return (
    <section aria-label="조직도">
      <h1 className="mb-4 flex items-baseline gap-2 text-xl font-semibold">
        에이전트
        <span className="text-sm font-normal text-slate-500">
          작업자 {workers}명
        </span>
      </h1>
      <Suspense fallback={<Loading />}>
        <OrgChart orgId={orgId} agents={agents} />
      </Suspense>
    </section>
  );
}

/** 에이전트 상세의 탭. 주소가 탭을 정하므로 뒤로 가기·새로고침이 같은 탭을 연다(#50). */
const agentTabs = [
  { tab: "overview", label: "개요", path: "" },
  { tab: "instructions", label: "Role·Soul·Skill", path: "/instructions" },
] as const;
export type AgentTab = (typeof agentTabs)[number]["tab"];

/**
 * 조직 › 에이전트 › <에이전트>. 개요 탭은 상태·일시정지·재개·heartbeat와 최근 실행 시도(각각 상세로 이어짐),
 * Role·Soul·Skill 탭은 이 에이전트만의 사본 편집과 revision이다.
 */
export function AgentDetailPage({ tab }: { tab: AgentTab }) {
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
      <div className="mb-4 flex items-center gap-4">
        <FaceCustomizer orgId={orgId} agent={a} />
        <div className="min-w-0 flex-1">
          <AgentNameEditor key={a.name} orgId={orgId} agent={a} />
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
      <nav
        aria-label="에이전트 상세 탭"
        className="mb-6 flex gap-1 border-b border-slate-200"
      >
        {agentTabs.map((t) => (
          <Link
            key={t.tab}
            to={`/orgs/${orgId}/agents/${a.id}${t.path}`}
            aria-current={t.tab === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${t.tab === tab ? "border-brand-600 font-semibold text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "overview" ? (
        <>
          <AgentControl orgId={orgId} agent={a} stage={stage} />
          <HeartbeatSettings orgId={orgId} agent={a} stage={stage} />
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
        </>
      ) : (
        <InstructionCopies
          key={a.id}
          orgId={orgId}
          agentId={a.id}
          stage={stage}
        />
      )}
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
  // 계약과 같은 검사. 빈 칸·소수점은 숫자 입력이 비거나 정수가 아니므로 막힌다.
  const valid =
    interval.trim() !== "" &&
    heartbeatIntervalSchema.safeParse(minutes).success;
  const changed =
    enabled !== saved.enabled || minutes !== saved.intervalMinutes;
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

const editorLabel: Record<InstructionEditor["author"], string> = {
  copy: "복사로 생김",
  owner: "사용자",
  agent: "에이전트",
};

/** 편집 중인 사본 하나. `base`는 편집을 시작한 revision, `original`은 그때 본문이다. 서버 값과 따로 두어 실시간 갱신이 덮지 않는다. */
type Draft = {
  copyId: string;
  base: number;
  original: string;
  content: string;
};

const saveErrorText = (code: string | undefined) => {
  switch (code) {
    case "organization_closed":
      return "조직이 이미 끝나 저장하지 않았습니다.";
    case "invalid_skill":
      return "Skill을 읽을 수 없는 내용이라 저장하지 않았습니다. 첫 줄의 --- 부터 name(디렉터리 이름과 같게)과 description을 둔 frontmatter를 지켜 주세요.";
    case "invalid_input":
      return "1 MiB를 넘거나 저장할 수 없는 글자가 있어 저장하지 않았습니다.";
    case "not_found":
      return "이 사본을 찾지 못했습니다.";
    default:
      return "저장하지 못했습니다. 편집 내용은 그대로이니 다시 시도하세요.";
  }
};

/**
 * 에이전트 상세 › Role·Soul·Skill 탭. 이 에이전트가 소유한 사본을 고쳐 저장하고 revision을 본다.
 * 편집 중인 본문(draft)은 서버 값과 따로 두므로 실시간 갱신·저장 실패·충돌에도 남는다. 저장하지 않은 편집이 있으면
 * 다른 파일·화면으로 옮기거나 새로고침할 때 버릴지 묻는다. 예전 revision은 읽기만 하며 되돌리기·diff는 없다.
 * 에이전트가 바뀌면 key로 상태를 초기화한다.
 */
function InstructionCopies({
  orgId,
  agentId,
  stage,
}: {
  orgId: string;
  agentId: string;
  stage: LifecycleStage | undefined;
}) {
  const found = useAgentInstructions(orgId, agentId);
  const save = useEditInstructionCopy(orgId, agentId);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const dirty = draft !== null && draft.content !== draft.original;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search)
  );
  useBeforeUnload(
    useCallback(
      (e: BeforeUnloadEvent) => {
        if (dirty) e.preventDefault();
      },
      [dirty]
    )
  );
  const closed = stage !== undefined && isClosedStage(stage);

  const leaveDraft = () => {
    setDraft(null);
    save.reset();
  };
  const open = (path: string) => {
    leaveDraft();
    setViewing(null);
    setSelectedPath(path);
  };

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
    const copy = copies.find((c) => c.path === selectedPath) ?? copies[0]!;
    const editing = draft?.copyId === copy.id ? draft : null;
    const select = (path: string) => {
      if (path === copy.path) return;
      if (dirty) setSwitchTo(path);
      else open(path);
    };
    const submit = (expectedRevision: number) => {
      if (!editing) return;
      save.mutate(
        { copyId: copy.id, content: editing.content, expectedRevision },
        { onSuccess: () => setDraft(null) }
      );
    };
    const conflict =
      editing !== null &&
      (copy.revision !== editing.base ||
        (save.error instanceof ApiError &&
          save.error.code === "revision_conflict"));
    return (
      <div className="card overflow-hidden">
        <div
          role="tablist"
          aria-label="사본 파일"
          className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-slate-100 px-2 pt-2"
        >
          {copies.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === copy.id}
              onClick={() => select(c.path)}
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
            <dt>지금 revision</dt>
            <dd className="tabular-nums" data-testid="copy-revision">
              {copy.revision}
            </dd>
            <dt>지침 bundle</dt>
            <dd className="font-mono break-all">
              {bundleVersion?.slice(0, 19) ?? "없음"}
            </dd>
          </dl>
          {viewing !== null ? (
            <RevisionView
              orgId={orgId}
              agentId={agentId}
              copyId={copy.id}
              number={viewing}
              backLabel={editing ? "편집으로 돌아가기" : "지금 사본으로"}
              onBack={() => setViewing(null)}
            />
          ) : editing ? (
            <form
              className="px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!conflict) submit(editing.base);
              }}
            >
              <textarea
                aria-label={`${copy.path} 편집`}
                className="block min-h-[22rem] w-full resize-y rounded-xl bg-slate-50 px-3 py-2 font-mono text-[13px] leading-relaxed ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400 disabled:opacity-60"
                value={editing.content}
                disabled={save.isPending}
                spellCheck={false}
                onChange={(e) =>
                  setDraft({ ...editing, content: e.currentTarget.value })
                }
              />
              {conflict && !save.isPending && (
                <div
                  role="alert"
                  className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200"
                >
                  편집하는 동안 다른 곳에서 이 사본을 저장해 지금은 revision{" "}
                  {copy.revision}입니다. 편집 내용은 그대로 두었습니다. 아래
                  목록에서 최신 내용을 확인할 수 있고, 이 편집으로 덮어쓰려면
                  다시 저장하세요.
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-soft"
                      onClick={() => submit(copy.revision)}
                    >
                      revision {copy.revision} 위에 이 편집 저장
                    </button>
                  </div>
                </div>
              )}
              {!conflict && !save.isPending && save.isError && (
                <p role="alert" className="mt-2 text-xs text-rose-600">
                  {saveErrorText(
                    save.error instanceof ApiError ? save.error.code : undefined
                  )}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={save.isPending || conflict || closed}
                >
                  {save.isPending ? "저장하는 중…" : "저장"}
                </button>
                <button
                  type="button"
                  className="btn-soft"
                  disabled={save.isPending}
                  onClick={leaveDraft}
                >
                  취소
                </button>
                <span className="text-xs text-slate-500">
                  {dirty ? "저장하지 않은 편집이 있습니다" : "바뀐 내용 없음"}
                </span>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                <button
                  className="btn-soft"
                  disabled={closed}
                  onClick={() => {
                    save.reset();
                    setDraft({
                      copyId: copy.id,
                      base: copy.revision,
                      original: copy.content,
                      content: copy.content,
                    });
                  }}
                >
                  ✎ 편집
                </button>
                {closed && (
                  <span className="text-xs text-slate-500">
                    끝난 조직의 사본은 고칠 수 없습니다.
                  </span>
                )}
              </div>
              {copy.content ? (
                <Markdown
                  text={copy.content}
                  className="max-h-[28rem] overflow-auto px-4 py-3 text-sm text-slate-800"
                />
              ) : (
                <p className="px-4 py-3 text-sm text-slate-400">빈 파일</p>
              )}
            </>
          )}
          <RevisionList
            orgId={orgId}
            agentId={agentId}
            copyId={copy.id}
            current={copy.revision}
            viewing={viewing}
            editing={editing !== null}
            onSelect={(n) =>
              setViewing(!editing && n === copy.revision ? null : n)
            }
          />
        </div>
      </div>
    );
  };
  const asking = switchTo !== null || blocker.state === "blocked";
  return (
    <section aria-label="Role·Soul·Skill 사본" className="mb-6">
      <p className="mb-2 text-xs text-slate-500">
        이 에이전트만의 사본입니다. 고쳐도 같은 Role의 다른 에이전트와 하네스
        라이브러리는 바뀌지 않습니다. 저장할 때마다 revision이 남고 Lead가
        깨어나며, 이 에이전트의 다음 실행 시도는 바뀐 지침으로 새 세션에서
        시작합니다. 진행 중인 실행 시도는 시작할 때 받은 지침 그대로입니다.
      </p>
      {body()}
      <Dialog.Root
        open={asking}
        onOpenChange={(next) => {
          if (next) return;
          setSwitchTo(null);
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/30 backdrop-blur-[2px]" />
          <Dialog.Content className="animate-pop-in fixed top-[18vh] left-1/2 z-[71] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-white p-6 shadow-pop">
            <Dialog.Title className="text-base font-semibold">
              저장하지 않은 편집이 있습니다
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-slate-500">
              옮기면 지금 편집한 내용을 버립니다. 사본과 revision은 바뀌지
              않습니다.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="btn-soft">계속 편집</Dialog.Close>
              <button
                className="btn-danger"
                onClick={() => {
                  const target = switchTo;
                  setSwitchTo(null);
                  if (target !== null) open(target);
                  else {
                    leaveDraft();
                    blocker.proceed?.();
                  }
                }}
              >
                편집 버리고 이동
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

/**
 * 사본의 revision 목록(최근 것부터). 고르면 그 revision의 본문을 읽기 전용으로 연다. 편집 중에도 열 수 있으며
 * (다른 곳에서 먼저 저장한 내용 확인 등) 편집 중인 본문은 그대로 남는다.
 */
function RevisionList({
  orgId,
  agentId,
  copyId,
  current,
  viewing,
  editing,
  onSelect,
}: {
  orgId: string;
  agentId: string;
  copyId: string;
  current: number;
  viewing: number | null;
  editing: boolean;
  onSelect: (number: number) => void;
}) {
  const list = useInstructionRevisions(orgId, agentId, copyId);
  const items = () => {
    if (list.isPending) return <Loading />;
    if (list.isError)
      return (
        <LoadError what="revision 목록" onRetry={() => void list.refetch()} />
      );
    if (!list.data.length)
      return <p className="text-xs text-slate-400">revision이 없습니다.</p>;
    return (
      <ol className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
        {list.data.map((r) => {
          const shown =
            viewing === null
              ? !editing && r.number === current
              : r.number === viewing;
          return (
            <li key={r.id}>
              <button
                aria-pressed={shown}
                onClick={() => onSelect(r.number)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition ${shown ? "bg-brand-50" : "hover:bg-slate-50"}`}
              >
                <span className="w-24 shrink-0 font-medium text-slate-800 tabular-nums">
                  revision {r.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {editorLabel[r.editor.author]}
                  {r.number === current && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      지금
                    </span>
                  )}
                </span>
                <time
                  dateTime={r.createdAt}
                  className="shrink-0 text-slate-400 tabular-nums"
                >
                  {formatTime(r.createdAt)}
                </time>
              </button>
            </li>
          );
        })}
      </ol>
    );
  };
  return (
    <section
      aria-label="revision 목록"
      className="border-t border-slate-100 px-4 py-3"
    >
      <h3 className="mb-2 text-xs font-semibold text-slate-600">revision</h3>
      {editing && (
        <p className="mb-2 text-xs text-slate-400">
          revision을 열어 봐도 편집 중인 내용은 그대로 남습니다.
        </p>
      )}
      {items()}
    </section>
  );
}

/** revision 하나의 본문. 읽기 전용이며 편집·되돌리기가 없다. */
function RevisionView({
  orgId,
  agentId,
  copyId,
  number,
  backLabel,
  onBack,
}: {
  orgId: string;
  agentId: string;
  copyId: string;
  number: number;
  backLabel: string;
  onBack: () => void;
}) {
  const revision = useInstructionRevision(orgId, agentId, copyId, number);
  return (
    <div className="px-4 py-3" data-testid="revision-view">
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
        <span className="font-semibold text-slate-800">
          revision {number} · 읽기 전용
        </span>
        {revision.data && (
          <span>
            {editorLabel[revision.data.editor.author]} ·{" "}
            {formatTime(revision.data.createdAt)}
          </span>
        )}
        <button className="btn-ghost ml-auto" onClick={onBack}>
          {backLabel}
        </button>
      </div>
      {revision.isPending ? (
        <Loading />
      ) : revision.isError ? (
        revision.error instanceof ApiError && revision.error.status === 404 ? (
          <p className="text-sm text-slate-500">
            이 revision을 찾지 못했습니다.
          </p>
        ) : (
          <LoadError
            what={`revision ${number}`}
            onRetry={() => void revision.refetch()}
          />
        )
      ) : revision.data.content ? (
        <Markdown
          text={revision.data.content}
          tabIndex={0}
          aria-label={`revision ${number} 본문`}
          className="max-h-[28rem] overflow-auto rounded-xl px-1 py-1 text-sm text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        />
      ) : (
        <p className="text-sm text-slate-400">빈 파일</p>
      )}
    </div>
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
          <dd className="min-w-0">
            {r.summary ? (
              <Markdown text={r.summary} />
            ) : (
              <span className="text-slate-400">없음</span>
            )}
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
      {detail && <Markdown text={detail} className="mt-0.5" />}
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
      return row("사용자 메시지", <Markdown text={reason.body} />);
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
    case "instruction_edit":
      return row(
        "사용자 사본 편집",
        link(
          `/orgs/${orgId}/agents/${reason.agentId}/instructions`,
          "사본 보기"
        ),
        `${reason.path} · revision ${reason.revision}`
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
