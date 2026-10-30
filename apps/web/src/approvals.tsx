import {
  approvalKindDecisions,
  decisionNoteMaxLength,
  proposedWorkers,
  sameProviderChoice,
  type Approval,
  type ApprovalDecision,
  type ApprovalKind,
  type LifecycleStage,
  type ProposedWorker,
  type ProviderChoice,
} from "@babojubot/contracts";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useApproval,
  useDecideApproval,
  useOrganization,
  useProviderSettings,
} from "./api.ts";
import { Markdown } from "./markdown.tsx";
import {
  changedChoiceFields,
  decisionChoices,
  type ChoiceDraft,
} from "./worker-choices.ts";
import {
  ProviderChoiceFields,
  useChoiceLabel,
  useChoiceParts,
} from "./provider-choice.tsx";
import {
  approvalKindLabel,
  approvalStatusLabel,
  ApprovalStatusBadge,
  decisionLabel,
  formatTime,
  Loading,
  LoadError,
  NotFound,
  Page,
} from "./ui.tsx";

/** 대시보드에서 결정을 기다리는 요청 아래에 붙이는 안내. */
export const approvalKindHint: Record<ApprovalKind, string> = {
  initial_research: "계획·팀·연구 환경 명세를 검토하고 결정하세요.",
  add_worker: "추가할 작업자의 Role과 받을 사본을 검토하고 결정하세요.",
};

/**
 * 승인 요청 상세. 초기 연구 승인은 목표·완료 기준, 계획, 팀 구성, 연구 환경 명세, 연구 흐름 템플릿을,
 * 작업자 추가는 추가할 작업자의 Role과 받을 사본을 함께 보고 결정한다.
 * 보이는 내용은 요청 때 고정한 snapshot이며 승인하면 이 내용 그대로 작업자와 사본이 생긴다.
 */
export function ApprovalDetailPage() {
  const { orgId = "", approvalId = "" } = useParams();
  const approval = useApproval(orgId, approvalId);
  const org = useOrganization(orgId);
  if (approval.isPending) return <Loading />;
  if (approval.isError)
    return approval.error instanceof ApiError &&
      approval.error.status === 404 ? (
      <NotFound what="승인 요청" />
    ) : (
      <LoadError what="승인 요청" onRetry={() => void approval.refetch()} />
    );
  const a = approval.data;
  const lead = org.data?.agents.find((x) => x.id === a.requestedByAgentId);
  return (
    <Page width="standard">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{approvalKindLabel[a.kind]}</h1>
        <ApprovalStatusBadge status={a.status} />
        <div className="w-full text-sm text-slate-500">
          {lead?.name ?? "Research Lead"} · {formatTime(a.createdAt)} 제출
          {a.previousApprovalId && (
            <>
              {" · "}
              <Link
                to={`/orgs/${orgId}/approvals/${a.previousApprovalId}`}
                className="text-brand-600 hover:underline"
              >
                직전 요청 보기
              </Link>
            </>
          )}
          {a.status === "pending" && (
            <>
              {" · "}
              <a href="#decision" className="text-brand-600 hover:underline">
                결정하러 가기
              </a>
            </>
          )}
        </div>
      </div>

      {a.kind === "initial_research" ? (
        <InitialResearchContent proposal={a.proposal} />
      ) : (
        <AddWorkerContent proposal={a.proposal} />
      )}

      <ApprovalDecision
        key={a.id}
        orgId={orgId}
        approval={a}
        stage={org.data?.stage}
      />
    </Page>
  );
}

/**
 * 초기 연구 승인 요청의 완료 기준 항목(`dt`·`dd`). 사용자가 비워 둬 Lead가 이 요청에서 제안한 기준이면
 * `Lead 제안` 표시를 붙인다. 승인하면 조직의 완료 기준이 된다. Inbox 상세와 같이 쓴다.
 */
export function ProposedCriteria({
  proposal,
}: {
  proposal: Pick<
    ProposalOf<"initial_research">,
    "completionCriteria" | "completionCriteriaProposed"
  >;
}) {
  return (
    <>
      <dt className="text-slate-500">완료 기준</dt>
      <dd className="min-w-0" data-testid="proposal-completion-criteria">
        {proposal.completionCriteriaProposed && (
          <span className="mb-1 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
            Lead 제안
          </span>
        )}
        <Markdown text={proposal.completionCriteria} />
      </dd>
    </>
  );
}

