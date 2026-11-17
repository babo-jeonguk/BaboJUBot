import type { QueryClient, QueryKey, Updater } from "@tanstack/react-query";

/**
 * 변경(mutation) 성공 응답을 캐시에 쓰는 공통 규칙. 화면이 변경 응답을 캐시에 직접 쓰는 곳은 모두 이것을 거친다.
 *
 * 쓰기 직전에 그 key에서만(`exact`) 진행 중인 조회를 취소하고 끝나기를 기다린 뒤 쓴다. 변경보다 먼저 출발한 조회가
 * 늦게 도착해도 취소된 조회의 결과는 버려지므로 변경 응답을 덮지 못한다(조회 함수가 signal을 쓰지 않아도 같다).
 * 변경 시작(`onMutate`)이 아니라 응답을 반영하는 이 시점에 취소해야 그 사이 출발한 조회도 막는다.
 * 취소는 시작 전 상태로 되돌리므로 처음 불러오는 중이던 key도 로딩으로 돌아가지 않고 변경 응답을 보인다.
 * 다른 key(같은 조직의 하위 key, 다른 조직의 같은 종류 key)의 조회는 건드리지 않는다.
 * 쓴 뒤 다시 불러오지 않는다. 무효화·재조회는 호출한 곳의 정책 그대로다.
 * 막는 것은 먼저 출발한 조회의 늦은 덮어쓰기뿐이다. 변경 응답끼리의 순서나 서버의 새 Event와의 경합은 다루지 않는다.
 */
export async function writeMutationResult<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  updater: Updater<T | undefined, T | undefined>
): Promise<void> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<T>(queryKey, updater);
}
