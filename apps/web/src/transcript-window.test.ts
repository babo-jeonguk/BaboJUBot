import type {
  ConversationMessage,
  ConversationPage,
} from "@babojubot/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import {
  appendArrivals,
  catchUpConversation,
  queryKeys,
  trimTranscript,
  type TranscriptData,
} from "./api.ts";

// 맨 아래를 따라가는 동안 불러 둔 대화 기록은 가장 최근 창만 남기고, 덜어 낸 쪽은 커서로 다시 받는다.

const message = (n: number): ConversationMessage => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  organizationId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
  author: "agent",
  body: `m${n}`,
  delivery: null,
  sentByRunId: "00000000-0000-4000-8000-000000000004",
  deliveredToRunId: null,
  deliveredAt: null,
  createdAt: "2026-10-28T00:00:00.000Z",
});
/** `from`..`to` 메시지를 담은 쪽. 커서는 맨 앞·맨 뒤 메시지 번호다. */
const page = (
  from: number,
  to: number,
  hasMore: boolean
): ConversationPage => ({
  messages: Array.from({ length: to - from + 1 }, (_, i) => message(from + i)),
  hasMore,
  before: hasMore ? `b${from}` : null,
  after: `a${to}`,
});
const bodies = (data: TranscriptData) =>
  data.pages
    .slice()
    .reverse()
    .flatMap((p) => p.messages.map((m) => m.body));

test("appends each arrived page as its own newest page, keeping its cursor to older messages", () => {
  const loaded: TranscriptData = {
    pages: [page(51, 100, true)],
    pageParams: [null],
  };
  // `after` 응답의 `hasMore`는 더 새 쪽이 있는가다. 붙인 쪽에서는 더 오래된 쪽이 있는가로 바꾼다.
  const next = appendArrivals(loaded, [
    { ...page(101, 150, true), hasMore: true },
    { ...page(151, 151, true), hasMore: false },
  ]);
  expect(
    next.pages.map((p) => [p.messages.length, p.hasMore, p.before])
  ).toEqual([
    [1, true, "b151"],
    [50, true, "b101"],
    [50, true, "b51"],
  ]);
  expect(next.pageParams).toEqual([null, null, null]);
  expect(bodies(next).at(-1)).toBe("m151");
  // 빈 응답은 그대로 둔다.
  expect(appendArrivals(next, [{ ...page(1, 1, false), messages: [] }])).toBe(
    next
  );
});

test("drops an already loaded message from the older page, not from the arrived one", () => {
  const loaded: TranscriptData = {
    pages: [page(1, 10, false)],
    pageParams: [null],
  };
  const next = appendArrivals(loaded, [page(10, 12, true)]);
  expect(bodies(next)).toEqual(
    Array.from({ length: 12 }, (_, i) => `m${i + 1}`)
  );
  expect(next.pages[0]!.before).toBe("b10");
});

test("keeps the transcript as it is up to the window and trims the oldest whole pages beyond it", () => {
  const small: TranscriptData = {
    pages: [page(51, 100, true), page(1, 50, false)],
    pageParams: [null, "b51"],
  };
  expect(trimTranscript(small)).toBe(small);

  // 처음 받은 50개 뒤에 하나씩 온 메시지 60개: 100개를 넘으면 가장 최근 50개 이상만 남긴다.
  let data: TranscriptData = { pages: [page(1, 50, true)], pageParams: [null] };
  for (let n = 51; n <= 110; n++)
    data = appendArrivals(data, [{ ...page(n, n, true), hasMore: false }]);
  const trimmed = trimTranscript(data);
  expect(bodies(trimmed)).toEqual(
    Array.from({ length: 50 }, (_, i) => `m${i + 61}`)
  );
  // 남은 마지막 쪽의 커서로 덜어 낸 쪽을 다시 받는다.
  const last = trimmed.pages.at(-1)!;
  expect([last.hasMore, last.before]).toEqual([true, "b61"]);
  expect(trimmed.pageParams).toHaveLength(trimmed.pages.length);
});

