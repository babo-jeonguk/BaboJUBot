import type { AfterCommit, Stored } from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

export type AfterCommitDeps = {
  hub: Pick<EventHub, "publish" | "publishSettingsChanged">;
  dispatcher: Pick<
    RunDispatcher,
    "cancel" | "kickOrganization" | "kick" | "kickProvider"
  >;
};

/**
 * 저장이 commit된 뒤 할 일을 정해진 순서로 한다: Event·전역 설정 변경 알리기 → 진행 중 실행 시도 취소 → 재개한 조직의 대기 깨우기 다시 처리
 * (끝날 때까지 기다림) → 깨운 에이전트의 실행 시도 촉진 → 자리가 늘어난 프로바이더 연결을 기다리는 에이전트 촉진(첫 조회를 기다림).
 * 사용자가 한 일, 조직 도구 쓰기, heartbeat 확인이 모두 이것을 쓴다.
 * 알림·촉진의 실패는 각자 남기고 던지지 않으므로 이미 저장된 결과를 바꾸지 않는다.
 */
export async function applyAfterCommit(
  { hub, dispatcher }: AfterCommitDeps,
  {
    events,
    cancellation,
    resumedOrganizationId,
    woken,
    settingsChanged,
    providersFreed,
  }: AfterCommit
): Promise<void> {
  if (events.length) hub.publish(...events);
  if (settingsChanged) hub.publishSettingsChanged();
  if (cancellation) dispatcher.cancel(cancellation);
  if (resumedOrganizationId)
    await dispatcher.kickOrganization(resumedOrganizationId);
  for (const agentId of woken ?? []) dispatcher.kick(agentId);
  for (const provider of providersFreed ?? [])
    await dispatcher.kickProvider(provider);
}

export type Outcome<T, R extends string> =
  { kind: "ok"; value: T } | { kind: "refused"; reason: R };

/** 저장 결과를 받아 commit 뒤 할 일을 하고 돌려줄 값 또는 거부 이유를 돌려준다. 거부면 아무것도 하지 않는다. */
export async function completeStored<T, R extends string>(
  deps: AfterCommitDeps,
  result: Stored<T, R>
): Promise<Outcome<T, R>> {
  if (result.kind === "refused") return result;
  await applyAfterCommit(deps, result.after);
  return { kind: "ok", value: result.value };
}
