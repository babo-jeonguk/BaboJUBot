import {
  defaultConversationTitle,
  isClosedStage,
  maxQueuedMessages,
  messageBodyMaxLength,
  ownerActions,
  type Agent,
  type AgentDetail,
  type ConversationMessage,
  type ConversationSummary,
  type LifecycleStage,
  type LeadRunState,
  type MessageDelivery,
  type OwnerActionsDecision,
} from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  useConversations,
  useMarkConversationRead,
  useOrganization,
  useQueuedMessageCommand,
  useQueuedMessages,
  useSendMessage,
  useStartConversation,
  type QueuedMessageCommand,
} from "./api.ts";
import { Markdown } from "./markdown.tsx";
import {
  afterListChange,
  listShape,
  shouldTrim,
  trimConversation,
  useConversation,
  type ListShape,
} from "./transcript-window.ts";
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
 * 대화는 Lead가 받은 순서다. 끝난 조직(중단·최종 완료)은 메시지를 받지 않으므로 입력창 대신 상태만 보이고 새 대화도 시작할 수 없다.
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
  const stage = useOrganization(orgId).data?.stage;
  const closed = stage !== undefined && isClosedStage(stage);
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
      closed={closed}
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
          closed={closed}
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

/**
 * 대화 목록: 새 대화 버튼, 맨 위의 기본 대화, 그 아래 마지막 활동 순의 대화. Lead가 답한 뒤 보지 않은 대화에는 점이 붙는다.
 * 끝난 조직에서는 새 대화 버튼이 비활성이다.
 */
