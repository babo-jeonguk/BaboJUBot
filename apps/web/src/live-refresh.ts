import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

/**
 * Event가 몰려도 조회마다 요청을 하나만 진행하면서 마지막 Event 뒤의 서버 상태를 반드시 다시 불러온다.
 *
 * 조회마다 `dirty`(아직 회수하지 않은 변경)와 진행 여부를 따로 둔다. 진행 중에 온 신호는 dirty만 남기고,
 * 진행 중인 조회가 끝나면(성공·오류·취소) dirty일 때 한 번 더 불러온다. 응답은 끝나는 대로 캐시와 화면에 반영된다.
 * 이미 진행 중인 조회(첫 로드·화면 이동·mutation 등이 시작한 것)는 신호 이전 상태일 수 있으므로,
 * 거기에 합류해도 dirty를 지우지 않고 끝난 뒤 새로 불러온다. 오프라인으로 멈춘 조회도 끝날 때까지 기다린다.
 * 보고 있는 화면이 없는 조회는 오래됨으로만 표시해 다음에 볼 때 다시 불러오게 한다.
 */
export function createLiveRefresh(queryClient: QueryClient) {
  const cache = queryClient.getQueryCache();
  const dirty = new Set<Query>();
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
    }
  };

  return {
    /** 필터에 맞는 조회를 다시 불러오게 한다. 필터가 없으면 전체(구독 성립·재연결 복구). */
    refresh(filters?: QueryFilters) {
      if (disposed) return;
      for (const query of cache.findAll(filters)) {
        dirty.add(query);
        if (!running.has(query)) void drain(query);
      }
    },
    dispose() {
      disposed = true;
      dirty.clear();
      waiting.forEach((done) => done());
    },
  };
}
