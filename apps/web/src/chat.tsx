import {
  messageBodyMaxLength,
  type Agent,
  type ConversationMessage,
} from "@babojubot/contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAgent, useConversation, useSendMessage } from "./api.ts";
import {
  AgentStatusBadge,
  formatTime,
  Loading,
  LoadError,
  runLabel,
} from "./ui.tsx";

/**
 * 조직 › Lead 대화. 사용자 메시지는 저장되면 Lead를 깨우고, Lead가 실행 중이면 다음 실행 시도에 반영된다.
 * 메시지의 저장·전달 상태와 Lead의 실행 상태를 따로 보인다.
 */
export function LeadChat({ orgId, lead }: { orgId: string; lead: Agent }) {
  const messages = useConversation(orgId);
  const agent = useAgent(orgId, lead.id);
  const running = agent.data?.recentRuns.find((r) => r.status === "running");
  const end = useRef<HTMLDivElement>(null);
  const count = messages.data?.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">Lead 대화</h1>
        <Link
          to={`/orgs/${orgId}/agents/${lead.id}`}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          {lead.name}
        </Link>
        {agent.data && <AgentStatusBadge status={agent.data.status} />}
        {running && (
          <Link
            to={`/orgs/${orgId}/runs/${running.id}`}
            className="text-xs text-brand-600 hover:underline"
          >
            {runLabel(running.id)}
          </Link>
        )}
      </div>

      {messages.isPending ? (
        <Loading />
      ) : messages.isError ? (
        <LoadError what="대화" onRetry={() => void messages.refetch()} />
      ) : !messages.data.length ? (
        <div
          className="card animate-fade-up p-8 text-center"
          data-testid="lead-chat-empty"
        >
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-xl">
            🎯
          </div>
          <div className="font-semibold">연구 목표와 완료 기준을 정하세요</div>
          <p className="mt-1 text-sm text-slate-500">
            Research Lead와 대화로 이 조직의 연구 목표와 완료 기준을 합의하는
            것부터 시작합니다.
          </p>
        </div>
      ) : (
        <ol className="space-y-3" aria-label="대화">
          {messages.data.map((m) => (
            <MessageBubble key={m.id} message={m} orgId={orgId} lead={lead} />
          ))}
        </ol>
      )}
      <div ref={end} />
      <Composer orgId={orgId} leadRunning={!!running} />
    </div>
  );
}

function MessageBubble({
  message: m,
  orgId,
  lead,
}: {
  message: ConversationMessage;
  orgId: string;
  lead: Agent;
}) {
  const mine = m.author === "owner";
  const runId = mine ? m.deliveredToRunId : m.sentByRunId;
  return (
    <li
      className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
      data-author={m.author}
    >
      <div className="mb-1 text-[11px] text-slate-400">
        {mine ? "나" : lead.name} · {formatTime(m.createdAt)}
      </div>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap ${mine ? "bg-brand-600 text-white" : "card text-slate-800"}`}
      >
        {m.body}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        {runId ? (
          <Link
            to={`/orgs/${orgId}/runs/${runId}`}
            className="hover:text-brand-600 hover:underline"
          >
            {mine
              ? `${runLabel(runId)}에 전달됨`
              : `${runLabel(runId)}에서 보냄`}
          </Link>
        ) : (
          mine && <span>다음 실행 시도 대기</span>
        )}
      </div>
    </li>
  );
}

function Composer({
  orgId,
  leadRunning,
}: {
  orgId: string;
  leadRunning: boolean;
}) {
  const [text, setText] = useState("");
  const send = useSendMessage(orgId);
  const submit = async () => {
    const body = text.trim();
    if (!body || send.isPending) return;
    try {
      await send.mutateAsync(body);
      setText((current) => (current.trim() === body ? "" : current));
    } catch {
      // 오류는 send.error로 보이고 입력은 그대로 둔다.
    }
  };
  return (
    <form
      className="sticky bottom-0 mt-6 bg-canvas/90 pt-2 pb-4 backdrop-blur"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {send.isPending && (
        <p className="mb-2 text-right text-xs text-slate-400" role="status">
          전송 중…
        </p>
      )}
      <div className="card flex items-end gap-2 p-2">
        <label htmlFor="lead-message" className="sr-only">
          Lead에게 보낼 메시지
        </label>
        <textarea
          id="lead-message"
          value={text}
          rows={2}
          maxLength={messageBodyMaxLength}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Research Lead에게 메시지 (Enter 보내기, Shift+Enter 줄바꿈)"
          className="min-h-10 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
        />
        <button
          className="btn-primary"
          disabled={!text.trim() || send.isPending}
        >
          보내기
        </button>
      </div>
      {send.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          메시지를 보내지 못했습니다. 입력은 그대로 두었으니 다시 시도하세요.
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400">
        {leadRunning
          ? "Lead가 실행 중입니다. 지금 보내는 메시지는 다음 실행 시도에 반영됩니다."
          : "보낸 메시지는 Lead를 깨워 다음 실행 시도에 반영됩니다."}
      </p>
    </form>
  );
}