test("stops trimming at a page without a cursor to older messages", () => {
  const data: TranscriptData = {
    pages: [
      page(101, 160, true),
      { ...page(51, 100, true), before: null },
      page(1, 50, false),
    ],
    pageParams: [null, null, null],
  };
  // 커서 없는 쪽은 마지막 쪽이 될 수 없으므로 그 뒤 쪽을 덜어 내지 않는다.
  expect(trimTranscript(data).pages).toHaveLength(3);
  expect(
    trimTranscript({
      pages: [{ ...page(51, 160, true), before: null }, page(1, 50, false)],
      pageParams: [null, null],
    }).pages
  ).toHaveLength(2);
});

/**
 * `?after=` 커서로 새 메시지를 돌려주는 가짜 서버. 응답 내용은 요청이 시작될 때의 가장 새 메시지(`newest`)로 고정된다.
 * 처음 `gated`개 요청의 응답은 `respond(i)`로 원하는 순서에 돌려주고, 그 뒤 요청은 바로 돌려준다.
 */
function fakeCatchUpServer(newest: number, gated = 2) {
  const pending: { resolve: () => void }[] = [];
  const server = {
    newest,
    requests: [] as string[],
    fetch: vi.fn((url: string) => {
      const after = new URL(url, "http://x").searchParams.get("after");
      server.requests.push(after ?? "first");
      const from = Number(after?.slice(1) ?? 0) + 1;
      const to = server.newest;
      const body: ConversationPage =
        from > to
          ? { messages: [], hasMore: false, before: null, after }
          : { ...page(from, to, true), hasMore: false };
      if (server.requests.length > gated)
        return Promise.resolve(Response.json(body));
      return new Promise<Response>((resolve) =>
        pending.push({ resolve: () => resolve(Response.json(body)) })
      );
    }),
    async respond(i: number) {
      await vi.waitFor(() => expect(pending[i]).toBeDefined());
      pending[i]!.resolve();
    },
  };
  vi.stubGlobal("fetch", server.fetch);
  return server;
}

afterEach(() => vi.unstubAllGlobals());

test("a catch-up whose response comes back after a later one's keeps the delivery order and the newest cursor", async () => {
  const client = new QueryClient();
  const key = queryKeys.conversation("org");
  client.setQueryData<TranscriptData>(key, {
    pages: [page(51, 100, true)],
    pageParams: [null],
  });
  const server = fakeCatchUpServer(102);
  const first = catchUpConversation(client, "org");
  await vi.waitFor(() => expect(server.requests).toHaveLength(1));
  server.newest = 103;
  const second = catchUpConversation(client, "org");
  await vi.waitFor(() => expect(server.requests).toHaveLength(2));

  // 늦게 시작한 쪽(101~103)이 먼저 오고, 먼저 시작한 쪽(101~102)이 나중에 온다.
  await server.respond(1);
  await second;
  // 먼저 시작한 쪽은 기준 커서가 지난 응답이라 버리고, 지금 가장 새 메시지 뒤를 다시 받는다.
  await server.respond(0);
  await first;

  const data = client.getQueryData<TranscriptData>(key)!;
  expect(bodies(data).slice(-4)).toEqual(["m100", "m101", "m102", "m103"]);
  expect(data.pages[0]!.after).toBe("a103");
  expect(server.requests).toEqual(["a100", "a100", "a103"]);
});

test("an empty conversation's first page that comes back after another catch-up filled it still brings its newer message", async () => {
  const client = new QueryClient();
  const key = queryKeys.conversation("org");
  const empty: ConversationPage = {
    messages: [],
    hasMore: false,
    before: null,
    after: null,
  };
  client.setQueryData<TranscriptData>(key, {
    pages: [empty],
    pageParams: [null],
  });
  const server = fakeCatchUpServer(1);
  const first = catchUpConversation(client, "org");
  await vi.waitFor(() => expect(server.requests).toHaveLength(1));
  server.newest = 2;
  const second = catchUpConversation(client, "org");
  await vi.waitFor(() => expect(server.requests).toHaveLength(2));

  // 먼저 시작한 쪽(m1)이 먼저 채운다. 늦게 시작한 쪽(m1·m2)은 기준이 지났지만 버리면 m2를 잃으므로 m1 뒤를 다시 받는다.
  await server.respond(0);
  await first;
  await server.respond(1);
  await second;

  const data = client.getQueryData<TranscriptData>(key)!;
  expect(bodies(data)).toEqual(["m1", "m2"]);
  expect(data.pages[0]!.after).toBe("a2");
  expect(server.requests).toEqual(["first", "first", "a1"]);
});
