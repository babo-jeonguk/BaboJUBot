// Inbox 상세(#50 `/inbox/:id`, docs/research/inbox-detail-references.md D01–D08). 항목을 짧게 요약해 보이고 그 자리에서 결정한다.
// 결정 폼·결정 기록은 원래 상세(승인 요청·결과 제출)와 같은 것을 쓰며, "원래 화면에서 자세히 보기"로 전체 내용을 연다.
// 결정 뒤에는 제자리에서 결정 기록을 보이고 다음 항목으로 옮기지 않는다. 다른 곳에서 먼저 결정됐으면(409) 폼이 최신 상태를 불러와
// 결정 기록으로 바뀐다. 열면 그 항목을 읽음으로 바꾼다.
import {
  inboxItemKindSchema,
  inboxSourceId,
  type Approval,
  type InboxItemKind,
  type ResultSubmission,
} from "@babojubot/contracts";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useApproval,
  useInbox,
  useUpdateInboxItem,
  useOrganization,
  useResultSubmission,
  useRun,
} from "./api.ts";
import { ApprovalDecision } from "./approvals.tsx";
import { InboxItemOrganize, useInboxPanel } from "./inbox.tsx";
import { Markdown } from "./markdown.tsx";
import { ResultDecision } from "./results.tsx";
import {
  approvalKindLabel,
  ApprovalStatusBadge,
  formatTime,
  inboxKindLabel,
  Loading,
  LoadError,
  nameOf,
  NotFound,
  Page,
  ResultStatusBadge,
  RunStatusBadge,
} from "./ui.tsx";

const sourcePath: Record<InboxItemKind, string> = {
  approval: "approvals",
  result_submission: "results",
  run_failure: "runs",
};

export function InboxDetailPage() {
  const { orgId = "", kind: rawKind, sourceId = "" } = useParams();
  const kind = inboxItemKindSchema.safeParse(rawKind);
  if (!kind.success) return <NotFound what="Inbox 항목" />;
  // 항목마다 화면 상태(결정 초안·방금 결정함)가 따로다.
  const key = `${orgId}:${sourceId}`;
  const props = { orgId, sourceId };
  return kind.data === "approval" ? (
    <ApprovalSummary key={key} {...props} />
  ) : kind.data === "result_submission" ? (
    <ResultSummary key={key} {...props} />
  ) : (
    <RunFailureSummary key={key} {...props} />
  );
}

type Props = { orgId: string; sourceId: string };

/**
 * 머리: 종류·상태·조직·시각, 원래 화면 링크, 알림 정리(읽음·보관).
 * 정리 버튼은 Inbox 항목에만 보인다(결정한 승인 요청·결과 제출도 Inbox에 남아 결정 뒤에는 보관할 수 있다).
 */
function Header({
  orgId,
  kind,
  sourceId,
  title,
  badge,
  meta,
  originalLabel,
}: Props & {
  kind: InboxItemKind;
  title: string;
  badge: ReactNode;
  meta: ReactNode;
  originalLabel: string;
}) {
  const org = useOrganization(orgId);
  const panel = useInboxPanel();
  return (
    <div className="mb-6">
      <div className="mb-1 text-xs text-slate-500">
        <button
          onClick={() => panel.show(orgId)}
          className="hover:underline"
          aria-label="Inbox 열기"
        >
          ← Inbox
        </button>{" "}
        · {inboxKindLabel[kind]} ·{" "}
        <Link to={`/orgs/${orgId}`} className="hover:underline">
          {org.data?.name ?? "조직"}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {badge}
      </div>
      <div className="mt-1 text-sm text-slate-500">{meta}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          to={`/orgs/${orgId}/${sourcePath[kind]}/${sourceId}`}
          className="btn-soft"
        >
          {originalLabel} →
        </Link>
        <Organize orgId={orgId} kind={kind} sourceId={sourceId} />
      </div>
    </div>
  );
}

/**
 * 알림 정리. Inbox 항목에만 보인다(중단된 조직의 결정을 기다리는 요청처럼 Inbox에 없는 원본에는 없다).
 * 열 때 읽지 않은 항목이면 한 번 읽음으로 바꾼다. 이 화면에서 읽지 않음으로 되돌리면 다시 바꾸지 않는다.
 * 읽음 명령이 실패하면 저절로 다시 보내지 않고 알린 뒤, 사용자가 다시 시도하게 한다.
 * 다시 불러온 항목이 이미 읽음이면 그 안내를 지운다.
 */
