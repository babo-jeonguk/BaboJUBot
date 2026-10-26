import {
  approvalKindDecisions,
  decisionNoteMaxLength,
  type Approval,
  type ApprovalDecision,
  type ApprovalKind,
  type LifecycleStage,
} from "@babojubot/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useApproval,
  useDecideApproval,
  useOrganization,
} from "./api.ts";
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

type ProposalOf<K extends ApprovalKind> = Extract<
  Approval,
  { kind: K }
>["proposal"];

function InitialResearchContent({
  proposal,
}: {
  proposal: ProposalOf<"initial_research">;
}) {
  return (
    <>
      <Block label="연구 목표와 완료 기준">
        <dl className="grid gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-slate-500">연구 목표</dt>
          <dd className="break-words whitespace-pre-wrap">{proposal.goal}</dd>
          <dt className="text-slate-500">완료 기준</dt>
          <dd className="break-words whitespace-pre-wrap">
            {proposal.completionCriteria}
          </dd>
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
  return (
    <Block label="추가할 작업자">
      <div className="px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium">{proposal.label}</span>
          <span className="text-xs text-slate-400">{proposal.role}</span>
          <span className="ml-auto tabular-nums">1명</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          받을 사본 {proposal.files.length}개. 요청 때 하네스 라이브러리에서
          읽은 내용이며, 승인하면 이 내용으로 새 작업자만의 사본을 만듭니다.
        </p>
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-100">
        {proposal.files.map((f) => (
          <li key={f.path} className="px-4 py-2 text-xs">
            <details>
              <summary className="cursor-pointer font-mono break-all text-slate-600">
                {f.path} ← harness/{f.source} · {f.sourceDigest.slice(0, 12)}
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 whitespace-pre-wrap text-slate-700">
                {f.content}
              </pre>
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
    <div className="px-4 py-3 text-sm break-words whitespace-pre-wrap text-slate-800">
      {children}
    </div>
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

const decisionHelp: Record<ApprovalKind, { effect: string; note: string }> = {
  initial_research: {
    effect:
      "승인하면 조직이 연구 진행으로 넘어가고 요청한 팀 구성대로 작업자가 생깁니다. 반려와 수정 요청은 계획 수립으로 돌아가며 사유와 함께 Lead를 깨웁니다.",
    note: "결정 사유 (반려·수정 요청에는 필요)",
  },
  add_worker: {
    effect:
      "승인하면 요청한 사본을 받은 작업자 한 명이 생기고, 반려하면 아무것도 만들지 않습니다. 어느 쪽이든 연구 단계는 그대로이며 결정과 사유로 Lead를 깨웁니다.",
    note: "결정 사유 (반려에는 필요)",
  },
};

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
      approvalId={a.id}
      kind={a.kind}
      stage={stage}
      onDecided={() => setDecidedHere(true)}
    />
  ) : (
    <DecisionReceipt orgId={orgId} approval={a} focus={decidedHere} />
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
  approvalId,
  kind,
  stage,
  onDecided,
}: {
  orgId: string;
  approvalId: string;
  kind: ApprovalKind;
  stage: LifecycleStage | undefined;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const decide = useDecideApproval(orgId, approvalId);
  const trimmed = note.trim();
  const alreadyDecided =
    decide.error instanceof ApiError && decide.error.code === "already_decided";
  const changesStage = kind === "initial_research";
  const closed = changesStage && stage === "stopped";
  const pausedNotice =
    stage !== "paused"
      ? null
      : changesStage
        ? "조직이 일시정지 중입니다. 결정하면 일시정지가 풀리고 연구가 다시 진행됩니다."
        : "조직이 일시정지 중입니다. 이 결정은 일시정지를 풀지 않으며, Lead는 재개한 뒤 결정을 받습니다.";
  return (
    <section
      id="decision"
      aria-label="결정"
      className="card scroll-mt-4 p-4 ring-2 ring-amber-200"
    >
      <h2 className="mb-1 text-sm font-semibold">결정</h2>
      <p className="mb-3 text-xs text-slate-500">
        {decisionHelp[kind].effect} 결정은 한 번만 할 수 있습니다.
      </p>
      {(pausedNotice || closed) && (
        <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
          {closed ? "중단된 조직이라 결정할 수 없습니다." : pausedNotice}
        </p>
      )}
      <label
        htmlFor="decision-note"
        className="mb-1 block text-xs text-slate-600"
      >
        {decisionHelp[kind].note}
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
              closed || decide.isPending || (decision !== "approve" && !trimmed)
            }
            onClick={() =>
              decide.mutate(
                { decision, note: trimmed || undefined },
                { onSuccess: onDecided }
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
              : "결정을 보내지 못했습니다. 사유는 그대로 두었으니 다시 시도하세요."}
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
          "계획 수립으로 돌아갔고 Lead가 사유를 받아 다시 계획합니다."
        ) : (
          "작업자를 만들지 않았고 Lead가 사유를 받았습니다."
        )}
      </p>
    </section>
  );
}
