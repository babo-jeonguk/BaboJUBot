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
  useConversation,
  useConversations,
  useMarkConversationRead,
  useOrganization,
  useSendMessage,
  useStartConversation,
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
} from "./ui.tsx";

const deliveryLabel: Record<MessageDelivery, string> = {
  next_run: "다음 실행 시도에 반영",
  interrupt: "중단하고 반영",
};

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
 * 사용자 메시지는 저장되면 Lead를 깨우고, Lead가 실행 중이면 다음 실행 시도에 반영된다.
 * `중단하고 반영`을 고르면 진행 중 실행 시도를 취소하고 그 메시지를 다음 실행 시도에 담는다.
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
      <MessageScroller count={messages.data?.length ?? 0}>
        {messages.isPending ? (
          <Loading />
        ) : messages.isError ? (
          <LoadError what="대화" onRetry={() => void messages.refetch()} />
        ) : !messages.data.length ? (
          conversationId === undefined || summary?.isDefault ? (
            <div
              className="card animate-fade-up p-8 text-center"
              data-testid="lead-chat-empty"
            >
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-xl">
                🎯
              </div>
              <div className="font-semibold">
                연구 목표와 완료 기준을 정하세요
              </div>
            </div>
          ) : null
        ) : (
          <MessageList messages={messages.data} orgId={orgId} lead={lead} />
        )}
      </MessageScroller>
      <Composer orgId={orgId} lead={lead} send={send} />
    </>
  );
}

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
        <div className="mt-1 text-[11px] font-medium text-amber-700">
          ⤵ {deliveryLabel.interrupt}
        </div>
      )}
      {mine && (
        <div className="mt-1 text-[11px] text-slate-400">
          {runId ? (
            <Link
              to={`/orgs/${orgId}/runs/${runId}`}
              title={runLabel(runId)}
              className="hover:text-brand-600 hover:underline"
            >
              ✓ 전달됨
            </Link>
          ) : (
            <span>다음 실행 시도 대기</span>
          )}
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

function Composer({
  orgId,
  lead,
  send,
  autoFocus = false,
}: {
  orgId: string;
  lead: Agent;
  send: OwnerMessageSender;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<MessageDelivery>("next_run");
  const stage = useOrganization(orgId).data?.stage;
  const paused = useAgent(orgId, lead.id).data?.paused ?? false;
  const held = heldBy(stage, paused);
  // 중단은 제어 명령이라 끝난 조직에서는 고를 수 없다(서버도 409 `organization_closed`).
  // 고른 뒤 다른 탭에서 조직이 끝나도 고를 수 없는 값으로 보내지 않게, 그때는 다음 실행 시도로 보낸다.
  const closed = stage !== undefined && isClosedStage(stage);
  const chosen: MessageDelivery = closed ? "next_run" : delivery;
  const submit = async () => {
    const body = text.trim();
    if (!body || send.isPending) return;
    try {
      await send.mutateAsync({ body, delivery: chosen });
      setText((current) => (current.trim() === body ? "" : current));
      setDelivery("next_run");
    } catch {
      // 오류는 send.isError로 보이고 입력과 전달 방식은 그대로 둔다.
    }
  };
  return (
    <form
      className="shrink-0 pt-3"
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
          rows={1}
          autoFocus={autoFocus}
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
          placeholder="Research Lead에게 메시지"
          className="min-h-10 max-h-[40vh] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
        />
        <button
          className="btn-primary"
          disabled={!text.trim() || send.isPending}
        >
          보내기
        </button>
      </div>
      <fieldset className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
        <legend className="sr-only">전달 방식</legend>
        {(["next_run", "interrupt"] as const).map((d) => (
          <label key={d} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="delivery"
              value={d}
              checked={chosen === d}
              disabled={send.isPending || (d === "interrupt" && closed)}
              onChange={() => setDelivery(d)}
              className="accent-brand-600"
            />
            {deliveryLabel[d]}
          </label>
        ))}
      </fieldset>
      {send.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          보내지 못했습니다. 다시 시도하세요.
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
