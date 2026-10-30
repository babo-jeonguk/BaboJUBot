import type {
  ModelOption,
  ProviderCatalog,
  ProviderChoice,
  ProviderConnection,
  ProviderSettings,
  RuntimeAdapter,
} from "@babojubot/contracts";
import {
  readProviderDefaults,
  readProviderLimits,
  type Database,
} from "@babojubot/db";
import { listProviderModels } from "@babojubot/runtime";

/** 고른 프로바이더·모델이 이 서버에서 쓸 수 없는 이유. */
export type ProviderChoiceProblem = "unknown_provider" | "unknown_model";

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
  /** 여러 선택을 함께 확인한다. 연결마다 모델 목록은 한 번만 받아 오며, 처음 걸린 문제를 돌려준다. */
  checkChoices: (
    choices: readonly ProviderChoice[]
  ) => Promise<ProviderChoiceProblem | undefined>;
  /** Lead가 작업자를 제안할 때 읽는 목록: 작업자 기본값과 연결마다 이름·모델 목록. */
  catalog: (db: Database) => Promise<ProviderCatalog>;
  /** 전역 설정 화면의 프로바이더 설정: 기본값, 연결마다 모델 목록·동시 실행 상한. */
  settings: (db: Database) => Promise<ProviderSettings>;
};

export function createProviderRegistry(
  connections: readonly ProviderConnection[]
): ProviderRegistry {
  if (!connections.length)
    throw new Error("at least one provider connection is required");
  const byId = new Map(connections.map((c) => [c.id, c]));
  if (byId.size !== connections.length)
    throw new Error("provider connection IDs must be unique");
  const checkChoices = async (choices: readonly ProviderChoice[]) => {
    const models = new Map<string, Promise<ModelOption[]>>();
    for (const { provider, model } of choices) {
      const connection = byId.get(provider);
      if (!connection) return "unknown_provider" as const;
      if (model === null) continue;
      if (!models.has(provider))
        models.set(provider, listProviderModels(connection));
      if (!(await models.get(provider)!).some((m) => m.id === model))
        return "unknown_model" as const;
    }
    return undefined;
  };
  return {
    adapters: new Map(connections.map((c) => [c.id, c.adapter])),
    has: (id) => byId.has(id),
    checkChoice: (choice) => checkChoices([choice]),
    checkChoices,
    async catalog(db) {
      const { workerDefault } = await readProviderDefaults(db);
      return {
        workerDefault,
        providers: await Promise.all(
          connections.map(async (c) => ({
            id: c.id,
            label: c.label,
            models: await listProviderModels(c),
          }))
        ),
      };
    },
    async settings(db) {
      const defaults = await readProviderDefaults(db);
      const limits = await readProviderLimits(db, [...byId.keys()]);
      return {
        ...defaults,
        providers: await Promise.all(
          connections.map(async (c) => ({
            id: c.id,
            label: c.label,
            models: await listProviderModels(c),
            maxConcurrentRuns: limits.get(c.id)!,
          }))
        ),
      };
    },
  };
}