function ConversationList({
  orgId,
  conversations,
  activeId,
  drafting,
  closed,
}: {
  orgId: string;
  conversations: ReturnType<typeof useConversations>;
  activeId: string | undefined;
  drafting: boolean;
  closed: boolean;
}) {
  const label = (
    <>
      <span aria-hidden className="text-base leading-none text-brand-600">
        ＋
      </span>
      새 대화
    </>
  );
  return (
    <nav aria-label="대화 목록" className="flex min-h-0 flex-1 flex-col">
      {closed ? (
        <button
          type="button"
          disabled
          className="btn-soft w-full justify-start disabled:opacity-50"
        >
          {label}
        </button>
      ) : (
        <Link
          to={chatPath(orgId, "new")}
          aria-current={drafting ? "page" : undefined}
          className="btn-soft w-full justify-start aria-[current=page]:bg-brand-50 aria-[current=page]:ring-brand-200"
        >
          {label}
        </Link>
      )}
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
  closed,
  unreadElsewhere,
  onOpenList,
}: {
  orgId: string;
  lead: Agent;
  title: string;
  closed: boolean;
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
      {closed ? (
        <button
          type="button"
          disabled
          aria-label="새 대화"
          className="btn-ghost ml-auto px-2 text-lg leading-none text-brand-600 disabled:opacity-40 md:hidden"
        >
          ＋
        </button>
      ) : (
        <Link
          to={chatPath(orgId, "new")}
          aria-label="새 대화"
          className="btn-ghost ml-auto px-2 text-lg leading-none text-brand-600 md:hidden"
        >
          ＋
        </Link>
      )}
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

/**
 * 저장된 대화 하나: 대화에 놓인 메시지와 입력창. 보이는 동안 Lead가 보낸 메시지를 읽은 것으로 표시한다.
 * 메시지는 받은 순서이며 처음에는 가장 최근 쪽만 받고, 위로 올리면 더 오래된 쪽을 받는다(`Transcript`).
 * 줄 세운 메시지는 따로 받아 입력창 위에 둔다.
 */
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
  const history = useConversation(orgId, conversationId);
  const queuedQuery = useQueuedMessages(orgId, conversationId);
  const send = useSendMessage(orgId, conversationId);
  const { mutate: markRead } = useMarkConversationRead(orgId);
  const visible = usePageVisible();
  const transcript = useMemo(
    () =>
      history.data?.pages
        .slice()
        .reverse()
        .flatMap((p) => p.messages) ?? [],
    [history.data]
  );
  const queued = queuedQuery.data ?? [];
  const queryClient = useQueryClient();
  const trim = useCallback(
    () => trimConversation(queryClient, orgId, conversationId),
    [queryClient, orgId, conversationId]
  );
  const marked = useRef<string | null>(null);
  const unreadId = summary?.unread ? summary.id : undefined;
  // 본 위치는 받은 순서의 마지막 메시지까지다.
  const lastId = transcript.at(-1)?.id;
  useEffect(() => {
    // 같은 메시지까지는 한 번만 표시한다.
    if (!unreadId || !lastId || !visible || marked.current === lastId) return;
    marked.current = lastId;
    markRead({ conversationId: unreadId, upToMessageId: lastId });
  }, [unreadId, lastId, visible, markRead]);

  if (
    history.isError &&
    history.error instanceof ApiError &&
    history.error.status === 404
  )
    return <NotFound what="대화" />;
  return (
    <>
      {history.isPending ? (
        <div className="min-h-0 flex-1">
          <Loading />
        </div>
      ) : history.isError && !history.data ? (
        <div className="min-h-0 flex-1">
          <LoadError what="대화" onRetry={() => void history.refetch()} />
        </div>
      ) : !transcript.length ? (
        <div className="min-h-0 flex-1">
          {(conversationId === undefined || summary?.isDefault) && (
            <div
              className="card animate-fade-up p-8 text-center"
              data-testid="lead-chat-empty"
            >
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-xl">
                💬
              </div>
              <div className="font-semibold">아직 대화가 없습니다</div>
            </div>
          )}
        </div>
      ) : (
        <Transcript
          messages={transcript}
          hasOlder={history.hasNextPage}
          loadingOlder={history.isFetchingNextPage}
          loadOlder={() => history.fetchNextPage({ cancelRefetch: false })}
          trim={trim}
          orgId={orgId}
          lead={lead}
        />
      )}
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

/** 맨 아래에서 이만큼(px) 안이면 새 메시지를 따라 내려가고, 더 멀면 `맨 아래로` 버튼을 보인다. */
const followThreshold = 64;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 대화에 놓인 메시지의 스크롤 영역. 맨 위 근처(300px)에 오면 더 오래된 쪽을 하나 받는다. 한 번에 하나만 받고, 받은 뒤에는 사용자가 새로
 * 스크롤해야 다시 받는다. 키보드·내용이 화면보다 짧을 때·실패했을 때를 위해 맨 위에 `이전 메시지 보기` 버튼도 둔다.
 * 위에 붙일 때는 브라우저의 스크롤 고정을 끄고(`overflow-anchor: none`) 보이던 맨 위 메시지의 자리를 직접 되돌린다.
 * 맨 아래 근처(`followThreshold`)에 있을 때만 새 메시지를 따라 내려가고, 그보다 위에 있으면 `맨 아래로` 버튼을 보인다.
 * 따라가는 동안에는 대화 영역이나 내용의 크기가 바뀌어도(줄 세운 메시지 목록·입력창이 자람 등) 맨 아래에 남는다. 따라가기를
 * 멈추는 것은 사용자의 스크롤뿐이다.
 * 맨 아래를 따라가는 동안 불러 둔 메시지가 많아지면 오래된 쪽을 덜어 낸다(`trim`). 위를 읽는 동안에는 덜어 내지 않는다.
 * 위에 붙인 메시지는 읽어 주지 않고 새로 온 메시지만 조용히 알린다.
 */
function Transcript({
  messages,
  hasOlder,
  loadingOlder,
  loadOlder,
  trim,
  orgId,
  lead,
}: {
  messages: ConversationMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<{ isError: boolean }>;
  /** 불러 둔 오래된 쪽을 덜어 낸다. 맨 아래를 따라가며 `transcriptWindowMax`개를 넘었을 때만 부른다. */
  trim: () => void;
  orgId: string;
  lead: Agent;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const toast = useToast();
  /** 위에 붙이기 직전 보이던 맨 위 메시지와 그 위치. 붙인 뒤 같은 자리로 되돌린다. */
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  /** 받은 뒤 사용자가 새로 스크롤해야 다시 받는다. */
  const armed = useRef(true);
  /** 코드가 바꾼 스크롤은 사용자의 스크롤로 치지 않는다. */
  const programmatic = useRef(false);
  /** 맨 아래에 붙이는 중이다. 그사이 크기가 바뀌어 맨 아래가 아니게 읽혀도 따라가기를 멈추지 않는다(크기 변화가 다시 붙인다). */
  const pinning = useRef(false);
  /** 맨 아래 근처라 새 메시지를 따라간다. 그리기 전에 읽어야 하므로 ref로 두고, 버튼은 `away`가 맡는다. */
  const atBottom = useRef(true);
  /** `맨 아래로`를 눌러 내려가는 중이다. 도착하거나 사용자가 스크롤을 잡으면 끝난다. */
  const jumping = useRef(false);
  const [away, setAway] = useState(false);
  const [arrivals, setArrivals] = useState(0);
  // 처음 그릴 때는 맨 아래로 간다(빈 것에서 시작한 것으로 본다).
  const previous = useRef<ListShape>(listShape([]));

  const scrollTo = (top: number) => {
    const el = scroller.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = top;
    requestAnimationFrame(() => (programmatic.current = false));
  };
  /** 따라가는 중에 맨 아래로 바로 간다. */
  const pinToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    programmatic.current = pinning.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(
      () => (programmatic.current = pinning.current = false)
    );
  };
  /** 부드럽게(움직임 줄이기 설정이면 바로) 맨 아래로 간다. */
  const glideToBottom = () => {
    const el = scroller.current;
    el?.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };
  const jumpToBottom = () => {
    atBottom.current = true;
    jumping.current = true;
    setAway(false);
    glideToBottom();
  };

  const older = async () => {
    const el = scroller.current;
    if (!el || loadingOlder || !hasOlder) return;
    armed.current = false;
    const top = el.getBoundingClientRect().top;
    const visible = [
      ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((m) => m.getBoundingClientRect().bottom > top);
    anchor.current = visible
      ? {
          id: visible.dataset.messageId!,
          offset: visible.getBoundingClientRect().top - top,
        }
      : null;
    const result = await loadOlder();
    if (result.isError) {
      anchor.current = null;
      toast({ message: "이전 메시지를 불러오지 못했습니다" });
    }
  };
  const olderRef = useRef(older);
  useLayoutEffect(() => {
    olderRef.current = older;
  });

  // 메시지가 바뀐 직후 그리기 전에 대화 창의 판단(`afterListChange`)을 DOM에 적용한다. 새로 온 메시지 수는 화면 읽기 도구에 알린다.
  useLayoutEffect(() => {
    const el = scroller.current;
    const before = previous.current;
    previous.current = listShape(messages);
    if (!el) return;
    const { scroll, arrivals } = afterListChange(before, messages, {
      anchored: anchor.current !== null,
      following: atBottom.current,
      jumping: jumping.current,
    });
    if (scroll === "restore_anchor") {
      const target = el.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchor.current!.id)}"]`
      );
      if (target) {
        const offset =
          target.getBoundingClientRect().top - el.getBoundingClientRect().top;
        scrollTo(el.scrollTop + offset - anchor.current!.offset);
      }
      // 되돌린 자리에서 따라가기를 다시 정한다. 그러지 않으면 크기 변화가 맨 아래로 끌고 간다.
      atBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= followThreshold;
      anchor.current = null;
    } else if (scroll === "glide_bottom") glideToBottom();
    else if (scroll === "pin_bottom") pinToBottom();
    if (arrivals > 0) setArrivals((n) => n + arrivals);
  }, [messages]);

  // 따라가는 동안 대화 영역(입력창 위 목록·입력창이 자라거나 줄어듦)이나 내용(그린 뒤 자란 메시지)의 크기가 바뀌면 다시 맨 아래로
  // 간다. 영역이 줄어들 때는 스크롤 Event가 없어 이렇게 하지 않으면 맨 아래 메시지가 가려진 채 남는다.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (!atBottom.current) return;
      if (jumping.current) glideToBottom();
      else pinToBottom();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // 맨 아래를 따라가는 동안 불러 둔 메시지가 창보다 많아지면 오래된 쪽을 덜어 낸다(`shouldTrim`).
  const count = messages.length;
  useEffect(() => {
    if (
      shouldTrim(count, { following: !away && atBottom.current, loadingOlder })
    )
      trim();
  }, [count, away, loadingOlder, trim]);

  // 맨 위 sentinel이 300px 안에 들어오면 더 오래된 쪽을 받는다.
  useEffect(() => {
    const root = scroller.current;
    const target = sentinel.current;
    if (!root || !target || !hasOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && armed.current) void olderRef.current();
      },
      { root, rootMargin: "300px 0px 0px 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlder]);

  /** 사용자가 스크롤을 잡으면 `맨 아래로`의 내려가기를 멈춘다. */
  const takeOver = () => (jumping.current = false);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        data-testid="transcript-scroller"
        className="scrollbar-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1 [overflow-anchor:none]"
        onWheel={takeOver}
        onTouchStart={takeOver}
        onKeyDown={takeOver}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near =
            el.scrollHeight - el.scrollTop - el.clientHeight <= followThreshold;
          // 내려가는 동안의 중간 위치나 붙이는 사이 크기가 바뀐 위치로는 따라가기·버튼을 바꾸지 않는다.
          if ((jumping.current || pinning.current) && !near) return;
          jumping.current = false;
          atBottom.current = near;
          setAway(!near);
          if (!programmatic.current && !loadingOlder) armed.current = true;
        }}
      >
        <div ref={content}>
          <div ref={sentinel} />
          {hasOlder && (
            <div className="mb-3 flex justify-center">
              <button
                type="button"
                className="btn-ghost px-3 py-1 text-xs text-slate-500"
                disabled={loadingOlder}
                onClick={() => void older()}
              >
                {loadingOlder ? "불러오는 중…" : "이전 메시지 보기"}
              </button>
            </div>
          )}
          <MessageList
            messages={messages}
            orgId={orgId}
            lead={lead}
            busy={loadingOlder}
          />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {arrivals > 0 ? `새 메시지 ${arrivals}개` : ""}
      </p>
      {away && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Tip content="맨 아래로">
            <button
              type="button"
              aria-label="맨 아래로"
              onClick={jumpToBottom}
              className="animate-fade-in pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-700 shadow-pop ring-1 ring-slate-900/10 transition duration-150 ease-out select-none hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 active:scale-[0.94]"
            >
              <ArrowDownIcon />
            </button>
          </Tip>
        </div>
      )}
    </div>
  );
}

