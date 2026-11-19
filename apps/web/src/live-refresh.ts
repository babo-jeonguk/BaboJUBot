import { settled } from "@babojubot/contracts";
import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

/**
 * Event가 몰려도 조회마다 요청을 하나만 진행하면서 마지막 Event 뒤의 서버 상태를 반드시 다시 불러온다.
 *
 * 조회마다 `dirty`(아직 회수하지 않은 변경)와 진행 여부를 따로 둔다. 진행 중에 온 신호는 dirty만 남기고,
 * 진행 중인 조회가 끝나면(성공·오류·취소) dirty일 때 한 번 더 불러온다. 응답은 끝나는 대로 캐시와 화면에 반영된다.
 * 이미 진행 중인 조회(첫 로드·화면 이동·mutation 등이 시작한 것)는 신호 이전 상태일 수 있으므로,
 * 거기에 합류해도 dirty를 지우지 않고 끝난 뒤 새로 불러온다. 오프라인으로 멈춘 조회도 끝날 때까지 기다린다.
 * 보고 있는 화면이 없는 조회는 오래됨으로만 표시해 다음에 볼 때 다시 불러오게 한다.
 * 조회의 `meta.liveRefresh`가 함수면 다시 불러오는 대신 그것을 부른다(쪽으로 나눈 대화는 새 메시지만 이어 받는다).
 * 그사이 그 조회가 스스로 불러오기 시작했으면(더 오래된 쪽 등) 그 결과가 덮어쓸 수 있으므로 끝난 뒤 한 번 더 부른다.
 *
 * `onQueued`는 진행 중인 조회에 신호가 와서 끝난 뒤 다시 불러오기로 표시된 조회(`queryHash`) 목록이 바뀔 때만 불린다.
 * 그 순간은 밖에서 보이지 않으므로 시험이 순서를 확인하는 관찰점으로 쓴다(`live-events.ts`가 문서 루트의 data 속성으로 낸다).
 */
export function createLiveRefresh(
  queryClient: QueryClient,
  { onQueued }: { onQueued?: (queryHashes: string[]) => void } = {}
) {
  const cache = queryClient.getQueryCache();
  const dirty = new Set<Query>();
  /** 진행 중에 신호를 받아 끝난 뒤 다시 불러올 조회. */
  const queued = new Set<Query>();
  const publish = () => onQueued?.([...queued].map((query) => query.queryHash));
  const unqueue = (query: Query) => {
    if (queued.delete(query)) publish();
  };
  const running = new Set<Query>();
  const waiting = new Set<() => void>();
  let disposed = false;

  /** 조회가 진행 중이 아니게 될 때(또는 캐시에서 빠지거나 정리될 때)까지 기다린다. */
  const untilIdle = (query: Query) =>
    new Promise<void>((resolve) => {
      const done = () => {
        waiting.delete(done);
        unsubscribe();
        resolve();
      };
      const unsubscribe = cache.subscribe((event) => {
        if (event.query !== query) return;
        if (event.type === "removed" || query.state.fetchStatus === "idle")
          done();
      });
      waiting.add(done);
      if (query.state.fetchStatus === "idle") done();
    });

  const drain = async (query: Query) => {
    running.add(query);
    try {
      while (
        dirty.has(query) &&
        !disposed &&
        cache.get(query.queryHash) === query
      ) {
        if (query.state.fetchStatus !== "idle") {
          await untilIdle(query);
          continue;
        }
        dirty.delete(query);
        unqueue(query);
        const custom = query.meta?.liveRefresh;
        if (typeof custom === "function") {
          // 다음 Event나 재연결이 다시 맞춘다.
          await settled(
            Promise.resolve().then(custom as () => Promise<unknown>)
          );
          if (query.state.fetchStatus !== "idle") dirty.add(query);
          continue;
        }
        // 진행 중인 조회가 없음을 확인했으므로 취소 없이 새 요청이 시작된다. 보는 화면이 없으면 표시만 한다.
        void queryClient.invalidateQueries(
          { predicate: (q) => q === query },
          { cancelRefetch: false }
        );
        await untilIdle(query);
      }
    } finally {
      running.delete(query);
      dirty.delete(query);
      unqueue(query);
    }
  };

  return {
    /** 필터에 맞는 조회를 다시 불러오게 한다. 필터가 없으면 전체(구독 성립·재연결 복구). */
    refresh(filters?: QueryFilters) {
      if (disposed) return;
      let changed = false;
      for (const query of cache.findAll(filters)) {
        dirty.add(query);
        if (query.state.fetchStatus !== "idle" && !queued.has(query)) {
          queued.add(query);
          changed = true;
        }
        if (!running.has(query)) void drain(query);
      }
      if (changed) publish();
    },
    dispose() {
      disposed = true;
      dirty.clear();
      if (queued.size > 0) {
        queued.clear();
        publish();
      }
      waiting.forEach((done) => done());
    },
  };
}
