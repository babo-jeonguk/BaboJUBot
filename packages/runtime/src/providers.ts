import type {
  ModelOption,
  ProviderConnection,
  RuntimeAdapter,
} from "@babojubot/contracts";
import {
  createScriptedRuntime,
  type FakeProviderSettings,
} from "./scripted.ts";

// 프로바이더 연결 등록부의 항목과 모델 목록(#94). 실제 프로바이더 연결은 판 2 후속 이슈에서 같은 모양으로 더한다.

/** 가짜 프로바이더 연결 ID. `pnpm dev`와 이 열 전에 생긴 에이전트의 기본이다(DB migration 0021). */
export const fakeProviderId = "fake";

/**
 * 가짜 프로바이더 연결. 모델을 부르지 않고 시나리오를 연기한다. 모델 목록은 연결 ID를 붙인 고정 목록이라
 * 다른 가짜 연결로 바꾸면 이전 모델이 맞지 않는다. 지원하는 일·준비 상태·사용량은 `settings`로 바꾼다(`adapter`를 주면 그 adapter의 것).
 */
export function createFakeProvider({
  id = fakeProviderId,
  label = "가짜 프로바이더",
  settings,
  adapter = createScriptedRuntime({ settings }),
}: {
  id?: string;
  label?: string;
  settings?: FakeProviderSettings;
  adapter?: RuntimeAdapter;
} = {}) {
  return {
    id,
    label,
    adapter,
    models: [
      { id: `${id}-mini`, label: "미니" },
      { id: `${id}-max`, label: "맥스" },
    ],
  } satisfies ProviderConnection;
}

/**
 * 가짜 연결 `count`개: `fake`(가짜 프로바이더), `fake-2`(가짜 프로바이더 2), …. 같은 adapter 종류의 연결 여러 개를 검사할 때 쓴다.
 * `settings`는 연결 ID별 설정이다.
 */
export function createFakeProviders(
  count: number,
  {
    adapter,
    settings = {},
  }: {
    adapter?: (id: string) => RuntimeAdapter;
    settings?: Record<string, FakeProviderSettings>;
  } = {}
): ProviderConnection[] {
  return Array.from({ length: count }, (_, i) => {
    const id = i === 0 ? fakeProviderId : `${fakeProviderId}-${i + 1}`;
    return createFakeProvider({
      id,
      label: i === 0 ? "가짜 프로바이더" : `가짜 프로바이더 ${i + 1}`,
      settings: settings[id],
      ...(adapter ? { adapter: adapter(id) } : {}),
    });
  });
}

/** 저장해 둔 목록과 진행 중인 조회. 연결마다 하나다. */
type ModelListState = {
  models?: ModelOption[];
  fetchedAt?: number;
  refreshing?: Promise<void>;
};
const modelLists = new WeakMap<ProviderConnection, ModelListState>();

async function refreshModels(
  connection: ProviderConnection,
  state: ModelListState,
  fetchLimitMs: number
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetched = await Promise.race([
      connection.listModels!(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("model list timed out"));
          controller.abort();
        }, fetchLimitMs);
        timer.unref();
      }),
    ]);
    if (fetched.length) {
      state.models = fetched;
      state.fetchedAt = Date.now();
    }
  } catch (error) {
    console.warn(`[providers] ${connection.id} model list unavailable`, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 연결의 모델 목록. 받아 온 목록을 저장해 두고 쓰며, 오래되면 저장한 목록으로 바로 답한 뒤 뒤에서 새로 받는다.
 * 저장한 목록이 없으면 `timeoutMs`까지 기다리고, 그래도 없으면 연결의 고정 목록으로 답한다. 늦게 끝난 조회의 결과는 다음 호출이 쓴다.
 * 동시에 부른 호출은 조회 하나를 함께 쓴다. 빈 목록은 일시 오류와 구별하지 않고 저장하지 않는다. 목록 조회는 모델을 부르지 않는다.
 */
export async function listProviderModels(
  connection: ProviderConnection,
  {
    timeoutMs = 15_000,
    maxAgeMs = 5 * 60 * 1000,
    fetchLimitMs = 60_000,
  }: { timeoutMs?: number; maxAgeMs?: number; fetchLimitMs?: number } = {}
): Promise<ModelOption[]> {
  const fixed = [...connection.models];
  if (!connection.listModels) return fixed;
  let state = modelLists.get(connection);
  if (!state) {
    state = {};
    modelLists.set(connection, state);
  }
  const current = state;
  if (
    current.models &&
    current.fetchedAt !== undefined &&
    Date.now() - current.fetchedAt < maxAgeMs &&
    maxAgeMs > 0
  )
    return current.models;
  const answer = current.models;
  current.refreshing ??= refreshModels(
    connection,
    current,
    fetchLimitMs
  ).finally(() => {
    current.refreshing = undefined;
  });
  if (answer) return answer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    current.refreshing,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return current.models ?? fixed;
}
