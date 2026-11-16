import {
  decisionNoteMaxLength,
  type Agent,
  type LifecycleStage,
  type ResultDecision,
  type ResultSubmission,
} from "@babojubot/contracts";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useDecideResult,
  useOrganization,
  useResultSubmission,
  useResultSubmissions,
} from "./api.ts";
import {
  closedOrganizationNotice,
  DecisionArea,
  DecisionFormFrame,
  DecisionRecord,
} from "./decision.tsx";
import { Markdown } from "./markdown.tsx";
import {
  Block,
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
  useInlineConfirm,
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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">결과 검토</h1>
        <StageBadge stage={stage} />
      </div>
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
                  className="ml-auto shrink-0 text-xs text-slate-500 tabular-nums"
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

      <Block variant="detail" label="결과 요약">
        <Markdown
          text={s.summary}
          className="px-4 py-3 text-sm text-slate-800"
          data-testid="result-summary"
        />
      </Block>
      <Block variant="detail" label="완료 기준">
        <dl className="grid gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-slate-500">연구 목표</dt>
          <dd className="min-w-0">
            <Markdown text={s.goal} />
          </dd>
          <dt className="text-slate-500">완료 기준</dt>
          <dd className="min-w-0">
            <Markdown text={s.completionCriteria} />
          </dd>
        </dl>
      </Block>
      <Block variant="detail" label={`근거 산출물 ${s.artifacts.length}개`}>
        <Evidence orgId={orgId} submission={s} agents={agents} />
      </Block>

      <ResultDecision
        key={s.id}
        orgId={orgId}
        submission={s}
        stage={org.data?.stage}
      />
    </Page>
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
 * 결정 영역: 검토 대기면 결정 폼, 아니면 결정 기록(`DecisionArea`). 결과 제출 상세와 Inbox 상세가 함께 쓰며,
 * 의견 초안·완료 확인과 "이 화면에서 결정함"은 제출마다 따로다(`key`).
 */
export function ResultDecision({
  orgId,
  submission: s,
  stage,
}: {
  orgId: string;
  submission: ResultSubmission;
  stage: LifecycleStage | undefined;
}) {
  const decide = useDecideResult(orgId, s.id);
  return (
    <DecisionArea
      pending={s.status === "pending"}
      form={(onDecided) => (
        <DecisionForm stage={stage} decide={decide} onDecided={onDecided} />
      )}
      record={(focus) => <DecisionReceipt submission={s} focus={focus} />}
    />
  );
}

/**
 * 결과 검토 결정 폼. 두 결정이 한 제출 상태를 함께 쓰므로 하나를 보내는 동안 모두 잠근다.
 * 수정 요청은 의견이 있어야 보낼 수 있고 의견과 함께 Lead를 깨운다. 최종 완료는 되돌릴 수 없어 한 번 더 확인한다.
 * 실패하면 의견을 그대로 둔다. 일시정지 중의 수정 요청은 조직을 재개하고 최종 완료는 연구를 끝내므로 미리 알린다.
 * 중단된 조직에서는 결정할 수 없다.
 */
function DecisionForm({
  stage,
  decide,
  onDecided,
}: {
  stage: LifecycleStage | undefined;
  decide: ReturnType<typeof useDecideResult>;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const { trigger: completeTrigger, ...complete } = useInlineConfirm(
    decide.isPending
  );
  const trimmed = note.trim();
  const closed = stage === "stopped";
  const notice = closed
    ? closedOrganizationNotice
    : stage === "paused"
      ? "조직이 일시정지 중입니다 · 수정 요청하면 재개 · 최종 완료하면 연구 종료"
      : null;
  const send = (decision: ResultDecision) =>
    decide.mutate(
      { decision, note: trimmed || undefined },
      { onSuccess: onDecided }
    );
  return (
    <DecisionFormFrame
      notice={notice}
      sending={decide.isPending}
      error={decide.error}
      subject="제출"
    >
      <label
        htmlFor="result-note"
        className="mb-1 block text-xs text-slate-600"
      >
        의견
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
          disabled={closed || decide.isPending || !trimmed}
          onClick={() => send("request_changes")}
        >
          수정 요청
        </button>
        {complete.confirming ? (
          <span
            role="group"
            aria-labelledby="complete-confirm-title"
            onKeyDown={complete.onKeyDown}
            className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-100 py-1 pr-1 pl-3"
          >
            <span className="text-xs text-slate-700">
              <strong id="complete-confirm-title" className="font-semibold">
                최종 완료할까요?
              </strong>{" "}
              되돌릴 수 없습니다.
            </span>
            <button
              className="btn-ghost"
              disabled={decide.isPending}
              onClick={complete.cancel}
              autoFocus
            >
              취소
            </button>
            <button
              className="btn-primary"
              disabled={closed || decide.isPending}
              onClick={() => send("complete")}
            >
              최종 완료
            </button>
          </span>
        ) : (
          <button
            ref={completeTrigger}
            className="btn-primary"
            disabled={closed || decide.isPending}
            onClick={complete.ask}
          >
            최종 완료
          </button>
        )}
      </div>
    </DecisionFormFrame>
  );
}

/** 결정 기록. 이 화면에서 방금 결정했으면 사라진 버튼 대신 기록으로 포커스를 옮긴다(`DecisionRecord`). */
function DecisionReceipt({
  submission: s,
  focus,
}: {
  submission: ResultSubmission;
  focus: boolean;
}) {
  return (
    <DecisionRecord
      focus={focus}
      title={resultStatusLabel[s.status]}
      decidedAt={s.decidedAt}
      note={{ label: "의견", text: s.decisionNote }}
    >
      <p className="text-slate-500">
        {s.status === "completed"
          ? "연구를 최종 완료했습니다."
          : "연구 진행으로 돌아갔습니다."}
      </p>
    </DecisionRecord>
  );
}