/** 아직 저장하지 않은 새 대화. 첫 메시지를 보내면 대화가 생기고 그 대화의 주소로 옮긴다. */
function DraftThread({ orgId, lead }: { orgId: string; lead: Agent }) {
  const start = useStartConversation(orgId);
  const navigate = useNavigate();
  return (
    <>
      <div className="min-h-0 flex-1" />
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

function MessageList({
  messages,
  orgId,
  lead,
  busy,
}: {
  messages: ConversationMessage[];
  orgId: string;
  lead: Agent;
  busy: boolean;
}) {
  return (
    <ol className="space-y-3" aria-label="대화" aria-busy={busy || undefined}>
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
  // 사용자 메시지는 Lead에게 전해진 시각이다(줄 세웠다가 전해졌으면 보낸 때가 아니라 받은 때).
  const time = mine ? (m.deliveredAt ?? m.createdAt) : m.createdAt;
  return (
    <li
      className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
      data-author={m.author}
      data-message-id={m.id}
    >
      <div className="mb-1 text-[11px] text-slate-400">
        {mine ? "나" : lead.name} ·{" "}
        {!mine && runId ? (
          <Link
            to={`/orgs/${orgId}/runs/${runId}`}
            title={runLabel(runId)}
            className="hover:text-brand-600 hover:underline"
          >
            {formatTime(time)}
          </Link>
        ) : (
          formatTime(time)
        )}
      </div>
      <Markdown
        text={m.body}
        data-testid="message-body"
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

/** 메시지가 지금 Lead를 깨우지 못하는 이유의 안내. 메시지는 남아 재개 뒤 전달된다. */
const heldLabel: Record<NonNullable<OwnerActionsDecision["heldBy"]>, string> = {
  organization_paused: "조직이 일시정지 중입니다 · 재개하면 전달",
  lead_paused: "Lead가 일시정지 중입니다 · 재개하면 전달",
};

/** Lead 상세의 최근 실행 시도에서 본 실행 상태. 취소를 요청받은 진행 중 실행 시도는 정리 중이다. */
function leadRunState(agent: AgentDetail | undefined): LeadRunState {
  const running = agent?.recentRuns.filter((r) => r.status === "running");
  if (running?.some((r) => r.cancelReason === null)) return "running";
  return running?.length ? "cancelling" : "idle";
}

/** 끝난 조직의 입력창 자리에 보이는 상태. */
const closedLabel: Partial<Record<LifecycleStage, string>> = {
  stopped: "중단된 조직",
  completed: "최종 완료된 조직",
};

type OwnerMessageSender = {
  mutateAsync: (input: {
    body: string;
    delivery: MessageDelivery;
  }) => Promise<unknown>;
  isPending: boolean;
  isError: boolean;
};

/**
 * 입력창. 어떤 버튼이 보이고 서버가 받는지는 서버와 같은 contracts 판정(`ownerActions`)을 따른다. 실행 중이 아니면 `보내기` 하나,
 * 실행 중이면 입력이 빌 때 `실행 중단`, 입력이 있으면 `중단하고 보내기`와 `줄 세우기`다. Enter는 언제나 `줄 세우기`(실행 중이
 * 아니면 그냥 보내기)다. 고른 방식은 메시지마다 새로 정하며 남지 않는다. 실행 상태는 Lead 상세의 진행 중 실행 시도로 보고 Event로
 * 바로 바뀐다. 끝난 조직(중단·최종 완료)은 입력창 대신 그 상태만 보인다. 서버가 받지 않는 보이는 버튼(줄이 가득 참)은 비활성이다.
 *
 * 바로 위에는 이 대화의 줄 세운 메시지가 오래된 것부터 있다. `고치기`는 그 항목을 그 자리에서 고치는 입력으로 바꾸며
 * (Enter 저장, Shift+Enter 줄바꿈, Esc 취소) 줄 속 위치와 전달 방식은 그대로다. 입력창이 비었을 때 ↑ 키는 가장 최근 메시지를
 * 거두고 그 글을 입력창에 되돌린다. `취소`는 거두기만 한다. 실행 시도가 먼저 받았으면 토스트로 알리고 대화로 옮겨 보인다.
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
  const queuedCount = Math.max(agent?.queuedMessageCount ?? 0, queued.length);
  // 조직을 아직 읽지 못했으면 끝나지 않은 조직으로 본다.
  const { heldBy, actions } = ownerActions({
    stage: stage ?? "researching",
    leadPaused: agent?.paused ?? false,
    run: leadRunState(agent),
    queuedCount,
  });
  const held = heldBy && heldLabel[heldBy];
  const closed = stage !== undefined && isClosedStage(stage);
  const full = actions.send.refusal === "queue_full";
  const typed = text.trim() !== "";
  const busy = send.isPending || stop.isPending;
  const submit = async (delivery: MessageDelivery) => {
    const body = text.trim();
    if (!body || busy || full) return;
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
  const failed: Record<QueuedMessageCommand, string> = {
    edit: "고치지 못했습니다. 다시 시도하세요.",
    withdraw: "취소하지 못했습니다. 다시 시도하세요.",
    send_now: "보내지 못했습니다. 다시 시도하세요.",
  };
  /** 줄 세운 메시지 명령. 실패하면 토스트로 알리고 `undefined`다(이미 전달됐으면 그 사실을). */
  const runQueued = async (
    message: ConversationMessage,
    kind: QueuedMessageCommand,
    body?: string
  ) => {
    if (queuedBusy) return undefined;
    try {
      return await command.mutateAsync({
        messageId: message.id,
        command: kind,
        body,
      });
    } catch (error) {
      toast({
        message:
          error instanceof ApiError && error.code === "message_delivered"
            ? "이미 전달된 메시지입니다"
            : failed[kind],
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
  const closedStatus = closed ? closedLabel[stage!] : undefined;
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
          count={queuedCount}
          canEdit={actions.edit.visible}
          canSendNow={actions.send_now.visible}
          busy={queuedBusy}
          onEdit={(m, body) => runQueued(m, "edit", body)}
          onCancel={(m) => void runQueued(m, "withdraw")}
          onSendNow={(m) => void runQueued(m, "send_now")}
        />
      )}
      {closedStatus ? (
        <p
          role="status"
          data-testid="composer-closed"
          className="card px-4 py-3 text-center text-sm text-slate-500"
        >
          {closedStatus}
        </p>
      ) : (
        <>
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
              {actions.send.visible ? (
                <IconButton
                  label="보내기"
                  type="submit"
                  tone="primary"
                  disabled={!typed || busy || !!actions.send.refusal}
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
                    disabled={busy || !!actions.interrupt_send.refusal}
                    onClick={() => void submit("interrupt")}
                  >
                    <BoltIcon className="h-[18px] w-[18px]" />
                  </IconButton>
                  <IconButton
                    label="줄 세우기"
                    type="submit"
                    tone="primary"
                    disabled={busy || !!actions.queue.refusal}
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
          {/* 상한은 Lead의 모든 대화를 합친 수라, 이 대화에 목록이 없어도 가득 찰 수 있다. */}
          {full && queued.length === 0 && (
            <p role="status" className="mt-2 text-xs text-rose-600">
              다른 대화에 줄 세운 메시지가 가득 찼습니다 · {queuedCount}/
              {maxQueuedMessages}
            </p>
          )}
        </>
      )}
    </form>
  );
}

/**
 * 입력창 바로 위의 줄 세운 메시지 목록. 오래된 것이 위, 가장 최근 것이 입력창 바로 위다. 머리에는 Lead에게 줄 세운 메시지 수와
 * 상한이 있다. 항목 버튼은 오른쪽 위에 작게, 마우스를 올리거나 키보드 초점이 항목 안에 있을 때 보이고 마우스가 없는 화면에서는 늘 보인다.
 * 고치는 항목은 그 자리의 입력이 된다.
 */
function QueuedMessages({
  messages,
  count,
  canEdit,
  canSendNow,
  busy,
  onEdit,
  onCancel,
  onSendNow,
}: {
  messages: ConversationMessage[];
  count: number;
  canEdit: boolean;
  canSendNow: boolean;
  busy: boolean;
  onEdit: (
    message: ConversationMessage,
    body: string
  ) => Promise<ConversationMessage | undefined>;
  onCancel: (message: ConversationMessage) => void;
  onSendNow: (message: ConversationMessage) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // 고치던 메시지가 전달되거나 거둬져 목록에서 빠지면 고치기도 끝난다.
  const editingId = messages.some((m) => m.id === editing) ? editing : null;
  return (
    <section aria-labelledby="queued-messages-title" className="mb-2">
      <h2
        id="queued-messages-title"
        className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-slate-500"
      >
        <QueueIcon className="h-3.5 w-3.5" />줄 세운 메시지{" "}
        <span
          className={`tabular-nums ${count >= maxQueuedMessages ? "text-rose-600" : "text-slate-400"}`}
        >
          {count}/{maxQueuedMessages}
        </span>
      </h2>
      <ol className="scrollbar-thin -mx-1 max-h-44 space-y-1 overflow-y-auto px-1 pb-0.5">
        {messages.map((m) =>
          m.id === editingId ? (
            <QueuedEditor
              key={m.id}
              message={m}
              busy={busy}
              onSave={async (body) => {
                if (body === m.body) return setEditing(null);
                // 저장하든 이미 전달됐든 고치기를 끝낸다. 그 밖의 실패는 고치던 글을 남긴다.
                const saved = await onEdit(m, body);
                if (saved) setEditing(null);
              }}
              onClose={() => setEditing(null)}
            />
          ) : (
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
                  {canEdit && (
                    <QueuedAction
                      label="고치기"
                      disabled={busy}
                      onClick={() => setEditing(m.id)}
                    >
                      <PencilIcon />
                    </QueuedAction>
                  )}
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
          )
        )}
      </ol>
    </section>
  );
}

/** 줄 세운 메시지를 그 자리에서 고치는 입력. Enter 저장, Shift+Enter 줄바꿈, Esc 취소. 비우면 저장할 수 없다. */
function QueuedEditor({
  message,
  busy,
  onSave,
  onClose,
}: {
  message: ConversationMessage;
  busy: boolean;
  onSave: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(message.body);
  const body = draft.trim();
  const save = () => {
    if (body && !busy) void onSave(body);
  };
  return (
    <li
      data-testid="queued-message"
      data-editing
      className="relative rounded-xl bg-white px-3 py-2 text-sm ring-2 ring-brand-400"
    >
      <label htmlFor={`queued-edit-${message.id}`} className="sr-only">
        줄 세운 메시지 고치기
      </label>
      <textarea
        id={`queued-edit-${message.id}`}
        value={draft}
        autoFocus
        rows={2}
        maxLength={messageBodyMaxLength}
        onFocus={(e) =>
          e.currentTarget.setSelectionRange(
            e.currentTarget.value.length,
            e.currentTarget.value.length
          )
        }
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
        className="block max-h-40 w-full resize-none bg-transparent pr-16 text-slate-800 outline-none"
      />
      <div className="absolute top-1 right-1 flex gap-0.5 rounded-lg bg-white p-0.5 shadow-sm ring-1 ring-slate-200">
        <QueuedAction label="저장" disabled={!body || busy} onClick={save}>
          <CheckIcon />
        </QueuedAction>
        <QueuedAction label="고치기 취소" disabled={false} onClick={onClose}>
          <CrossIcon />
        </QueuedAction>
      </div>
    </li>
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

function ArrowDownIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 4v11.5M5 10.5l5 5 5-5" />
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

/** 저장: 체크. */
function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
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
