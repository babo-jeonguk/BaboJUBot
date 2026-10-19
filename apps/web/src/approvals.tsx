import {
  decisionNoteMaxLength,
  type Approval,
  type ApprovalDecision,
} from "@babojubot/contracts";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useApproval,
  useDecideApproval,
  useInbox,
  useOrganization,
} from "./api.ts";
import {
  abbr,
  approvalStatusLabel,
  ApprovalStatusBadge,
  avatarStyle,
  decisionLabel,
  formatTime,
  Loading,
  LoadError,
  NotFound,
  Page,
} from "./ui.tsx";

export const approvalKindLabel = { initial_research: "초기 연구 승인 요청" };

/** Inbox: 모든 조직에서 사용자 결정을 기다리는 항목. 첫 판은 승인 요청뿐이다(읽음·보관과 나머지 종류는 #61). */
export function InboxPage() {
  const inbox = useInbox();
  return (
    <Page width="standard">
      <h1 className="mb-1 text-xl font-semibold">Inbox</h1>
      <p className="mb-4 text-sm text-slate-500">
        사용자의 결정이 필요한 항목입니다.
      </p>
      {inbox.isPending ? (
        <Loading />
      ) : inbox.isError ? (
        <LoadError what="Inbox" onRetry={() => void inbox.refetch()} />
      ) : !inbox.data.length ? (
        <div className="card p-6 text-sm text-slate-500">
          결정을 기다리는 항목이 없습니다.
        </div>
      ) : (
        <ul className="card divide-y divide-slate-100" aria-label="주의 필요">
          {inbox.data.map(({ approval, organizationName }) => (
            <li key={approval.id}>
              <Link
                to={`/orgs/${approval.organizationId}/approvals/${approval.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-slate-50"
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white"
                  style={avatarStyle(approval.organizationId)}
                >
                  {abbr(organizationName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-800">
                    {approvalKindLabel[approval.kind]}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {organizationName}
                    {approval.previousApprovalId && " · 다시 제출됨"}
                  </div>
                </div>
                <span className="chip bg-amber-50 text-amber-800">
                  주의 필요
                </span>
                <time
                  dateTime={approval.createdAt}
                  className="hidden shrink-0 text-xs text-slate-400 tabular-nums sm:block"
                >
                  {formatTime(approval.createdAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

/**
 * 승인 요청 상세: 목표·완료 기준, 계획, 팀 구성, 연구 환경 명세, 연구 흐름 템플릿을 함께 보고 결정한다.
 * 보이는 내용은 제출 때 고정한 snapshot이며 승인하면 이 내용 그대로 팀과 사본이 생긴다.
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
  const { proposal } = a;
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

      {a.status === "pending" ? (
        <DecisionForm orgId={orgId} approvalId={a.id} />
      ) : (
        <DecisionReceipt orgId={orgId} approval={a} />
      )}
    </Page>
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

const decisions: { decision: ApprovalDecision; className: string }[] = [
  { decision: "approve", className: "btn-primary" },
  { decision: "request_changes", className: "btn-soft" },
  { decision: "reject", className: "btn-danger" },
];

/**
 * 결정 폼. 세 결정이 한 요청 상태를 함께 쓰므로 하나를 보내는 동안 모두 잠근다.
 * 반려와 수정 요청은 사유가 있어야 보낼 수 있고, 사유는 Lead를 깨우는 사유가 된다. 실패하면 사유를 그대로 둔다.
 */
function DecisionForm({
  orgId,
  approvalId,
}: {
  orgId: string;
  approvalId: string;
}) {
  const [note, setNote] = useState("");
  const decide = useDecideApproval(orgId, approvalId);
  const trimmed = note.trim();
  const alreadyDecided =
    decide.error instanceof ApiError && decide.error.code === "already_decided";
  return (
    <section
      id="decision"
      aria-label="결정"
      className="card scroll-mt-4 p-4 ring-2 ring-amber-200"
    >
      <h2 className="mb-1 text-sm font-semibold">결정</h2>
      <p className="mb-3 text-xs text-slate-500">
        승인하면 조직이 연구 진행으로 넘어가고 위 팀 구성대로 작업자가 생깁니다.
        반려와 수정 요청은 계획 수립으로 돌아가며 사유와 함께 Lead를 깨웁니다.
        결정은 한 번만 할 수 있습니다.
      </p>
      <label
        htmlFor="decision-note"
        className="mb-1 block text-xs text-slate-600"
      >
        결정 사유 (반려·수정 요청에는 필요)
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
        {decisions.map(({ decision, className }) => (
          <button
            key={decision}
            className={className}
            disabled={decide.isPending || (decision !== "approve" && !trimmed)}
            onClick={() =>
              decide.mutate({ decision, note: trimmed || undefined })
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
            : "결정을 보내지 못했습니다. 사유는 그대로 두었으니 다시 시도하세요."}
        </p>
      )}
    </section>
  );
}

function DecisionReceipt({
  orgId,
  approval: a,
}: {
  orgId: string;
  approval: Approval;
}) {
  return (
    <section aria-label="결정" className="card p-4 text-sm">
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
            연구 진행으로 넘어가 팀이 생겼습니다.{" "}
            <Link
              to={`/orgs/${orgId}/agents`}
              className="text-brand-600 hover:underline"
            >
              팀 보기
            </Link>
          </>
        ) : (
          "계획 수립으로 돌아갔고 Lead가 사유를 받아 다시 계획합니다."
        )}
      </p>
    </section>
  );
}