function Organize({ orgId, kind, sourceId }: Props & { kind: InboxItemKind }) {
  const item = useInbox().data?.find(
    (i) => i.kind === kind && inboxSourceId(i) === sourceId
  );
  const update = useUpdateInboxItem({ organizationId: orgId, kind, sourceId });
  const markedOnOpen = useRef(false);
  const unread = item ? !item.read : false;
  const { mutate, reset, isError } = update;
  useEffect(() => {
    if (!unread || markedOnOpen.current) return;
    markedOnOpen.current = true;
    mutate({ read: true });
  }, [unread, mutate]);
  // 응답만 잃고 서버는 읽음을 저장했을 수 있다. 다시 불러온 항목이 읽음이면 실패 안내를 지운다.
  useEffect(() => {
    if (item?.read && isError) reset();
  }, [item?.read, isError, reset]);
  if (!item) return null;
  return (
    <>
      <InboxItemOrganize item={item} label="알림 정리" />
      {isError && (
        <p role="alert" className="w-full text-xs text-rose-700">
          읽음으로 표시하지 못했습니다.{" "}
          <button
            className="font-medium underline"
            disabled={update.isPending}
            onClick={() => mutate({ read: true })}
          >
            다시 시도
          </button>
        </p>
      )}
    </>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="mb-4">
      <h2 className="mb-1.5 text-sm font-semibold text-slate-600">{label}</h2>
      <div className="card px-4 py-3 text-sm break-words whitespace-pre-wrap text-slate-800">
        {children}
      </div>
    </section>
  );
}

/** 긴 글은 앞부분만 보이고, 잘린 글은 아래가 흐려져 줄였다는 것을 숨기지 않는다. */
function Excerpt({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight);
  }, [text]);
  return (
    <section aria-label={label} className="mb-4">
      <h2 className="mb-1.5 text-sm font-semibold text-slate-600">{label}</h2>
      <div className="card px-4 py-3 text-sm text-slate-800">
        <Markdown
          ref={ref}
          text={text}
          data-clipped={clipped || undefined}
          className={`max-h-24 overflow-hidden ${clipped ? "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]" : ""}`}
        />
      </div>
    </section>
  );
}

function ApprovalSummary({ orgId, sourceId }: Props) {
  const approval = useApproval(orgId, sourceId);
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
  return (
    <Page width="standard">
      <Header
        orgId={orgId}
        sourceId={sourceId}
        kind="approval"
        title={approvalKindLabel[a.kind]}
        badge={<ApprovalStatusBadge status={a.status} />}
        meta={`${nameOf(org.data?.agents ?? [], a.requestedByAgentId)} · ${formatTime(a.createdAt)} 제출${a.previousApprovalId ? " · 다시 제출됨" : ""}`}
        originalLabel="원래 화면에서 자세히 보기"
      />
      <ProposalSummary approval={a} />
      <div className="mt-6">
        <ApprovalDecision orgId={orgId} approval={a} stage={org.data?.stage} />
      </div>
    </Page>
  );
}

/** 승인 요청 요약: 결정에 필요한 사실만. 사본 내용·템플릿 세부·계획 전문은 원래 화면에 있다. */
function ProposalSummary({ approval: a }: { approval: Approval }) {
  if (a.kind === "add_worker")
    return (
      <Block label="추가할 작업자">
        <span className="font-medium">{a.proposal.label}</span>{" "}
        <span className="text-xs text-slate-400">{a.proposal.role}</span> · 1명
        · 받을 사본 {a.proposal.files.length}개
      </Block>
    );
  const p = a.proposal;
  return (
    <>
      <section aria-label="연구 목표와 완료 기준" className="mb-4">
        <h2 className="mb-1.5 text-sm font-semibold text-slate-600">
          연구 목표와 완료 기준
        </h2>
        <dl className="card grid gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-slate-500">연구 목표</dt>
          <dd className="min-w-0">
            <Markdown text={p.goal} />
          </dd>
          <dt className="text-slate-500">완료 기준</dt>
          <dd className="min-w-0">
            <Markdown text={p.completionCriteria} />
          </dd>
        </dl>
      </section>
      <Block label="팀 구성">
        {p.team.map((m) => `${m.label} ${m.count}명`).join(" · ")}
      </Block>
      <Excerpt label="초기 연구 계획" text={p.plan} />
      <Excerpt label="연구 환경 명세" text={p.environment} />
      <Block label="연구 흐름 템플릿">{p.template.label}</Block>
    </>
  );
}

