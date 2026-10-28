import {
  defaultConversationTitle,
  isClosedStage,
  messageBodyMaxLength,
  type Agent,
  type ConversationMessage,
  type ConversationSummary,
  type LifecycleStage,
  type MessageDelivery,
} from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  ApiError,
  useAgent,
  useControlAgent,
  useConversation,
  useConversations,
  useMarkConversationRead,
  useOrganization,
  useQueuedMessageCommand,
  useSendMessage,
  useStartConversation,
  type QueuedMessageCommand,
} from "./api.ts";
import { Markdown } from "./markdown.tsx";
import {
  AgentStatusBadge,
  formatTime,
  Loading,
  LoadError,
  NotFound,
  PausedBadge,
  runLabel,
  RunStatusBadge,
  Tip,
} from "./ui.tsx";
import { useToast } from "./toast.tsx";

/** 아직 보내지 않은 새 대화의 주소 조각. 첫 메시지를 보내면 그 대화의 주소로 바뀐다. */
export const newConversationSlug = "new";

const chatPath = (orgId: string, conversation?: ConversationSummary | "new") =>
  conversation === "new"
    ? `/orgs/${orgId}/chat/${newConversationSlug}`
    : conversation && !conversation.isDefault
      ? `/orgs/${orgId}/chat/${conversation.id}`
      : `/orgs/${orgId}/chat`;

/**
 * 조직 › Lead 대화. 왼쪽(좁은 화면은 머리의 목록 버튼)에서 대화를 고르고, 오른쪽에서 고른 대화를 주고받는다.
 * `conversationId`가 없으면 기본 대화, `new`면 아직 저장하지 않은 새 대화다. 새 대화는 첫 메시지와 함께 생긴다.
 * 사용자 메시지는 저장되면 Lead를 깨운다. Lead가 실행 중이면 입력창 버튼으로 `줄 세우기`(다음 실행 시도에 담음)와
 * `중단하고 보내기`(진행 중 실행 시도를 취소하고 그 메시지만 다음 실행 시도에 담음)를 고르고, 입력이 비면 `실행 중단`만 한다.
 * 아직 실행 시도가 받지 않은 사용자 메시지(줄 세운 메시지)는 대화가 아니라 입력창 바로 위 목록에 있고, 받으면 대화로 옮겨진다.
 */
export function LeadChat({
  orgId,
  lead,
  conversationId,
}: {
  orgId: string;
  lead: Agent;
  conversationId?: string;
}) {
  const conversations = useConversations(orgId);
  const drafting = conversationId === newConversationSlug;
  const current = drafting
    ? undefined
    : conversations.data?.find((c) =>
        conversationId ? c.id === conversationId : c.isDefault
      );
  const title = drafting
    ? "새 대화"
    : conversationId
      ? (current?.title ?? "…")
      : defaultConversationTitle;
  const [sheet, setSheet] = useState(false);
  const list = (
    <ConversationList
      orgId={orgId}
      conversations={conversations}
      activeId={drafting ? undefined : current?.id}
      drafting={drafting}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 gap-5">
      <aside className="hidden w-56 shrink-0 flex-col md:flex">{list}</aside>
      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-white p-4 shadow-pop data-[state=closed]:animate-slide-out-left data-[state=open]:animate-slide-in-left"
            onClick={(e) =>
              (e.target as HTMLElement).closest("a") && setSheet(false)
            }
          >
            <Dialog.Title className="sr-only">대화 목록</Dialog.Title>
            {list}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          orgId={orgId}
          lead={lead}
          title={title}
          unreadElsewhere={
            conversations.data?.some((c) => c.unread && c.id !== current?.id) ??
            false
          }
          onOpenList={() => setSheet(true)}
        />
        {drafting ? (
          <DraftThread key="new" orgId={orgId} lead={lead} />
        ) : (
          <Thread
            key={conversationId ?? "default"}
            orgId={orgId}
            lead={lead}
            conversationId={conversationId}
            summary={current}
          />
        )}
      </div>
    </div>
  );
}

