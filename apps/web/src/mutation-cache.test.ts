import {
  QueryClient,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeMutationResult } from "./mutation-cache.ts";
import { queryKeys } from "./api.ts";

type Summary = { id: string; unread: boolean };

const orgA = "00000000-0000-4000-8000-00000000000a";
const orgB = "00000000-0000-4000-8000-00000000000b";

/** 시간이 아니라 시험이 놓아줄 때 끝나는 조회 응답. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 놓아준 응답의 뒤처리(라이브러리의 then 사슬)가 모두 끝나도록 대기열을 한 번 비운다. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

let client: QueryClient;
const unsubscribes: (() => void)[] = [];

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});

afterEach(() => {
  for (const off of unsubscribes.splice(0)) off();
  client.clear();
});

/**
 * 화면처럼 그 key를 보고 있는 observer를 붙이고, 놓아줄 때까지 끝나지 않는 조회를 출발시킨다.
 * 출발했는지(조회 함수가 불렸는지)를 기다린 뒤 돌려준다.
 */
async function startHeldFetch<T>(queryKey: QueryKey) {
  const response = deferred<T>();
  const reached = deferred<void>();
  let calls = 0;
  const observer = new QueryObserver<T>(client, {
    queryKey,
    queryFn: () => {
      calls += 1;
      reached.resolve();
      return response.promise;
    },
  });
  unsubscribes.push(observer.subscribe(() => {}));
  // 이미 데이터가 있어 observer가 스스로 조회하지 않는 경우에도 조회를 출발시킨다.
  if (client.getQueryState(queryKey)?.fetchStatus !== "fetching")
    void observer.refetch();
  await reached.promise;
  expect(client.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
  return { observer, release: response.resolve, calls: () => calls };
}

test("a fetch that started before the write and arrives after it does not overwrite the mutation response", async () => {
  const key = queryKeys.conversations(orgA);
  client.setQueryData<Summary[]>(key, [{ id: "c1", unread: true }]);
  const fetch = await startHeldFetch<Summary[]>(key);

  await writeMutationResult<Summary[]>(client, key, [
    { id: "c1", unread: false },
  ]);
  expect(client.getQueryData(key)).toEqual([{ id: "c1", unread: false }]);

  // 먼저 출발한 조회의 서버 응답(읽음 전)이 늦게 도착한다.
  fetch.release([{ id: "c1", unread: true }]);
  await settle();

  expect(client.getQueryData(key)).toEqual([{ id: "c1", unread: false }]);
  expect(fetch.observer.getCurrentResult()).toMatchObject({
    status: "success",
    fetchStatus: "idle",
    data: [{ id: "c1", unread: false }],
  });
  // 쓴 뒤 다시 조회하지 않는다(기존 무효화·재조회 정책 그대로).
  expect(fetch.calls()).toBe(1);
});

test("with no fetch in flight it writes the value, or the updater's result from the current value", async () => {
  const key = queryKeys.conversations(orgA);
  client.setQueryData<Summary[]>(key, [{ id: "c1", unread: true }]);

  await writeMutationResult<Summary[]>(client, key, (list) =>
    list?.map((c) => ({ ...c, unread: false }))
  );
  expect(client.getQueryData(key)).toEqual([{ id: "c1", unread: false }]);

  await writeMutationResult<Summary[]>(client, key, [
    { id: "c2", unread: true },
  ]);
  expect(client.getQueryData(key)).toEqual([{ id: "c2", unread: true }]);
});

test("while the key is loading for the first time the mutation response shows and does not fall back to loading", async () => {
  const key = queryKeys.conversations(orgA);
  const fetch = await startHeldFetch<Summary[]>(key);
  expect(fetch.observer.getCurrentResult().status).toBe("pending");

  await writeMutationResult<Summary[]>(client, key, [
    { id: "c1", unread: false },
  ]);
  expect(fetch.observer.getCurrentResult()).toMatchObject({
    status: "success",
    data: [{ id: "c1", unread: false }],
  });

  fetch.release([{ id: "c1", unread: true }]);
  await settle();
  expect(fetch.observer.getCurrentResult()).toMatchObject({
    status: "success",
    fetchStatus: "idle",
    data: [{ id: "c1", unread: false }],
  });
  expect(fetch.calls()).toBe(1);
});

test("fetches of the same kind of key in another organization, and of other keys, are not cancelled and store their results", async () => {
  const key = queryKeys.organization(orgA);
  client.setQueryData(key, { id: orgA, name: "A 이전" });
  // 같은 조직의 하위 key(대화 목록)와 다른 조직의 같은 종류 key.
  const child = await startHeldFetch<Summary[]>(queryKeys.conversations(orgA));
  const other = await startHeldFetch<{ id: string; name: string }>(
    queryKeys.organization(orgB)
  );

  await writeMutationResult(client, key, { id: orgA, name: "A 변경" });

  child.release([{ id: "c1", unread: true }]);
  other.release({ id: orgB, name: "B 조회" });
  await settle();

  expect(client.getQueryData(key)).toEqual({ id: orgA, name: "A 변경" });
  expect(client.getQueryData(queryKeys.conversations(orgA))).toEqual([
    { id: "c1", unread: true },
  ]);
  expect(client.getQueryData(queryKeys.organization(orgB))).toEqual({
    id: orgB,
    name: "B 조회",
  });
});