function ResultSummary({ orgId, sourceId }: Props) {
  const submission = useResultSubmission(orgId, sourceId);
  const org = useOrganization(orgId);
  if (submission.isPending) return <Loading />;
  if (submission.isError)
    return submission.error instanceof ApiError &&
      submission.error.status === 404 ? (
      <NotFound what="결과 제출" />
    ) : (
      <LoadError what="결과 제출" onRetry={() => void submission.refetch()} />
    );
  const s = submission.data;
  return (
    <Page width="standard">
      <Header
        orgId={orgId}
        sourceId={sourceId}
        kind="result_submission"
        title="결과 제출"
        badge={<ResultStatusBadge status={s.status} />}
        meta={`${nameOf(org.data?.agents ?? [], s.submittedByAgentId)} · ${formatTime(s.createdAt)} 제출${s.previousSubmissionId ? " · 다시 제출됨" : ""}`}
        originalLabel="원래 화면에서 자세히 보기"
      />
      <SubmissionSummary submission={s} />
      <div className="mt-6">
        <ResultDecision orgId={orgId} submission={s} stage={org.data?.stage} />
      </div>
    </Page>
  );
}

/** 결과 제출 요약: 결과 요약 앞부분, 제출 때 고정한 완료 기준, 근거 산출물 제목. 산출물 본문은 원래 화면에서 연다. */
function SubmissionSummary({
  submission: s,
}: {
  submission: ResultSubmission;
}) {
  return (
    <>
      <Excerpt label="결과 요약" text={s.summary} />
      <section aria-label="완료 기준" className="mb-4">
        <h2 className="mb-1.5 text-sm font-semibold text-slate-600">
          완료 기준
        </h2>
        <dl className="card grid gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-slate-500">연구 목표</dt>
          <dd className="min-w-0">
            <Markdown text={s.goal} />
          </dd>
          <dt className="text-slate-500">완료 기준</dt>
          <dd className="min-w-0">
            <Markdown text={s.completionCriteria} />
          </dd>
        </dl>
      </section>
      <Block label={`근거 산출물 ${s.artifacts.length}개`}>
        {s.artifacts.map((a) => a.title).join("\n")}
      </Block>
    </>
  );
}

/** 실패한 실행 시도: 결정할 것이 없다. 실패 사유와 실행 기록 링크. */
function RunFailureSummary({ orgId, sourceId }: Props) {
  const run = useRun(orgId, sourceId);
  const org = useOrganization(orgId);
  if (run.isPending) return <Loading />;
  if (run.isError)
    return run.error instanceof ApiError && run.error.status === 404 ? (
      <NotFound what="실행 시도" />
    ) : (
      <LoadError what="실행 시도" onRetry={() => void run.refetch()} />
    );
  const r = run.data;
  // Inbox에는 실패한 실행 시도만 오른다. 다른 실행 시도를 이 주소로 열면 없는 항목이다.
  if (r.status !== "failed") return <NotFound what="실패한 실행 시도" />;
  return (
    <Page width="standard">
      <Header
        orgId={orgId}
        sourceId={sourceId}
        kind="run_failure"
        title="실행 시도 실패"
        badge={
          <RunStatusBadge status={r.status} cancelReason={r.cancelReason} />
        }
        meta={`${nameOf(org.data?.agents ?? [], r.agentId)} · ${formatTime(r.startedAt)} 시작${r.finishedAt ? ` · ${formatTime(r.finishedAt)} 종료` : ""}`}
        originalLabel="실행 기록 보기"
      />
      <Block label="실패 사유">{r.error ?? "사유가 남지 않았습니다."}</Block>
      {r.summary && (
        <Block label="실행 요약">
          <Markdown text={r.summary} />
        </Block>
      )}
    </Page>
  );
}
