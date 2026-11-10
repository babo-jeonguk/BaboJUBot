import type { AfterCommit, Stored } from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

export type AfterCommitDeps = {
  ensureWorkspace?: (organizationId: string) => Promise<unknown>;
  hub: Pick<EventHub, "publish" | "publishSettingsChanged">;
  dispatcher: Pick<
    RunDispatcher,
    "cancel" | "kickOrganization" | "kick" | "kickProvider"
  >;
};

/**
 * 저장이 commit된 뒤 할 일을 정해진 순서로 한다: Event·전역 설정 변경 알리기 → 진행 중 실행 시도 취소 → 재개한 조직의 대기 깨우기 다시 처리
 * (첫 조회를 기다림) → 깨운 에이전트의 실행 시도 촉진 → 자리가 늘어난 프로바이더 연결을 기다리는 에이전트 촉진(첫 조회를 기다림).
 * 사용자가 한 일, 조직 도구 쓰기, heartbeat 확인, 실행 시도 종료·서버 재시작 복구가 모두 이것을 쓴다.
 * 효과 하나(대상 하나)가 실패하면 진단으로 남기고 나머지를 계속하며 던지지 않는다. 이미 저장된 결과는 바뀌지 않고,
 * 놓친 알림·촉진은 DB의 Event·대기 깨우기를 다시 읽어 맞춘다. 영속 outbox가 아니라 commit 직후 서버가 멈추면 그 알림·촉진은 사라진다.
 * 촉진은 첫 조회까지만 기다리고 촉진된 실행 시도를 기다리지 않으므로, 실행 시도 종료 경로가 자기 처리를 기다리며 막히지 않는다.
 */
export async function applyAfterCommit(
  { hub, dispatcher, ensureWorkspace }: AfterCommitDeps,
  {
    events,
    cancellation,
    resumedOrganizationId,
    woken,
    settingsChanged,
    providersFreed,
  }: AfterCommit
): Promise<void> {
  if (ensureWorkspace)
    for (const id of new Set(
      events
        .filter((e) =>
          ["organization.created", "worker.added", "approval.decided"].includes(
            e.type
          )
        )
        .map((e) => e.organizationId)
    ))
      try {
        await ensureWorkspace(id);
      } catch {
        report(
          "[workspace] folder preparation failed; the next run assembly will retry",
          id
        );
      }
  if (events.length)
    bestEffort(`publishing events ${events.map((e) => e.id)}`, () =>
      hub.publish(...events)
    );
  if (settingsChanged)
    bestEffort("signalling a settings change", () =>
      hub.publishSettingsChanged()
    );
  if (cancellation)
    bestEffort(`cancelling runs ${cancellation.runIds}`, () =>
      dispatcher.cancel(cancellation)
    );
  if (resumedOrganizationId)
    await bestEffort(
      `kicking resumed organization ${resumedOrganizationId}`,
      () => dispatcher.kickOrganization(resumedOrganizationId)
    );
  for (const agentId of woken ?? [])
    bestEffort(`kicking agent ${agentId}`, () => dispatcher.kick(agentId));
  for (const provider of providersFreed ?? [])
    await bestEffort(`kicking agents waiting for provider ${provider}`, () =>
      dispatcher.kickProvider(provider)
    );
}

/**
 * commit 뒤 효과 하나를 하고, 실패하면 진단으로 남긴다. 저장은 이미 끝났으므로 실패를 호출자에게 넘기지 않는다.
 * 동기 효과는 그 자리에서 끝내고, 비동기 효과만 기다릴 Promise를 돌려준다.
 */
function bestEffort(
  what: string,
  effect: () => void | Promise<void>
): void | Promise<void> {
  const failed = (error: unknown) =>
    report(`[after-commit] ${what} failed; the saved result stands`, error);
  try {
    const pending = effect();
    if (pending) return pending.catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** 진단을 남긴다. 진단 자체가 실패해도 나머지 효과를 막지 않는다. */
function report(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    /* 진단을 남길 곳이 없어도 이미 저장된 결과와 다른 효과는 그대로다. */
  }
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
