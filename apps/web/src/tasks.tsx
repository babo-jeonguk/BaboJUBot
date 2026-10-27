import {
  messageBodyMaxLength,
  type Agent,
  type ArtifactSummary,
  type TaskComment,
  type TaskDetail,
} from "@babojubot/contracts";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  ApiError,
  useAddTaskComment,
  useArtifact,
  useFlowTemplate,
  useOrganization,
  useResearchNode,
  useTask,
  useTasks,
} from "./api.ts";
import { Markdown } from "./markdown.tsx";
import {
  formatLabel,
  formatTime,
  Loading,
  LoadError,
  nameOf,
  NotFound,
  Page,
  researchNodeStatusLabel,
  runLabel,
  TaskStatusBadge,
} from "./ui.tsx";

/** 조직 › 작업: 작업 목록(제목·상태·담당자). 각 작업은 별도 상세 페이지로 열린다. */
export function TasksScreen({
  orgId,
  agents,
}: {
  orgId: string;
  agents: Agent[];
}) {
  const tasks = useTasks(orgId);
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">작업</h1>
      {tasks.isPending ? (
        <Loading />
      ) : tasks.isError ? (
        <LoadError what="작업 목록" onRetry={() => void tasks.refetch()} />
      ) : !tasks.data.length ? (
        <div className="card p-6 text-sm text-slate-500">
          아직 작업이 없습니다. 연구 진행 단계에서 Lead가 작업을 만들어
          작업자에게 맡깁니다.
        </div>
      ) : (
        <ul className="card divide-y divide-slate-100" aria-label="작업 목록">
          {tasks.data.map((task) => (
            <li key={task.id}>
              <Link
                to={`/orgs/${orgId}/tasks/${task.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition hover:bg-slate-50"
              >
                <TaskStatusBadge status={task.status} />
                <span className="min-w-0 flex-1 font-medium break-words text-slate-800">
                  {task.parentTaskId && (
                    <span className="mr-1 text-slate-400" title="하위 작업">
                      ↳
                    </span>
                  )}
                  {task.title}
                </span>
                <span className="text-xs text-slate-500">
                  담당 {nameOf(agents, task.assigneeAgentId)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 조직 › 작업 › <작업>: 제목·상태·담당자, 자기 보고 요약, 댓글 thread, 산출물, 연결된 연구 노드.
 * 사용자는 작업자와 이 댓글 thread로만 이야기한다.
 */
export function TaskDetailPage() {
  const { orgId = "", taskId = "" } = useParams();
  const task = useTask(orgId, taskId);
  const org = useOrganization(orgId);
  if (task.isPending) return <Loading />;
  if (task.isError)
    return task.error instanceof ApiError && task.error.status === 404 ? (
      <NotFound what="작업" />
    ) : (
      <LoadError what="작업" onRetry={() => void task.refetch()} />
    );
  const t = task.data;
  const agents = org.data?.agents ?? [];
  return (
    <Page width="standard">
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 text-xl font-semibold break-words">
            {t.title}
          </h1>
          <TaskStatusBadge status={t.status} />
        </div>
        <div className="mt-1 text-sm text-slate-500">
          담당{" "}
          <Link
            to={`/orgs/${orgId}/agents/${t.assigneeAgentId}`}
            className="hover:text-slate-800 hover:underline"
            data-testid="task-assignee"
          >
            {nameOf(agents, t.assigneeAgentId)}
          </Link>
          {" · "}
          {nameOf(agents, t.createdByAgentId)}가 {formatTime(t.createdAt)}에
          만듦
          {t.parentTaskId && (
            <>
              {" · "}
              <Link
                to={`/orgs/${orgId}/tasks/${t.parentTaskId}`}
                className="text-brand-600 hover:underline"
              >
                부모 작업 보기
              </Link>
            </>
          )}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0 space-y-4">
          {t.description && (
            <section aria-label="작업 내용" className="card p-4">
              <h2 className="mb-2 text-sm font-semibold text-slate-600">
                작업 내용
              </h2>
              <Markdown text={t.description} className="text-sm" />
            </section>
          )}
          <SelfReport orgId={orgId} task={t} agents={agents} />
          <CommentThread orgId={orgId} task={t} agents={agents} />
        </div>
        <div className="min-w-0 space-y-4">
          <ArtifactList orgId={orgId} artifacts={t.artifacts} agents={agents} />
          <LinkedNode orgId={orgId} nodeId={t.researchNodeId} />
        </div>
      </div>
    </Page>
  );
}

/** 작업이 연결된 연구 노드(0~1개). 지도에서 그 노드를 골라 연다. */
function LinkedNode({
  orgId,
  nodeId,
}: {
  orgId: string;
  nodeId: string | null;
}) {
  const node = useResearchNode(orgId, nodeId ?? undefined);
  const template = useFlowTemplate(orgId);
  const kind =
    node.data &&
    (template.data?.nodeKinds.find((k) => k.name === node.data.kind)?.label ??
      node.data.kind);
  return (
    <section aria-label="연결된 연구 노드" className="card p-4 text-sm">
      <h2 className="mb-2 font-semibold text-slate-600">연결된 연구 노드</h2>
      {!nodeId ? (
        <p className="text-slate-500">연결된 연구 노드가 없습니다.</p>
      ) : node.isPending ? (
        <p className="text-slate-400">불러오는 중…</p>
      ) : node.isError ? (
        <LoadError what="연구 노드" onRetry={() => void node.refetch()} />
      ) : (
        <Link
          to={`/orgs/${orgId}/map?node=${node.data.id}`}
          className="block rounded-xl px-2 py-1.5 transition hover:bg-slate-50"
        >
          <div className="text-xs text-slate-500">
            {kind} · {researchNodeStatusLabel[node.data.status]}
          </div>
          <div
            className={`font-medium break-words ${node.data.status === "discarded" ? "text-slate-400 line-through" : "text-brand-700"}`}
          >
            {node.data.title}
          </div>
        </Link>
      )}
    </section>
  );
}

function SelfReport({
  orgId,
  task,
  agents,
}: {
  orgId: string;
  task: TaskDetail;
  agents: Agent[];
}) {
  const { report } = task;
  return (
    <section aria-label="자기 보고" className="card p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-600">자기 보고</h2>
      {report ? (
        <>
          <p className="mb-2 text-xs text-slate-400">
            작업을 완료한 에이전트가 남긴 요약입니다. 검증된 결과가 아닙니다.
          </p>
          <Markdown
            text={report.summary}
            className="text-sm"
            data-testid="task-report"
          />
          <div className="mt-2 text-xs text-slate-500">
            {nameOf(agents, report.agentId)} · {formatTime(report.completedAt)}{" "}
            완료 ·{" "}
            <Link
              to={`/orgs/${orgId}/runs/${report.runId}`}
              className="text-brand-600 hover:underline"
            >
              {runLabel(report.runId)}
            </Link>
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-500">
          아직 완료되지 않았습니다. 완료하면 담당자의 요약이 여기에 보입니다.
        </p>
      )}
    </section>
  );
}

function ArtifactList({
  orgId,
  artifacts,
  agents,
}: {
  orgId: string;
  artifacts: ArtifactSummary[];
  agents: Agent[];
}) {
  return (
    <section aria-label="산출물" className="card text-sm">
      <h2 className="px-4 pt-4 pb-2 font-semibold text-slate-600">
        산출물 {artifacts.length}개
      </h2>
      {!artifacts.length ? (
        <p className="px-4 pb-4 text-slate-500">아직 산출물이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {artifacts.map((a) => (
            <li key={a.id}>
              <Link
                to={`/orgs/${orgId}/artifacts/${a.id}`}
                className="block px-4 py-2.5 transition hover:bg-slate-50"
              >
                <div className="font-medium break-words text-brand-700">
                  {a.title}
                </div>
                <div className="text-xs text-slate-500">
                  {formatLabel[a.format]} · {nameOf(agents, a.createdByAgentId)}{" "}
                  · {formatTime(a.createdAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentThread({
  orgId,
  task,
  agents,
}: {
  orgId: string;
  task: TaskDetail;
  agents: Agent[];
}) {
  return (
    <section aria-label="댓글" className="card p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-600">
        댓글 {task.comments.length}개
      </h2>
      {!task.comments.length ? (
        <p className="mb-3 text-sm text-slate-500">아직 댓글이 없습니다.</p>
      ) : (
        <ol className="mb-4 space-y-3" aria-label="댓글 thread">
          {task.comments.map((c) => (
            <CommentItem key={c.id} orgId={orgId} comment={c} agents={agents} />
          ))}
        </ol>
      )}
      <CommentComposer
        orgId={orgId}
        taskId={task.id}
        assignee={nameOf(agents, task.assigneeAgentId)}
      />
    </section>
  );
}

function CommentItem({
  orgId,
  comment: c,
  agents,
}: {
  orgId: string;
  comment: TaskComment;
  agents: Agent[];
}) {
  const mine = c.author === "owner";
  const runId = mine ? c.deliveredToRunId : c.runId;
  return (
    <li data-author={c.author} className="text-sm">
      <div className="mb-1 text-[11px] text-slate-400">
        {mine ? "나" : nameOf(agents, c.agentId)} · {formatTime(c.createdAt)}
      </div>
      <Markdown
        text={c.body}
        className={`rounded-xl px-3 py-2 ${mine ? "bg-brand-50 text-slate-800" : "bg-slate-50 text-slate-800"}`}
      />
      <div className="mt-1 text-[11px] text-slate-400">
        {runId ? (
          <Link
            to={`/orgs/${orgId}/runs/${runId}`}
            className="hover:text-brand-600 hover:underline"
          >
            {mine ? `${runLabel(runId)}에 전달됨` : `${runLabel(runId)}에서 씀`}
          </Link>
        ) : (
          mine && <span>다음 실행 시도 대기</span>
        )}
      </div>
    </li>
  );
}

function CommentComposer({
  orgId,
  taskId,
  assignee,
}: {
  orgId: string;
  taskId: string;
  assignee: string;
}) {
  const [text, setText] = useState("");
  const add = useAddTaskComment(orgId, taskId);
  const submit = async () => {
    const body = text.trim();
    if (!body || add.isPending) return;
    try {
      await add.mutateAsync(body);
      setText((current) => (current.trim() === body ? "" : current));
    } catch {
      // 오류는 add.error로 보이고 입력은 그대로 둔다.
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label
        htmlFor="task-comment"
        className="mb-1 block text-xs text-slate-500"
      >
        작업 댓글
      </label>
      <textarea
        id="task-comment"
        value={text}
        rows={3}
        maxLength={messageBodyMaxLength}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-y rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-brand-400"
        placeholder="담당자에게 남길 댓글"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-slate-400">
          댓글은 담당자 {assignee}에게 전달되어 깨웁니다. 실행 중이면 다음 실행
          시도에 반영됩니다.
        </p>
        {add.isPending && (
          <span className="text-xs text-slate-400" role="status">
            저장 중…
          </span>
        )}
        <button
          className="btn-primary"
          disabled={!text.trim() || add.isPending}
        >
          댓글 달기
        </button>
      </div>
      {add.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {add.error instanceof ApiError && add.error.status === 404
            ? "작업을 찾을 수 없어 댓글을 저장하지 못했습니다."
            : "댓글을 저장했는지 확인하지 못했습니다. 입력은 그대로 두었으니 thread를 확인하고 다시 시도하세요."}
        </p>
      )}
    </form>
  );
}

/** 조직 › 산출물 › <산출물>: 본문과 출처(연결 작업·작성 에이전트·실행 시도). 산출물이 있다고 결과가 확인된 것은 아니다. */
export function ArtifactPage() {
  const { orgId = "", artifactId = "" } = useParams();
  const artifact = useArtifact(orgId, artifactId);
  const org = useOrganization(orgId);
  const task = useTask(orgId, artifact.data?.taskId);
  if (artifact.isPending) return <Loading />;
  if (artifact.isError)
    return artifact.error instanceof ApiError &&
      artifact.error.status === 404 ? (
      <NotFound what="산출물" />
    ) : (
      <LoadError what="산출물" onRetry={() => void artifact.refetch()} />
    );
  const a = artifact.data;
  const agents = org.data?.agents ?? [];
  return (
    <Page width="reading">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 text-xl font-semibold break-words">{a.title}</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {formatLabel[a.format]}
        </span>
      </div>
      <dl
        aria-label="출처"
        className="card mb-4 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 p-4 text-sm"
      >
        <dt className="text-slate-500">연결 작업</dt>
        <dd className="min-w-0 break-words">
          <Link
            to={`/orgs/${orgId}/tasks/${a.taskId}`}
            className="text-brand-600 hover:underline"
          >
            {task.data?.title ?? "작업 보기"}
          </Link>
        </dd>
        <dt className="text-slate-500">작성</dt>
        <dd>
          <Link
            to={`/orgs/${orgId}/agents/${a.createdByAgentId}`}
            className="hover:underline"
          >
            {nameOf(agents, a.createdByAgentId)}
          </Link>
          {" · "}
          <Link
            to={`/orgs/${orgId}/runs/${a.createdByRunId}`}
            className="text-brand-600 hover:underline"
          >
            {runLabel(a.createdByRunId)}
          </Link>
        </dd>
        <dt className="text-slate-500">기록</dt>
        <dd>{formatTime(a.createdAt)}</dd>
      </dl>
      <p className="mb-2 text-xs text-slate-400">
        에이전트가 남긴 원문 그대로입니다. 산출물이 있다고 결과가 확인된 것은
        아닙니다.
      </p>
      {a.format === "markdown" ? (
        <Markdown
          text={a.content}
          className="card p-4 text-sm text-slate-800"
          data-testid="artifact-content"
        />
      ) : (
        <pre
          className="card overflow-auto p-4 font-sans text-sm break-words whitespace-pre-wrap text-slate-800"
          data-testid="artifact-content"
        >
          {a.content}
        </pre>
      )}
    </Page>
  );
}