type ProposalOf<K extends ApprovalKind> = Extract<
  Approval,
  { kind: K }
>["proposal"];

function InitialResearchContent({
  proposal,
}: {
  proposal: ProposalOf<"initial_research">;
}) {
  const choiceLabel = useChoiceLabel();
  return (
    <>
      <Block label="연구 목표와 완료 기준">
        <dl className="grid gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-slate-500">연구 목표</dt>
          <dd className="min-w-0">
            <Markdown text={proposal.goal} />
          </dd>
          <ProposedCriteria proposal={proposal} />
        </dl>
      </Block>
      <Block label="초기 연구 계획">
        <Text>{proposal.plan}</Text>
      </Block>
      <Block label="팀 구성">
        <ul className="divide-y divide-slate-100">
          {proposal.team.map((m) => (
            <li key={m.role} className="px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{m.label}</span>
                <span className="text-xs text-slate-400">{m.role}</span>
                <span className="ml-auto tabular-nums">{m.count}명</span>
              </div>
              {m.choice && (
                <div className="mt-0.5 text-xs text-slate-500">
                  {choiceLabel(m.choice)}
                </div>
              )}
              <details className="mt-1 text-xs text-slate-500">
                <summary className="cursor-pointer">
                  각 작업자가 받을 사본 {m.files.length}개
                </summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {m.files.map((f) => (
                    <li key={f.path} className="break-all">
                      {f.path} ← harness/{f.source} ·{" "}
                      {f.sourceDigest.slice(0, 12)}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </Block>
      <Block label="연구 환경 명세">
        <Text>{proposal.environment}</Text>
      </Block>
      <Block label="연구 흐름 템플릿">
        <div className="space-y-2 p-4 text-sm">
          <div>
            <span className="font-medium">{proposal.template.label}</span>{" "}
            <span className="text-xs text-slate-400">
              {proposal.template.name}
            </span>
          </div>
          {proposal.template.description && (
            <p className="text-slate-600">{proposal.template.description}</p>
          )}
          <Kinds
            label="노드 종류"
            kinds={proposal.template.nodeKinds.map((k) => k.label)}
          />
          <Kinds
            label="연결 종류"
            kinds={proposal.template.linkKinds.map((k) => k.label)}
          />
        </div>
      </Block>
    </>
  );
}

/** 작업자 추가 요청: Lead가 고른 Role과, 승인하면 새 작업자가 받을 Role·Soul·Skill 사본의 내용. */
function AddWorkerContent({
  proposal,
}: {
  proposal: ProposalOf<"add_worker">;
}) {
  const choiceLabel = useChoiceLabel();
  return (
    <Block label="추가할 작업자">
      <div className="px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium">{proposal.label}</span>
          <span className="text-xs text-slate-400">{proposal.role}</span>
          <span className="ml-auto tabular-nums">1명</span>
        </div>
        {proposal.choice && (
          <p className="mt-0.5 text-xs text-slate-500">
            {choiceLabel(proposal.choice)}
          </p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          받을 사본 {proposal.files.length}개
        </p>
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-100">
        {proposal.files.map((f) => (
          <li key={f.path} className="px-4 py-2 text-xs">
            <details>
              <summary className="cursor-pointer font-mono break-all text-slate-600">
                {f.path} ← harness/{f.source} · {f.sourceDigest.slice(0, 12)}
              </summary>
              <Markdown
                text={f.content}
                className="mt-2 max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-slate-700"
              />
            </details>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-slate-600">{label}</h2>
      <div className="card">{children}</div>
    </section>
  );
}

function Text({ children }: { children: string }) {
  return (
    <Markdown text={children} className="px-4 py-3 text-sm text-slate-800" />
  );
}

function Kinds({ label, kinds }: { label: string; kinds: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-slate-500">{label}</span>
      {kinds.length ? (
        kinds.map((k) => (
          <span key={k} className="chip bg-slate-100 text-slate-700">
            {k}
          </span>
        ))
      ) : (
        <span className="text-xs text-slate-400">없음</span>
      )}
    </div>
  );
}

const decisionStyle: Record<ApprovalDecision, string> = {
  approve: "btn-primary",
  request_changes: "btn-soft",
  reject: "btn-danger",
};

const noteLabel = "결정 사유";

/**
 * 결정 영역: 결정 대기면 결정 폼, 아니면 결정 기록. 승인 요청 상세와 Inbox 상세가 함께 쓴다.
 * 이 화면에서 방금 결정했으면 사라진 버튼 대신 결정 기록으로 포커스를 옮긴다.
 */
export function ApprovalDecision({
  orgId,
  approval: a,
  stage,
}: {
  orgId: string;
  approval: Approval;
  stage: LifecycleStage | undefined;
}) {
  const [decidedHere, setDecidedHere] = useState(false);
  return a.status === "pending" ? (
    <DecisionForm
      orgId={orgId}
      approval={a}
      stage={stage}
      onDecided={() => setDecidedHere(true)}
    />
  ) : (
    <DecisionReceipt orgId={orgId} approval={a} focus={decidedHere} />
  );
}

// 작업자마다의 프로바이더·모델 초안. 승인 요청마다 따로 두며, 화면을 닫거나 Inbox와 승인 상세 사이를 오가도 남는다.
// 바꾸지 않은 작업자는 비어 있고(Lead 제안), 결정에 성공하면 지운다.
const choiceDrafts = new Map<string, ChoiceDraft>();
const draftListeners = new Set<() => void>();
function setChoiceDraft(key: string, draft: ChoiceDraft | undefined) {
  if (draft?.some(Boolean)) choiceDrafts.set(key, draft);
  else choiceDrafts.delete(key);
  for (const listener of draftListeners) listener();
}
function useChoiceDraft(key: string) {
  return useSyncExternalStore(
    (onChange) => {
      draftListeners.add(onChange);
      return () => void draftListeners.delete(onChange);
    },
    () => choiceDrafts.get(key)
  );
}

/** 바꾼 칸의 배지: 앞 아이콘 + 짧은 라벨. */
function ChangedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
      <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 fill-current">
        <path d="M8.6 1.2a1 1 0 0 1 1.4 0l.8.8a1 1 0 0 1 0 1.4L4.2 10H2v-2.2z" />
      </svg>
      변경
    </span>
  );
}

/**
 * 결정 전 작업자 표: 승인하면 생길 작업자마다 역할·순번과 프로바이더·모델 Select를 Lead 제안으로 채운다.
 * 바꾼 줄에는 `변경` 배지와 `되돌리기`가 붙는다. 프로바이더를 바꾸면 모델은 `기본 모델`이 된다.
 * 프로바이더 설정을 읽기 전에는 값만 보인다.
 */
function WorkerChoiceTable({
  idPrefix,
  workers,
  shown,
  base,
  draft,
  onChange,
  disabled,
}: {
  idPrefix: string;
  workers: ProposedWorker[];
  /** 표의 값. 아직 모르는 칸은 비어 있다(`decisionChoices`). */
  shown: (ProviderChoice | undefined)[];
  /** 바꾸지 않았을 때의 값. 이 값으로 고르면 바꾼 값을 지운다. */
  base: (ProviderChoice | undefined)[];
  draft: ChoiceDraft | undefined;
  onChange: (index: number, choice: ProviderChoice | undefined) => void;
  disabled: boolean;
}) {
  const providers = useProviderSettings().data?.providers;
  const choiceLabel = useChoiceLabel();
  return (
    <div className="mb-4">
      <div className="mb-1 hidden grid-cols-[minmax(7rem,1fr)_2fr] gap-3 px-1 text-xs text-slate-500 sm:grid">
        <span>역할</span>
        <span className="grid grid-cols-2 gap-2">
          <span>프로바이더</span>
          <span>모델</span>
        </span>
      </div>
      <ul
        aria-label="작업자 프로바이더·모델"
        className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200"
      >
        {workers.map((w, i) => {
          const value = shown[i];
          const changed = draft?.[i] !== undefined;
          const name = `${w.label} ${w.ordinal}번`;
          return (
            <li
              key={`${w.role}-${w.ordinal}`}
              data-testid="worker-choice"
              className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(7rem,1fr)_2fr] sm:items-center sm:gap-3"
            >
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate font-medium">{w.label}</span>
                <span className="shrink-0 text-xs text-slate-400 tabular-nums">
                  {w.ordinal}번
                </span>
                {changed && <ChangedBadge />}
                {changed && (
                  <button
                    type="button"
                    className="ml-auto shrink-0 rounded-lg px-1.5 text-base text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                    aria-label={`${name} 되돌리기`}
                    title="되돌리기"
                    disabled={disabled}
                    onClick={() => onChange(i, undefined)}
                  >
                    ↺
                  </button>
                )}
              </div>
              {providers && value ? (
                <ProviderChoiceFields
                  idPrefix={`${idPrefix}-${i}`}
                  label={name}
                  inTableRow
                  providers={providers}
                  value={value}
                  disabled={disabled}
                  onChange={(next) =>
                    onChange(
                      i,
                      base[i] && sameProviderChoice(next, base[i]!)
                        ? undefined
                        : next
                    )
                  }
                />
              ) : (
                <span className="text-sm text-slate-600">
                  {value ? choiceLabel(value) : "—"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 결정 뒤 작업자 표(읽기 전용): 승인으로 생긴 작업자마다 `Lead 제안`과 `결정`의 프로바이더·모델을 나란히 보이고,
 * 프로바이더와 모델 가운데 다른 칸에만 `변경` 배지를 붙인다.
 * Lead 제안이 없는 예전 요청은 `—`이다.
 */
function DecidedWorkerTable({
  orgId,
  approval: a,
}: {
  orgId: string;
  approval: Approval;
}) {
  const parts = useChoiceParts();
  const agents = useOrganization(orgId).data?.agents;
  if (!a.decidedWorkers?.length) return null;
  const workers = proposedWorkers(a);
  return (
    <table
      aria-label="작업자 프로바이더·모델"
      className="mt-3 w-full table-fixed text-left text-sm"
    >
      <thead className="text-xs text-slate-500">
        <tr>
          <th className="w-1/3 py-1 font-normal">이름</th>
          <th className="py-1 font-normal">Lead 제안</th>
          <th className="py-1 font-normal">결정</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {a.decidedWorkers.map((decided, i) => {
          const proposed = workers[i];
          const lead = proposed?.choice;
          const changed = lead
            ? changedChoiceFields(lead, decided)
            : { provider: false, model: false };
          const name =
            agents?.find((x) => x.id === decided.agentId)?.name ??
            `${proposed?.label ?? ""} ${proposed?.ordinal ?? i + 1}번`;
          return (
            <tr key={decided.agentId} data-testid="decided-worker">
              <td className="py-2 pr-2 align-top">
                <span className="block truncate font-medium">{name}</span>
                <span className="text-xs text-slate-400">
                  {proposed?.label}
                </span>
              </td>
              <td className="py-2 pr-2 align-top break-words text-slate-600">
                {lead
                  ? parts(lead).map((part, k) => (
                      <span key={k} className="block">
                        {part}
                      </span>
                    ))
                  : "—"}
              </td>
              <td className="py-2 align-top break-words">
                {parts(decided).map((part, k) => {
                  const differs = changed[k === 0 ? "provider" : "model"];
                  return (
                    <span
                      key={k}
                      data-changed={differs || undefined}
                      className={`flex flex-wrap items-center gap-1 ${differs ? "font-medium" : "text-slate-600"}`}
                    >
                      {part}
                      {differs && <ChangedBadge />}
                    </span>
                  );
                })}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 결정 폼. 종류마다 내릴 수 있는 결정이 다르고(작업자 추가에는 수정 요청이 없다), 모든 결정이 한 요청 상태를
 * 함께 쓰므로 하나를 보내는 동안 모두 잠근다. 승인 밖의 결정은 사유가 있어야 보낼 수 있고, 사유는 Lead를 깨우는
 * 사유가 된다. 실패하면 사유를 그대로 둔다.
 * 일시정지 중의 초기 연구 승인 결정은 조직을 재개하므로 미리 알린다. 중단된 조직에서는 결정할 수 없다.
 * 작업자 추가 결정은 단계와 상관없이 받으며 일시정지를 풀지 않는다.
 */
function DecisionForm({
  orgId,
  approval,
  stage,
  onDecided,
}: {
  orgId: string;
  approval: Approval;
  stage: LifecycleStage | undefined;
  onDecided: () => void;
}) {
  const { id: approvalId, kind } = approval;
  const [note, setNote] = useState("");
  const decide = useDecideApproval(orgId, approvalId);
  const workerDefault = useProviderSettings().data?.workerDefault;
  const workers = proposedWorkers(approval);
  const draftKey = `${orgId}/${approvalId}`;
  const draft = useChoiceDraft(draftKey);
  // 표의 값과 승인할 때 보낼 값은 한 곳에서 나온다. 모르는 칸이 있으면 승인할 수 없다.
  const choices = decisionChoices(workers, draft, workerDefault);
  const base = decisionChoices(workers, undefined, workerDefault).shown;
  const trimmed = note.trim();
  const alreadyDecided =
    decide.error instanceof ApiError && decide.error.code === "already_decided";
  const changesStage = kind === "initial_research";
  const closed = changesStage && stage === "stopped";
  const pausedNotice =
    stage !== "paused"
      ? null
      : changesStage
        ? "조직이 일시정지 중입니다 · 결정하면 재개"
        : "조직이 일시정지 중입니다";
  return (
    <section
      id="decision"
      aria-label="결정"
      className="card scroll-mt-4 p-4 ring-2 ring-amber-200"
    >
      <h2 className="mb-3 text-sm font-semibold">결정</h2>
      {(pausedNotice || closed) && (
        <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
          {closed ? "중단된 조직이라 결정할 수 없습니다." : pausedNotice}
        </p>
      )}
      <WorkerChoiceTable
        idPrefix={`worker-choice-${approvalId}`}
        workers={workers}
        shown={choices.shown}
        base={base}
        draft={draft}
        disabled={decide.isPending}
        onChange={(index, choice) =>
          setChoiceDraft(
            draftKey,
            workers.map((_, i) => (i === index ? choice : draft?.[i]))
          )
        }
      />
      <label
        htmlFor="decision-note"
        className="mb-1 block text-xs text-slate-600"
      >
        {noteLabel}
      </label>
      <textarea
        id="decision-note"
        value={note}
        rows={3}
        maxLength={decisionNoteMaxLength}
        onChange={(e) => setNote(e.target.value)}
        className="w-full resize-y rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {approvalKindDecisions[kind].map((decision) => (
          <button
            key={decision}
            className={decisionStyle[decision]}
            disabled={
              closed ||
              decide.isPending ||
              (decision === "approve" ? !choices.ready : !trimmed)
            }
            onClick={() =>
              decide.mutate(
                {
                  decision,
                  note: trimmed || undefined,
                  ...(decision === "approve" && choices.send
                    ? { choices: choices.send }
                    : {}),
                },
                {
                  onSuccess: () => {
                    setChoiceDraft(draftKey, undefined);
                    onDecided();
                  },
                }
              )
            }
          >
            {decisionLabel[decision]}
          </button>
        ))}
      </div>
      {decide.isPending && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          결정을 보내는 중…
        </p>
      )}
      {decide.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {alreadyDecided
            ? "이미 결정된 요청입니다. 최신 결정을 불러옵니다."
            : decide.error instanceof ApiError &&
                decide.error.code === "organization_closed"
              ? "조직이 중단되어 결정을 받지 않았습니다."
              : "보내지 못했습니다. 다시 시도하세요."}
        </p>
      )}
    </section>
  );
}

function DecisionReceipt({
  orgId,
  approval: a,
  focus,
}: {
  orgId: string;
  approval: Approval;
  focus: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="결정"
      className="card p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
    >
      <h2 className="mb-2 text-sm font-semibold">
        {approvalStatusLabel[a.status]}
        {a.decidedAt && (
          <span className="ml-2 font-normal text-slate-400">
            {formatTime(a.decidedAt)}
          </span>
        )}
      </h2>
      {a.decisionNote && (
        <p className="mb-2 break-words whitespace-pre-wrap">
          사유: {a.decisionNote}
        </p>
      )}
      <DecidedWorkerTable orgId={orgId} approval={a} />
      <p className="text-slate-500">
        {a.status === "approved" ? (
          <>
            {a.kind === "initial_research"
              ? "연구 진행으로 넘어가 팀이 생겼습니다."
              : "작업자가 팀에 더해졌습니다."}{" "}
            <Link
              to={`/orgs/${orgId}/agents`}
              className="text-brand-600 hover:underline"
            >
              팀 보기
            </Link>
          </>
        ) : a.kind === "initial_research" ? (
          "계획 수립으로 돌아갔습니다."
        ) : (
          "작업자를 만들지 않았습니다."
        )}
      </p>
    </section>
  );
}
