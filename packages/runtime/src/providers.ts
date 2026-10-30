import type {
  ModelOption,
  ProviderConnection,
  RuntimeAdapter,
} from "@babojubot/contracts";
import { createScriptedRuntime } from "./scripted.ts";

// 프로바이더 연결 등록부의 항목과 모델 목록(#94). 실제 프로바이더 연결은 판 2 후속 이슈에서 같은 모양으로 더한다.

/** 가짜 프로바이더 연결 ID. `pnpm dev`와 이 열 전에 생긴 에이전트의 기본이다(DB migration 0021). */
export const fakeProviderId = "fake";

/**
 * 가짜 프로바이더 연결. 모델을 부르지 않고 시나리오를 연기한다. 모델 목록은 연결 ID를 붙인 고정 목록이라
 * 다른 가짜 연결로 바꾸면 이전 모델이 맞지 않는다.
 */
export function createFakeProvider({
  id = fakeProviderId,
  label = "가짜 프로바이더",
  adapter = createScriptedRuntime(),
}: { id?: string; label?: string; adapter?: RuntimeAdapter } = {}) {
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

/** 가짜 연결 `count`개: `fake`(가짜 프로바이더), `fake-2`(가짜 프로바이더 2), …. 같은 adapter 종류의 연결 여러 개를 검사할 때 쓴다. */
export function createFakeProviders(
  count: number,
  adapter?: (id: string) => RuntimeAdapter
): ProviderConnection[] {
  return Array.from({ length: count }, (_, i) => {
    const id = i === 0 ? fakeProviderId : `${fakeProviderId}-${i + 1}`;
    return createFakeProvider({
      id,
      label: i === 0 ? "가짜 프로바이더" : `가짜 프로바이더 ${i + 1}`,
      adapter: adapter?.(id),
    });
  });
}

/**
 * 연결의 모델 목록. 연결이 받아 오는 목록을 쓰고, 받아 오지 못하면(오류·시간 초과) 또는 빈 목록이면 연결의 고정 목록을 쓴다.
 * 빈 목록도 일시 오류와 구별하지 않고 고정 목록으로 본다. 목록 조회는 모델을 부르지 않는다.
 */
export async function listProviderModels(
  connection: ProviderConnection,
  { timeoutMs = 3_000 }: { timeoutMs?: number } = {}
): Promise<ModelOption[]> {
  const fixed = [...connection.models];
  if (!connection.listModels) return fixed;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetched = await Promise.race([
      connection.listModels(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 먼저 끝을 정한 뒤 조회를 멈춘다. 멈추며 늦게 돌아온 목록은 쓰지 않는다.
          reject(new Error("model list timed out"));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
    return fetched.length ? fetched : fixed;
  } catch (error) {
    console.warn(`[providers] ${connection.id} model list unavailable`, error);
    return fixed;
  } finally {
    clearTimeout(timer);
  }
}
