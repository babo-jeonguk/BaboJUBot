import {
  conversationPageSchema,
  conversationPageSize,
  type ConversationPage,
} from "@babojubot/contracts";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { messagesPath, notFoundIsFinal, queryKeys, request } from "./api.ts";

// 대화 창: 대화에 놓인 메시지 중 화면이 불러 둔 부분(창)의 모양, 새 메시지 이어 받기, 오래된 쪽 덜어 내기와
// 목록이 바뀐 뒤 스크롤을 어떻게 할지의 판단. 화면(chat.tsx `Transcript`)은 그 판단을 DOM에 적용하기만 한다.

const pagePath = (
  orgId: string,
  conversationId: string | undefined,
  cursor?: { before?: string; after?: string }
) => {
  const query = new URLSearchParams(cursor);
  return `${messagesPath(orgId, conversationId)}${query.size ? `?${query}` : ""}`;
};

/**
 * 대화 창: 대화에 놓인 메시지 중 불러 둔 쪽들. 첫 쪽이 가장 최근 것이고 뒤로 갈수록 오래된 쪽이다. 쪽 안은 오래된 것부터다.
 * 쪽마다 `hasMore`는 그보다 오래된 메시지가 있는가, `before`는 그것을 받을 커서다(마지막 쪽의 것으로 더 오래된 쪽을 받는다).
 */
export type TranscriptData = InfiniteData<ConversationPage, string | null>;

/** 맨 아래를 따라가는 동안 불러 둔 메시지가 이보다 많으면 오래된 쪽을 덜어 낸다(`trimTranscript`). */
export const transcriptWindowMax = 100;

/**
 * 대화에 놓인 메시지(받은 순서). 대화 ID가 없으면 기본 대화다. 처음에는 가장 최근 쪽만 받고 `fetchNextPage`가 더 오래된 쪽을 받는다.
 * 새 메시지는 Event가 올 때 `catchUpConversation`이 가장 새 메시지 뒤의 것만 받아 붙이므로(불러온 쪽 전체를 다시 받지 않는다)
 * 창 focus·재연결의 다시 불러오기를 끄고 오래됨으로 보지 않는다. 줄 세운 메시지는 `useQueuedMessages`가 따로 받는다.
 */
export function useConversation(orgId: string, conversationId?: string) {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: queryKeys.conversation(orgId, conversationId),
    queryFn: ({ pageParam }) =>
      request(
        conversationPageSchema,
        pagePath(orgId, conversationId, pageParam ? { before: pageParam } : {})
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.before : undefined),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: notFoundIsFinal,
    meta: {
      liveRefresh: () =>
        catchUpConversation(queryClient, orgId, conversationId),
    },
  });
}

/**
 * 대화 창에 그 뒤에 온 메시지만 이어 붙인다(`?after=` 커서, 남으면 이어서). 아직 첫 쪽을 받지 않았으면 아무것도 하지 않고,
 * 비어 있던 대화면 가장 최근 쪽을 새로 받는다. 서버의 새 메시지는 늘 받은 순서의 맨 뒤에 놓이므로 붙이기만 하면 된다.
 * 응답을 기다리는 사이 다른 이어 받기가 가장 새 쪽을 바꿨으면 그 응답은 붙일 자리가 지났으므로 버리고, 지금 가장 새 메시지
 * 뒤부터 다시 받는다(늦게 온 응답이 순서를 뒤집거나 그보다 새 메시지를 버리지 않도록).
 */
export async function catchUpConversation(
  queryClient: QueryClient,
  orgId: string,
  conversationId?: string
) {
  const key = queryKeys.conversation(orgId, conversationId);
  const newestCursor = (data: TranscriptData) => data.pages[0]?.after ?? null;
  for (;;) {
    const data = queryClient.getQueryData<TranscriptData>(key);
    if (!data) return;
    const base = newestCursor(data);
    const update = await (base === null
      ? fetchFirstPage(orgId, conversationId)
      : fetchArrivals(orgId, conversationId, base));
    let applied = false;
    queryClient.setQueryData<TranscriptData>(key, (old) => {
      if (!old || newestCursor(old) !== base) return old;
      applied = true;
      return update(old);
    });
    if (applied) return;
  }
}

/** 비어 있던 대화의 가장 최근 쪽을 받아 대화 창을 그것으로 바꾸는 갱신. */
async function fetchFirstPage(orgId: string, conversationId?: string) {
  const fresh = await request(
    conversationPageSchema,
    pagePath(orgId, conversationId)
  );
  return (): TranscriptData => ({ pages: [fresh], pageParams: [null] });
}

/** `after` 커서 뒤에 온 쪽을 끝까지 받아 대화 창에 붙이는 갱신(`appendArrivals`). */
async function fetchArrivals(
  orgId: string,
  conversationId: string | undefined,
  after: string
) {
  let cursor = after;
  const arrived: ConversationPage[] = [];
  for (;;) {
    const page: ConversationPage = await request(
      conversationPageSchema,
      pagePath(orgId, conversationId, { after: cursor })
    );
    arrived.push(page);
    cursor = page.after ?? cursor;
    if (!page.hasMore) break;
  }
  return (old: TranscriptData) => appendArrivals(old, arrived);
}

/**
 * 새로 받은 쪽(`?after=` 응답, 오래된 것부터)을 대화 창 앞(가장 새 쪽)에 붙인다. 받은 쪽마다 따로 두어 그 쪽의 `before` 커서를
 * 남기므로 나중에 오래된 쪽을 덜어 내도(`trimTranscript`) 다시 받을 수 있다. 이미 불러 둔 같은 메시지는 예전 쪽에서 뺀다.
 */