/** 대화 목록: 새 대화 버튼, 맨 위의 기본 대화, 그 아래 마지막 활동 순의 대화. Lead가 답한 뒤 보지 않은 대화에는 점이 붙는다. */
function ConversationList({
  orgId,
  conversations,
  activeId,
  drafting,
}: {
  orgId: string;
  conversations: ReturnType<typeof useConversations>;
  activeId: string | undefined;
  drafting: boolean;
}) {
  return (
    <nav aria-label="대화 목록" className="flex min-h-0 flex-1 flex-col">
      <Link
        to={chatPath(orgId, "new")}
        aria-current={drafting ? "page" : undefined}
        className="btn-soft w-full justify-start aria-[current=page]:bg-brand-50 aria-[current=page]:ring-brand-200"
      >
        <span aria-hidden className="text-base leading-none text-brand-600">
          ＋
        </span>
        새 대화
      </Link>
      <div className="scrollbar-thin -mx-1 mt-3 min-h-0 flex-1 overflow-y-auto px-1">
        {conversations.isPending ? (
          <Loading />
        ) : conversations.isError ? (
          <LoadError
            what="대화 목록"
            onRetry={() => void conversations.refetch()}
          />
        ) : (
          <ul className="space-y-0.5">
            {conversations.data.map((c) => (
              <li
                key={c.id}
                className={
                  c.isDefault && conversations.data.length > 1
                    ? "mb-2 border-b border-slate-200/80 pb-2"
                    : undefined
                }
              >
                <ConversationLink
                  orgId={orgId}
                  conversation={c}
                  active={c.id === activeId}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

function ConversationLink({
  orgId,
  conversation: c,
  active,
}: {
  orgId: string;
  conversation: ConversationSummary;
  active: boolean;
}) {
  return (
    <Link
      to={chatPath(orgId, c)}
      aria-current={active ? "page" : undefined}
      data-unread={c.unread || undefined}
      className={`group flex flex-col gap-0.5 rounded-xl px-3 py-2 transition ${active ? "bg-white shadow-card ring-1 ring-slate-900/[0.06]" : "hover:bg-slate-900/5"}`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm ${active || c.unread ? "font-semibold text-slate-900" : "text-slate-700"}`}
        >
          {c.title}
        </span>
        {c.unread && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-brand-500"
            data-testid="conversation-unread"
          >
            <span className="sr-only">읽지 않음</span>
          </span>
        )}
      </span>
      <time
        dateTime={c.lastActivityAt}
        className="text-[11px] text-slate-400 tabular-nums"
      >
        {shortTime(c.lastActivityAt)}
      </time>
    </Link>
  );
}

const clock = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const day = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
});
/** 목록의 짧은 시각: 오늘이면 시:분, 아니면 날짜. */
function shortTime(iso: string) {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString()
    ? clock.format(at)
    : day.format(at);
}

function ChatHeader({
  orgId,
  lead,
  title,
  unreadElsewhere,
  onOpenList,
}: {
  orgId: string;
  lead: Agent;
  title: string;
  unreadElsewhere: boolean;
  onOpenList: () => void;
}) {
  const agent = useAgent(orgId, lead.id);
  const running = agent.data?.recentRuns.find((r) => r.status === "running");
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={onOpenList}
        aria-label="대화 목록"
        className="btn-ghost relative -ml-2 px-2 md:hidden"
      >
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8" />
        </svg>
        {unreadElsewhere && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-brand-500" />
        )}
      </button>
      <h1 className="min-w-0 truncate text-xl font-semibold">{title}</h1>
      <Link
        to={`/orgs/${orgId}/agents/${lead.id}`}
        className="text-sm text-slate-500 hover:text-slate-800"
      >
        {lead.name}
      </Link>
      {agent.data && <AgentStatusBadge status={agent.data.status} />}
      {agent.data?.paused && <PausedBadge />}
      {running && (
        <Link
          to={`/orgs/${orgId}/runs/${running.id}`}
          title={runLabel(running.id)}
          className="flex items-center gap-1.5 text-xs text-brand-600 hover:underline"
        >
          실행 중 →
          {running.cancelReason && (
            <RunStatusBadge
              status={running.status}
              cancelReason={running.cancelReason}
            />
          )}
        </Link>
      )}
      <Link
        to={chatPath(orgId, "new")}
        aria-label="새 대화"
        className="btn-ghost ml-auto px-2 text-lg leading-none text-brand-600 md:hidden"
      >
        ＋
      </Link>
    </div>
  );
}

/** 문서가 보이는가. 다른 탭에 가려져 있으면 대화를 본 것으로 치지 않는다. */
function usePageVisible() {
  return useSyncExternalStore(
    (notify) => {
      document.addEventListener("visibilitychange", notify);
      return () => document.removeEventListener("visibilitychange", notify);
    },
    () => document.visibilityState === "visible"
  );
}

/** 저장된 대화 하나: 메시지 목록과 입력창. 보이는 동안 Lead가 보낸 메시지를 읽은 것으로 표시한다. */
function Thread({
  orgId,
  lead,
  conversationId,
  summary,
}: {
  orgId: string;
  lead: Agent;
  conversationId: string | undefined;
  summary: ConversationSummary | undefined;
}) {
  const messages = useConversation(orgId, conversationId);
  const send = useSendMessage(orgId, conversationId);
  const { mutate: markRead } = useMarkConversationRead(orgId);
  const visible = usePageVisible();
  const last = messages.data?.at(-1);
  const transcript = messages.data?.filter((m) => !isQueued(m)) ?? [];
  const queued = messages.data?.filter(isQueued) ?? [];
  const marked = useRef<string | null>(null);
  const unreadId = summary?.unread ? summary.id : undefined;
  const lastId = last?.id;
  useEffect(() => {
    // 같은 메시지까지는 한 번만 표시한다.
    if (!unreadId || !lastId || !visible || marked.current === lastId) return;
    marked.current = lastId;
    markRead({ conversationId: unreadId, upToMessageId: lastId });
  }, [unreadId, lastId, visible, markRead]);

  if (
    messages.isError &&
    messages.error instanceof ApiError &&
    messages.error.status === 404
  )
    return <NotFound what="대화" />;
  return (
    <>
      <MessageScroller count={transcript.length}>
        {messages.isPending ? (
          <Loading />
        ) : messages.isError ? (
          <LoadError what="대화" onRetry={() => void messages.refetch()} />
        ) : !transcript.length ? (
          conversationId === undefined || summary?.isDefault ? (
            <div
              className="card animate-fade-up p-8 text-center"
              data-testid="lead-chat-empty"
            >
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-xl">
                💬
              </div>
              <div className="font-semibold">아직 대화가 없습니다</div>
            </div>
          ) : null
        ) : (
          <MessageList messages={transcript} orgId={orgId} lead={lead} />
        )}
      </MessageScroller>
      <Composer
        orgId={orgId}
        lead={lead}
        send={send}
        conversationId={conversationId}
        queued={queued}
      />
    </>
  );
}

/** 줄 세운 메시지: 실행 시도가 아직 받지 않은 사용자 메시지. 조직·Lead가 일시정지라 기다리는 메시지도 같다. */
const isQueued = (m: ConversationMessage) =>
  m.author === "owner" && m.deliveredToRunId === null;

/** 아직 저장하지 않은 새 대화. 첫 메시지를 보내면 대화가 생기고 그 대화의 주소로 옮긴다. */
function DraftThread({ orgId, lead }: { orgId: string; lead: Agent }) {
  const start = useStartConversation(orgId);
  const navigate = useNavigate();
  return (
    <>
      <MessageScroller count={0} />
      <Composer
        orgId={orgId}
        lead={lead}
        autoFocus
        send={{
          isPending: start.isPending,
          isError: start.isError,
          mutateAsync: async (input) => {
            const { conversation } = await start.mutateAsync(input);
            void navigate(`/orgs/${orgId}/chat/${conversation.id}`, {
              replace: true,
            });
          },
        }}
      />
    </>
  );
}

function MessageScroller({
  count,
  children,
}: {
  count: number;
  children?: ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);
  return (
    <div className="scrollbar-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      {children}
      <div ref={end} />
    </div>
  );
}

function MessageList({
  messages,
  orgId,
  lead,
}: {
  messages: ConversationMessage[];
  orgId: string;
  lead: Agent;
}) {
  return (
    <ol className="space-y-3" aria-label="대화">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} orgId={orgId} lead={lead} />
      ))}
    </ol>
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
        {mine ? "나" : lead.name} ·{" "}
        {!mine && runId ? (
          <Link
            to={`/orgs/${orgId}/runs/${runId}`}
            title={runLabel(runId)}
            className="hover:text-brand-600 hover:underline"
          >
            {formatTime(m.createdAt)}
          </Link>
        ) : (
          formatTime(m.createdAt)
        )}
      </div>
      <Markdown
        text={m.body}
        tone={mine ? "inverse" : "default"}
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${mine ? "bg-brand-600 text-white" : "card text-slate-800"}`}
      />
      {m.delivery === "interrupt" && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-rose-600">
          <BoltIcon className="h-3 w-3" />
          중단하고 보냄
        </div>
      )}
      {mine && runId && (
        <div className="mt-1 text-[11px] text-slate-400">
          <Link
            to={`/orgs/${orgId}/runs/${runId}`}
            title={runLabel(runId)}
            className="hover:text-brand-600 hover:underline"
          >
            ✓ 전달됨
          </Link>
        </div>
      )}
    </li>
  );
}

/** 메시지가 지금 Lead를 깨우지 못하는 이유. 메시지는 남아 재개 뒤(중단·완료면 전달되지 않음) 전달된다. */
function heldBy(stage: LifecycleStage | undefined, leadPaused: boolean) {
  if (stage === "paused") return "조직이 일시정지 중입니다 · 재개하면 전달";
  if (stage === "stopped") return "중단된 조직입니다";
  if (stage === "completed") return "최종 완료된 조직입니다";
  if (leadPaused) return "Lead가 일시정지 중입니다 · 재개하면 전달";
  return null;
}

type OwnerMessageSender = {
  mutateAsync: (input: {
    body: string;
    delivery: MessageDelivery;
  }) => Promise<unknown>;
  isPending: boolean;
  isError: boolean;
};

/**
 * 입력창. 버튼은 Lead 상태를 따라 바뀐다. 실행 중이 아니면 `보내기` 하나, 실행 중이면 입력이 빌 때 `실행 중단`,
 * 입력이 있으면 `중단하고 보내기`와 `줄 세우기`다. Enter는 언제나 `줄 세우기`(실행 중이 아니면 그냥 보내기)다.
 * 고른 방식은 메시지마다 새로 정하며 남지 않는다. 실행 중 여부는 Lead 상세의 진행 중 실행 시도로 보고 Event로 바로 바뀐다.
 * 이미 취소 정리 중인 실행 시도나 끝난 조직은 실행 중으로 치지 않는다(끝난 조직은 중단이 제어 명령이라 서버도 409).
 *
 * 바로 위에는 이 대화의 줄 세운 메시지가 오래된 것부터 있다. `고치기`는 메시지를 거두고 그 글을 입력창 맨 앞에 되돌리며,
 * 입력창이 비었을 때 ↑ 키는 가장 최근 메시지를 같은 방식으로 되돌린다. `취소`는 거두기만 하고, `지금 보내기`는
 * Lead가 실행 중이고 조직·Lead가 일시정지가 아닐 때만 보인다. 실행 시도가 먼저 받았으면 토스트로 알리고 대화로 옮겨 보인다.
 */
function Composer({
  orgId,
  lead,
  send,
  conversationId,
  queued = [],
  autoFocus = false,
}: {
  orgId: string;
  lead: Agent;
  send: OwnerMessageSender;
  conversationId?: string;
  queued?: ConversationMessage[];
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const stage = useOrganization(orgId).data?.stage;
  const agent = useAgent(orgId, lead.id).data;
  const stop = useControlAgent(orgId, lead.id);
  const paused = agent?.paused ?? false;
  const held = heldBy(stage, paused);
  const closed = stage !== undefined && isClosedStage(stage);
  const running =
    !closed &&
    (agent?.recentRuns.some(
      (r) => r.status === "running" && r.cancelReason === null
    ) ??
      false);
  const typed = text.trim() !== "";
  const busy = send.isPending || stop.isPending;
  const submit = async (delivery: MessageDelivery) => {
    const body = text.trim();
    if (!body || busy) return;
    try {
      await send.mutateAsync({ body, delivery });
      setText((current) => (current.trim() === body ? "" : current));
    } catch {
      // 오류는 send.isError로 보이고 입력은 그대로 둔다.
    }
  };
  const stopRun = () =>
    stop.mutate("interrupt", { onSuccess: () => input.current?.focus() });
  const command = useQueuedMessageCommand(orgId, conversationId);
  const toast = useToast();
  const queuedBusy = command.isPending;
  const runQueued = async (
    message: ConversationMessage,
    kind: QueuedMessageCommand
  ) => {
    if (queuedBusy) return undefined;
    try {
      return await command.mutateAsync({
        messageId: message.id,
        command: kind,
      });
    } catch (error) {
      toast({
        message:
          error instanceof ApiError && error.code === "message_delivered"
            ? "이미 전달된 메시지입니다"
            : kind === "send_now"
              ? "보내지 못했습니다. 다시 시도하세요."
              : "취소하지 못했습니다. 다시 시도하세요.",
      });
      return undefined;
    }
  };
  /** 거둔 메시지의 글을 입력창 맨 앞에 되돌린다. 쓰던 글은 빈 줄 하나 뒤에 남는다. */
  const pullBack = async (message: ConversationMessage) => {
    const withdrawn = await runQueued(message, "withdraw");
    if (!withdrawn) return;
    setText((current) =>
      current.trim() ? `${withdrawn.body}\n\n${current}` : withdrawn.body
    );
    input.current?.focus();
  };
  return (
    <form
      className="shrink-0 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("next_run");
      }}
    >
      {queued.length > 0 && (
        <QueuedMessages
          messages={queued}
          canSendNow={running && !held}
          busy={queuedBusy}
          onEdit={(m) => void pullBack(m)}
          onCancel={(m) => void runQueued(m, "withdraw")}
          onSendNow={(m) => void runQueued(m, "send_now")}
        />
      )}
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
          ref={input}
          value={text}
          rows={1}
          autoFocus={autoFocus}
          maxLength={messageBodyMaxLength}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            const latest = queued.at(-1);
            if (
              e.key === "ArrowUp" &&
              latest &&
              text.trim() === "" &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void pullBack(latest);
              return;
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit("next_run");
            }
          }}
          placeholder="Research Lead에게 메시지"
          className="min-h-10 max-h-[40vh] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
        />
        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          {!running ? (
            <IconButton
              label="보내기"
              type="submit"
              tone="primary"
              disabled={!typed || busy}
            >
              <ArrowUpIcon />
            </IconButton>
          ) : !typed ? (
            <IconButton
              label="실행 중단"
              tone="stop"
              disabled={busy}
              onClick={stopRun}
            >
              <StopIcon />
            </IconButton>
          ) : (
            <>
              <IconButton
                label="중단하고 보내기"
                tone="danger"
                disabled={busy}
                onClick={() => void submit("interrupt")}
              >
                <BoltIcon className="h-[18px] w-[18px]" />
              </IconButton>
              <IconButton
                label="줄 세우기"
                type="submit"
                tone="primary"
                disabled={busy}
              >
                <QueueIcon />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {send.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          보내지 못했습니다. 다시 시도하세요.
        </p>
      )}
      {stop.isError && !stop.isPending && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          중단하지 못했습니다. 다시 시도하세요.
        </p>
      )}
      {held && (
        <p role="status" className="mt-2 text-xs text-amber-700">
          {held}
        </p>
      )}
    </form>
  );
}

/**
 * 입력창 바로 위의 줄 세운 메시지 목록. 오래된 것이 위, 가장 최근 것이 입력창 바로 위다.
 * 항목 버튼은 오른쪽 위에 작게, 마우스를 올리거나 키보드 초점이 항목 안에 있을 때 보이고 마우스가 없는 화면에서는 늘 보인다.
 */
function QueuedMessages({
  messages,
  canSendNow,
  busy,
  onEdit,
  onCancel,
  onSendNow,
}: {
  messages: ConversationMessage[];
  canSendNow: boolean;
  busy: boolean;
  onEdit: (message: ConversationMessage) => void;
  onCancel: (message: ConversationMessage) => void;
  onSendNow: (message: ConversationMessage) => void;
}) {
  return (
    <section aria-labelledby="queued-messages-title" className="mb-2">
      <h2
        id="queued-messages-title"
        className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-slate-500"
      >
        <QueueIcon className="h-3.5 w-3.5" />줄 세운 메시지{" "}
        <span className="tabular-nums text-slate-400">{messages.length}</span>
      </h2>
      <ol className="scrollbar-thin -mx-1 max-h-44 space-y-1 overflow-y-auto px-1 pb-0.5">
        {messages.map((m) => (
          <li
            key={m.id}
            data-testid="queued-message"
            className="group/row relative rounded-xl bg-white/80 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200/80"
          >
            <p className="line-clamp-2 break-words whitespace-pre-wrap [@media(hover:none)]:pr-24">
              {m.delivery === "interrupt" && (
                <BoltIcon className="mr-1 -mt-0.5 inline h-3 w-3 text-rose-600" />
              )}
              {m.body}
            </p>
            <div className="absolute top-1 right-1 opacity-0 transition group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">
              <div
                role="group"
                aria-label={`줄 세운 메시지: ${m.body.slice(0, 30)}`}
                className="flex gap-0.5 rounded-lg bg-white p-0.5 shadow-sm ring-1 ring-slate-200"
              >
                <QueuedAction
                  label="고치기"
                  disabled={busy}
                  onClick={() => onEdit(m)}
                >
                  <PencilIcon />
                </QueuedAction>
                <QueuedAction
                  label="취소"
                  disabled={busy}
                  onClick={() => onCancel(m)}
                >
                  <CrossIcon />
                </QueuedAction>
                {canSendNow && m.delivery !== "interrupt" && (
                  <QueuedAction
                    label="지금 보내기"
                    tone="danger"
                    disabled={busy}
                    onClick={() => onSendNow(m)}
                  >
                    <BoltIcon className="h-3.5 w-3.5" />
                  </QueuedAction>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 줄 세운 메시지 항목의 작은 아이콘 버튼. 이름은 `aria-label`과 tooltip에 같은 글로 보인다. */
function QueuedAction({
  label,
  tone = "default",
  disabled,
  onClick,
  children,
}: {
  label: string;
  tone?: "default" | "danger";
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`flex h-7 w-7 items-center justify-center rounded-md transition focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-40 ${tone === "danger" ? "text-rose-600 hover:bg-rose-50" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}
      >
        {children}
      </button>
    </Tip>
  );
}

const iconButtonTone = {
  primary:
    "bg-brand-600 text-white shadow-sm shadow-brand-600/30 hover:bg-brand-700",
  danger:
    "bg-rose-600 text-white shadow-sm shadow-rose-600/30 hover:bg-rose-700",
  stop: "bg-slate-900 text-white hover:bg-slate-700",
} as const;

/** 아이콘만 있는 둥근 버튼. 이름은 `aria-label`과 tooltip에 같은 글로 보인다. */
function IconButton({
  label,
  tone,
  type = "button",
  disabled,
  onClick,
  children,
}: {
  label: string;
  tone: keyof typeof iconButtonTone;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tip content={label}>
      <button
        type={type}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition duration-150 ease-out select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-45 ${iconButtonTone[tone]}`}
      >
        {children}
      </button>
    </Tip>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 16V4.5M5 9.5l5-5 5 5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="currentColor"
    >
      <rect x="4.5" y="4.5" width="11" height="11" rx="2" />
    </svg>
  );
}

/** 지금 끊고 들어간다: 번개. 보낸 메시지의 `중단하고 보냄` 표시에도 쓴다. */
function BoltIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={className}
      fill="currentColor"
    >
      <path d="M11.3 1.8 4 11.2h5.1l-1 7 7.4-9.6h-5.2l1-6.8Z" />
    </svg>
  );
}

/** 목록 끝에 더한다: 줄 셋과 더하기. 줄 세운 메시지 목록의 머리에도 쓴다. */
function QueueIcon({
  className = "h-[18px] w-[18px]",
}: {
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    >
      <path d="M3.5 5h10M3.5 9.5h10M3.5 14h5.5M15 11.5v6M12 14.5h6" />
    </svg>
  );
}

/** 고치기: 연필. */
function PencilIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.5 4.5l3 3L7 16H4v-3l8.5-8.5Z" />
    </svg>
  );
}

/** 취소: 엑스. */
function CrossIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  );
}
