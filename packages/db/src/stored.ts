import type { Event } from "@babojubot/contracts";
import type { RunCancellation } from "@babojubot/core";

/**
 * commit 뒤 할 일. 저장한 쪽은 무엇을 할지만 담고, 순서(Event·설정 변경 알리기 → 진행 중 실행 시도 취소 → 재개한 조직의 대기 깨우기
 * 다시 처리 → 깨운 에이전트·자리가 는 연결을 기다리는 에이전트 촉진)는 적용하는 쪽(server `applyAfterCommit`)이 정한다. 알림이 실패해도 저장은 이미 끝났고,
 * 깨우기는 DB에 있어 서버 시작 때 다시 처리된다.
 */
export type AfterCommit = {
  /** 같은 transaction에 남긴 Event. 남긴 순서다. */
  events: Event[];
  /** 같은 transaction에서 취소를 요청한 진행 중 실행 시도. */
  cancellation?: RunCancellation | null;
  /** 이 저장이 재개한 조직. 그 조직의 대기 깨우기를 모두 다시 처리한다. */
  resumedOrganizationId?: string;
  /** 이 저장이 깨운 에이전트. */
  woken?: string[];
  /** 전역 설정(프로바이더 기본값·동시 실행 상한)이 바뀌었다. 조직 Event가 아니라 다른 화면에 다시 불러오라는 신호만 보낸다. */
  settingsChanged?: boolean;
  /** 자리가 늘어 기다리던 에이전트를 다시 촉진할 프로바이더 연결. */
  providersFreed?: string[];
};

/**
 * 사용자가 대시보드나 채널에서 한 일 하나의 저장 결과: 돌려줄 값과 commit 뒤 할 일, 또는 거부 이유.
 * 거부면 아무것도 남지 않았다. 바뀐 것이 없으면 `after`가 빈 성공이다.
 */
export type Stored<T, R extends string> =
  { kind: "ok"; value: T; after: AfterCommit } | { kind: "refused"; reason: R };

export const stored = <T>(
  value: T,
  after: AfterCommit = { events: [] }
): { kind: "ok"; value: T; after: AfterCommit } => ({
  kind: "ok",
  value,
  after,
});

export const refused = <R extends string>(
  reason: R
): { kind: "refused"; reason: R } => ({ kind: "refused", reason });