export function appendArrivals(
  data: TranscriptData,
  arrived: readonly ConversationPage[]
): TranscriptData {
  const fresh = arrived.filter((p) => p.messages.length);
  if (!fresh.length) return data;
  const ids = new Set(fresh.flatMap((p) => p.messages.map((m) => m.id)));
  const pages = fresh
    .map((p) => ({ ...p, hasMore: p.before !== null }))
    .reverse();
  return {
    pages: [
      ...pages,
      ...data.pages.map((p) =>
        p.messages.some((m) => ids.has(m.id))
          ? { ...p, messages: p.messages.filter((m) => !ids.has(m.id)) }
          : p
      ),
    ],
    pageParams: [...pages.map(() => null), ...data.pageParams],
  };
}

/**
 * 맨 아래를 따라가는 동안 불러 둔 메시지가 `max`개를 넘으면 가장 최근 `keep`개 이상이 남을 때까지 오래된 쪽을 통째로 덜어 낸다.
 * 남은 마지막 쪽의 `before` 커서로 위로 올리면 덜어 낸 쪽을 다시 받는다. 커서가 없는 쪽에서는 멈춘다.
 */
export function trimTranscript(
  data: TranscriptData,
  { max = transcriptWindowMax, keep = conversationPageSize } = {}
): TranscriptData {
  let total = data.pages.reduce((n, p) => n + p.messages.length, 0);
  if (total <= max) return data;
  let end = data.pages.length;
  while (end > 1) {
    const dropped = data.pages[end - 1]!.messages.length;
    if (total - dropped < keep || data.pages[end - 2]!.before === null) break;
    total -= dropped;
    end--;
  }
  if (end === data.pages.length) return data;
  const pages = data.pages.slice(0, end);
  pages[end - 1] = { ...pages[end - 1]!, hasMore: true };
  return { pages, pageParams: data.pageParams.slice(0, end) };
}

/** 대화 창의 오래된 쪽을 덜어 낸다(`trimTranscript`). 맨 아래를 따라가는 화면만 부른다. */
export function trimConversation(
  queryClient: QueryClient,
  orgId: string,
  conversationId?: string
) {
  queryClient.setQueryData<TranscriptData>(
    queryKeys.conversation(orgId, conversationId),
    (old) => old && trimTranscript(old)
  );
}

/** 목록이 바뀌기 전 화면이 기억한 목록의 모양. 처음 그리기 전은 빈 목록이다. */
export type ListShape = {
  first: string | undefined;
  last: string | undefined;
  count: number;
};

export const listShape = (messages: readonly { id: string }[]): ListShape => ({
  first: messages[0]?.id,
  last: messages.at(-1)?.id,
  count: messages.length,
});

/** 목록이 바뀔 때 화면이 처한 상황. */
export type ScrollSituation = {
  /** 위에 오래된 쪽을 붙이기 직전 보던 맨 위 메시지를 기억해 두었다. */
  anchored: boolean;
  /** 맨 아래 근처라 새 메시지를 따라간다. */
  following: boolean;
  /** `맨 아래로`를 눌러 내려가는 중이다. */
  jumping: boolean;
};

/**
 * 목록이 바뀐 뒤 할 스크롤.
 * - `restore_anchor`: 위에 붙인 뒤 보던 메시지를 같은 자리로 되돌린다.
 * - `pin_bottom`: 따라가는 중이라 맨 아래에 바로 붙는다(처음 그릴 때도).
 * - `glide_bottom`: `맨 아래로`를 누른 뒤라 맨 아래로 부드럽게 내려간다.
 * - `stay`: 위를 읽는 중이라 제자리에 두고 `맨 아래로` 버튼을 띄운 채 둔다.
 */
export type ScrollAction =
  "restore_anchor" | "pin_bottom" | "glide_bottom" | "stay";

/**
 * 이전 목록·새 목록·화면 상황에서 할 스크롤과 새로 온 메시지 수(화면 읽기 도구에 알린다). 맨 위가 바뀌었고 보던 메시지를 기억해
 * 두었으면 위에 붙인 것이다. 그 밖에 따라가는 중이면 맨 아래로 간다(새 메시지가 붙었거나 오래된 쪽을 덜어 냈거나).
 * 새 메시지 수는 이전 마지막 메시지 뒤에 붙은 수이며, 이전 마지막 메시지가 목록에 없으면 하나로 센다.
 */
export function afterListChange(
  before: ListShape,
  after: readonly { id: string }[],
  situation: ScrollSituation
): { scroll: ScrollAction; arrivals: number } {
  if (before.count === 0) return { scroll: "pin_bottom", arrivals: 0 };
  const now = listShape(after);
  const scroll: ScrollAction =
    now.first !== before.first && situation.anchored
      ? "restore_anchor"
      : !situation.following
        ? "stay"
        : situation.jumping
          ? "glide_bottom"
          : "pin_bottom";
  if (now.last === before.last) return { scroll, arrivals: 0 };
  const index = after.findIndex((m) => m.id === before.last);
  return {
    scroll,
    arrivals: Math.max(0, index === -1 ? 1 : after.length - 1 - index),
  };
}

/** 불러 둔 메시지가 창(`transcriptWindowMax`)보다 많고, 맨 아래를 따라가며 더 오래된 쪽을 받는 중이 아니면 덜어 낸다. */
export const shouldTrim = (
  count: number,
  { following, loadingOlder }: { following: boolean; loadingOlder: boolean }
) => count > transcriptWindowMax && following && !loadingOlder;
