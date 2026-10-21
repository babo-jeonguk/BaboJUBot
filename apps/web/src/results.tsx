import {
  decisionNoteMaxLength,
  type Agent,
  type LifecycleStage,
  type ResultDecision,
  type ResultSubmission,
} from "@babojubot/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useDecideResult,
  useOrganization,
  useResultSubmission,
  useResultSubmissions,
} from "./api.ts";
import {
  formatLabel,
  formatTime,
  Loading,
  LoadError,
  nameOf,
  NotFound,
  Page,
  ResultStatusBadge,
  resultStatusLabel,
  StageBadge,
} from "./ui.tsx";

/**
 * 조직 › 결과 검토: Lead가 제출한 결과 목록. 결정을 기다리는 제출이 맨 위에 강조되고, 각 제출은 별도 페이지에서 검토한다.
 * 옛 제출의 내용과 결정도 그대로 다시 열 수 있다.
 */
export function ResultReviewScreen({
  orgId,
  stage,
}: {
  orgId: string;
  stage: LifecycleStage;
}) {
  const list = useResultSubmissions(orgId);
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">결과 검토</h1>
        <StageBadge stage={stage} />
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Lead가 완료 기준을 충족했다고 판단하면 요약과 근거 산출물을 묶어
        제출합니다. 수정 요청과 최종 완료는 사용자만 결정합니다.
      </p>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <LoadError what="결과 제출" onRetry={() => void list.refetch()} />
      ) : !list.data.length ? (
        <div className="card p-6 text-sm text-slate-500">
          아직 제출된 결과가 없습니다.
        </div>
      ) : (
        <ul className="card divide-y divide-slate-100" aria-label="결과 제출">
          {list.data.map((s, i) => (
            <li key={s.id}>
              <Link
                to={`/orgs/${orgId}/results/${s.id}`}
                className={`flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-slate-50 ${s.status === "pending" ? "bg-amber-50/40" : ""}`}
              >
                <span className="font-medium text-slate-800">
                  결과 제출 {list.data.length - i}
                </span>
                <ResultStatusBadge status={s.status} />
                <time
                  dateTime={s.createdAt}
                  className="ml-auto shrink-0 text-xs text-slate-400 tabular-nums"
                >
                  {formatTime(s.createdAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 결과 제출 상세: 제출 요약, 제출 때 고정한 완료 기준, 근거 산출물을 함께 보고 수정 요청 또는 최종 완료를 결정한다.
 * 결정 뒤에는 폼 대신 결정 기록을 보이며, 지금 조직 단계는 이 제출의 결정과 따로 표시한다.
 */
export function ResultSubmissionPage() {
  const { orgId = "", submissionId = "" } = useParams();
  const submission = useResultSubmission(orgId, submissionId);
  const org = useOrganization(orgId);
  const list = useResultSubmissions(orgId);
  const [decidedHere, setDecidedHere] = useState(false);
  if (submission.isPending) return <Loading />;
  if (submission.isError)
    return submission.error instanceof ApiError &&
      submission.error.status === 404 ? (
      <NotFound what="결과 제출" />
    ) : (
      <LoadError what="결과 제출" onRetry={() => void submission.refetch()} />
    );
  const s = submission.data;
  const agents = org.data?.agents ?? [];
  const next = list.data?.find((x) => x.previousSubmissionId === s.id);
  return (
    <Page width="standard">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">결과 제출</h1>
        <ResultStatusBadge status={s.status} />
        <div className="w-full text-sm text-slate-500">
          {nameOf(agents, s.submittedByAgentId)} · {formatTime(s.createdAt)}{" "}
          제출
          {s.previousSubmissionId && (
            <>
              {" · "}
              <Link
                to={`/orgs/${orgId}/results/${s.previousSubmissionId}`}
                className="text-brand-600 hover:underline"
              >
                직전 제출 보기
              </Link>
            </>
          )}
          {next && (
            <>
              {" · "}
              <Link
                to={`/orgs/${orgId}/results/${next.id}`}
                className="text-brand-600 hover:underline"
              >
                다시 제출된 결과 보기
              </Link>
            </>
          )}
          {s.status === "pending" && (
            <>
              {" · "}
              <a href="#decision" className="text-brand-600 hover:underline">
                결정하러 가기
              </a>
            </>
          )}
        </div>
        {org.data && (
          <div className="flex w-full items-center gap-2 text-xs text-slate-500">
            지금 조직 단계 <StageBadge stage={org.data.stage} />
          </div>
        )}
      </div>

      <Block label="결과 요약">
        <div
          className="px-4 py-3 text-sm break-words whitespace-pre-wrap text-slate-800"
          data-testid="result-summary"
        >
          {s.summary}
        </div>
      </Block>
      <Block label="완료 기준">
        <dl className="grid gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-slate-500">연구 목표</dt>
          <dd className="break-words whitespace-pre-wrap">{s.goal}</dd>
          <dt className="text-slate-500">완료 기준</dt>
          <dd className="break-words whitespace-pre-wrap">
            {s.completionCriteria}
          </dd>
        </dl>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
          제출 때 기록된 목표와 완료 기준입니다.
        </p>
      </Block>
      <Block label={`근거 산출물 ${s.artifacts.length}개`}>
        <Evidence orgId={orgId} submission={s} agents={agents} />
      </Block>

      {s.status === "pending" ? (
        <DecisionForm
          key={s.id}
          orgId={orgId}
          submissionId={s.id}
          onDecided={() => setDecidedHere(true)}
        />
      ) : (
        <DecisionReceipt submission={s} focus={decidedHere} />
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

/** 근거 산출물. 각 항목은 산출물 단건 페이지로 열린다. 산출물은 작성자의 기록이며 검증된 결과가 아니다. */
function Evidence({
  orgId,
  submission,
  agents,
}: {
  orgId: string;
  submission: ResultSubmission;
  agents: Agent[];
}) {
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {submission.artifacts.map((a) => (
        <li key={a.id}>
          <Link
            to={`/orgs/${orgId}/artifacts/${a.id}`}
            className="block px-4 py-2.5 transition hover:bg-slate-50"
          >
            <div className="font-medium break-words text-brand-700">
              {a.title}
            </div>
            <div className="text-xs text-slate-500">
              {formatLabel[a.format]} · {nameOf(agents, a.createdByAgentId)} ·{" "}
              {formatTime(a.createdAt)}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * 결과 검토 결정 폼. 두 결정이 한 제출 상태를 함께 쓰므로 하나를 보내는 동안 모두 잠근다.
 * 수정 요청은 의견이 있어야 보낼 수 있고 의견과 함께 Lead를 깨운다. 최종 완료는 되돌릴 수 없어 한 번 더 확인한다.
 * 실패하면 의견을 그대로 둔다. 의견 초안은 제출마다 따로다(`key`).
 */
function DecisionForm({
  orgId,
  submissionId,
  onDecided,
}: {
  orgId: string;
  submissionId: string;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const decide = useDecideResult(orgId, submissionId);
  const trimmed = note.trim();
  const alreadyDecided =
    decide.error instanceof ApiError && decide.error.code === "already_decided";
  const send = (decision: ResultDecision) =>
    decide.mutate(
      { decision, note: trimmed || undefined },
      { onSuccess: onDecided }
    );
  return (
    <section
      id="decision"
      aria-label="결정"
      className="card scroll-mt-4 p-4 ring-2 ring-amber-200"
    >
      <h2 className="mb-1 text-sm font-semibold">결정</h2>
      <p className="mb-3 text-xs text-slate-500">
        수정 요청은 조직을 연구 진행으로 돌리고 의견과 함께 Lead를 깨웁니다.
        최종 완료는 연구를 닫으며, 이후에는 어떤 에이전트도 새로 실행되지
        않습니다. 결정은 한 번만 할 수 있습니다.
      </p>
      <label
        htmlFor="result-note"
        className="mb-1 block text-xs text-slate-600"
      >
        의견 (수정 요청에는 필요)
      </label>
      <textarea
        id="result-note"
        value={note}
        rows={3}
        maxLength={decisionNoteMaxLength}
        onChange={(e) => setNote(e.target.value)}
        className="w-full resize-y rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="btn-soft"
          disabled={decide.isPending || !trimmed}
          onClick={() => send("request_changes")}
        >
          수정 요청
        </button>
        {confirming ? (
          <>
            <button
              className="btn-primary"
              disabled={decide.isPending}
              onClick={() => send("complete")}
            >
              최종 완료 확정
            </button>
            <button
              className="btn-ghost"
              disabled={decide.isPending}
              onClick={() => setConfirming(false)}
            >
              취소
            </button>
          </>
        ) : (
          <button
            className="btn-primary"
            disabled={decide.isPending}
            onClick={() => setConfirming(true)}
          >
            최종 완료
          </button>
        )}
      </div>
      {confirming && !decide.isPending && (
        <p className="mt-2 text-xs text-slate-600">
          최종 완료하면 되돌릴 수 없습니다. 확정하려면 한 번 더 누르세요.
        </p>
      )}
      {decide.isPending && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          결정을 보내는 중…
        </p>
      )}
      {decide.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {alreadyDecided
            ? "이미 결정된 제출입니다. 최신 결정을 불러옵니다."
            : "결정을 보내지 못했습니다. 의견은 그대로 두었으니 다시 시도하세요."}
        </p>
      )}
    </section>
  );
}

/** 결정 기록. 이 화면에서 방금 결정했으면 사라진 버튼 대신 기록으로 포커스를 옮긴다. */
function DecisionReceipt({
  submission: s,
  focus,
}: {
  submission: ResultSubmission;
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
        {resultStatusLabel[s.status]}
        {s.decidedAt && (
          <span className="ml-2 font-normal text-slate-400">
            {formatTime(s.decidedAt)}
          </span>
        )}
      </h2>
      {s.decisionNote && (
        <p className="mb-2 break-words whitespace-pre-wrap">
          의견: {s.decisionNote}
        </p>
      )}
      <p className="text-slate-500">
        {s.status === "completed"
          ? "연구를 최종 완료했습니다. 이후에는 새 실행 시도가 시작되지 않습니다."
          : "연구 진행으로 돌아갔고 Lead가 의견을 받아 연구를 이어 갑니다."}
      </p>
    </section>
  );
}
