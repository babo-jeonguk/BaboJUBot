import {
  providerCapabilitiesSchema,
  type ProviderCatalog,
  type ProviderChoice,
  type ProviderConnection,
  type ProviderReadiness,
  type ProviderSettings,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import {
  readProviderDefaults,
  readProviderLimits,
  readProviderReadiness,
  type Database,
} from "@babojubot/db";
import {
  checkProviderChoices,
  type ProviderChoiceProblem,
  type ProviderModels,
} from "@babojubot/core";
import { listProviderModels } from "@babojubot/runtime";

export type { ProviderChoiceProblem };

/**
 * 서버에 등록한 이름 붙은 프로바이더 연결(#94). 실행 시도는 admission이 고정한 연결 ID의 adapter가 맡고,
 * 사용자가 고르는 연결·모델은 이 등록부와 연결의 모델 목록으로 확인한다.
 */
export type ProviderRegistry = {
  adapters: ReadonlyMap<string, RuntimeAdapter>;
  has: (id: string) => boolean;
  /** 등록된 연결이고, 모델을 골랐다면 그 연결의 모델 목록에 있는가. */
  checkChoice: (
    choice: ProviderChoice
  ) => Promise<ProviderChoiceProblem | undefined>;
  /**
   * 이 선택들을 확인할 연결별 모델 목록. 등록된 연결만 담으며, 선택에 나온 연결의 목록만 한 번씩 받아 온다.
   * 저장 규칙 안에서 확인하는 쓰기(조직 도구·승인 결정)는 잠금 밖에서 이것을 받아 넘긴다.
   */
  modelsFor: (choices: readonly ProviderChoice[]) => Promise<ProviderModels>;
  /** 연결의 adapter가 끼워 넣기를 지원하는가. 없는 연결은 아니다. */
  steerable: (id: string) => boolean;
  /** Lead가 작업자를 제안할 때 읽는 목록: 작업자 기본값과 연결마다 이름·모델 목록·마지막 준비 상태. */
  catalog: (db: Database) => Promise<ProviderCatalog>;
  /** 전역 설정 화면의 프로바이더 설정: 기본값, 연결마다 모델 목록·동시 실행 상한·지원하는 일·준비 상태·로그인 명령. */
  settings: (db: Database) => Promise<ProviderSettings>;
};

/**
 * 등록부를 만든다. 연결 ID가 겹치거나 없으면, 연결이 지원하는 일을 모두 선언하지 않았거나 끼워 넣기 선언과 `steer`가 맞지 않으면 시작 오류다.
 * `checking`은 지금 준비 확인 중인 연결이다(`ReadinessMonitor`).
 */
export function createProviderRegistry(
  connections: readonly ProviderConnection[],
  { checking = () => false }: { checking?: (id: string) => boolean } = {}
): ProviderRegistry {
  if (!connections.length)
    throw new Error("at least one provider connection is required");
  const byId = new Map(connections.map((c) => [c.id, c]));
  if (byId.size !== connections.length)
    throw new Error("provider connection IDs must be unique");
  for (const { id, adapter } of connections) {
    const declared = providerCapabilitiesSchema.safeParse(adapter.capabilities);
    if (!declared.success)
      throw new Error(`provider ${id} must declare every capability`, {
        cause: declared.error,
      });
    if (declared.data.steer !== (typeof adapter.steer === "function"))
      throw new Error(`provider ${id} declares steer without a steer channel`);
  }
  const readiness = async (db: Database) => {
    const saved = await readProviderReadiness(db);
    return (id: string): ProviderReadiness => {
      const last = saved.get(id);
      return {
        status: last?.status ?? "unknown",
        reason: last ? last.reason : "not_checked",
        checkedAt: last?.checkedAt ?? null,
        checking: checking(id),
      };
    };
  };
  const modelsFor = (choices: readonly ProviderChoice[]) =>
    Promise.all(
      [...new Set(choices.map((c) => c.provider))].flatMap((id) => {
        const connection = byId.get(id);
        return connection
          ? [listProviderModels(connection).then((models) => ({ id, models }))]
          : [];
      })
    );
  return {
    adapters: new Map(connections.map((c) => [c.id, c.adapter])),
    has: (id) => byId.has(id),
    checkChoice: async (choice) =>
      checkProviderChoices(await modelsFor([choice]), [choice]),
    modelsFor,
    steerable: (id) => byId.get(id)?.adapter.capabilities.steer ?? false,
    async catalog(db) {
      const { workerDefault } = await readProviderDefaults(db);
      const readinessOf = await readiness(db);
      return {
        workerDefault,
        providers: await Promise.all(
          connections.map(async (c) => {
            const { status, reason } = readinessOf(c.id);
            return {
              id: c.id,
              label: c.label,
              models: await listProviderModels(c),
              readiness: { status, reason },
            };
          })
        ),
      };
    },
    async settings(db) {
      const defaults = await readProviderDefaults(db);
      const limits = await readProviderLimits(db, [...byId.keys()]);
      const readinessOf = await readiness(db);
      return {
        ...defaults,
        providers: await Promise.all(
          connections.map(async (c) => ({
            id: c.id,
            label: c.label,
            models: await listProviderModels(c),
            maxConcurrentRuns: limits.get(c.id)!,
            capabilities: providerCapabilitiesSchema.parse(
              c.adapter.capabilities
            ),
            readiness: readinessOf(c.id),
            loginCommand: c.adapter.loginCommand,
          }))
        ),
      };
    },
  };
}
