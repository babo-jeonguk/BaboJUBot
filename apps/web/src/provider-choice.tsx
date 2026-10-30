import {
  sameProviderChoice,
  type ProviderChoice,
  type ProviderSettings,
  type ProviderSummary,
} from "@babojubot/contracts";
import { useCallback } from "react";
import { useProviderSettings } from "./api.ts";

// 프로바이더·모델 고르기(#94). 새 연구 조직 창·에이전트 설정·전역 설정의 기본값이 같은 Select 쌍을 쓴다.

/** 모델을 비운 선택. 실행 시도 요청의 모델이 비어 프로바이더가 기본 모델을 쓴다. */
export const defaultModelLabel = "기본 모델";

/** `프로바이더 · 모델`. 서버에 없는 연결·목록에 없는 모델은 ID 그대로다. */
export function choiceLabel(
  providers: readonly ProviderSummary[] | undefined,
  { provider, model }: ProviderChoice
) {
  const connection = providers?.find((p) => p.id === provider);
  const modelLabel =
    model === null
      ? defaultModelLabel
      : (connection?.models.find((m) => m.id === model)?.label ?? model);
  return `${connection?.label ?? provider} · ${modelLabel}`;
}

/** 지금 프로바이더 설정으로 `프로바이더 · 모델`을 만드는 함수. 설정을 읽기 전에는 ID를 보인다. */
export function useChoiceLabel() {
  const providers = useProviderSettings().data?.providers;
  return useCallback(
    (choice: ProviderChoice) => choiceLabel(providers, choice),
    [providers]
  );
}

export const sameDefaults = (
  a: Pick<ProviderSettings, "leadDefault" | "workerDefault">,
  b: Pick<ProviderSettings, "leadDefault" | "workerDefault">
) =>
  sameProviderChoice(a.leadDefault, b.leadDefault) &&
  sameProviderChoice(a.workerDefault, b.workerDefault);

const selectClass =
  "mt-1 w-full rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400 disabled:opacity-60";

/**
 * 프로바이더 Select와 모델 Select. 모델의 첫 옵션은 `기본 모델`(값 없음)이고, 프로바이더를 바꾸면 모델은 `기본 모델`이 된다.
 * 서버에 없는 연결이나 목록에 없는 모델이 지금 값이면 그 값도 옵션에 남겨 보인다.
 */
export function ProviderChoiceFields({
  idPrefix,
  label,
  providers,
  value,
  onChange,
  disabled = false,
}: {
  idPrefix: string;
  /** 칸 이름 앞에 붙는 말(예: `Lead`). 없으면 `프로바이더`·`모델`이다. */
  label?: string;
  providers: readonly ProviderSummary[];
  value: ProviderChoice;
  onChange: (next: ProviderChoice) => void;
  disabled?: boolean;
}) {
  const connection = providers.find((p) => p.id === value.provider);
  const models = connection?.models ?? [];
  const named = (name: string) => (label ? `${label} ${name}` : name);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label
          className="text-xs font-medium text-slate-600"
          htmlFor={`${idPrefix}-provider`}
        >
          {named("프로바이더")}
        </label>
        <select
          id={`${idPrefix}-provider`}
          className={selectClass}
          value={value.provider}
          disabled={disabled}
          onChange={(e) =>
            onChange({ provider: e.currentTarget.value, model: null })
          }
        >
          {!connection && (
            <option value={value.provider}>{value.provider}</option>
          )}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label
          className="text-xs font-medium text-slate-600"
          htmlFor={`${idPrefix}-model`}
        >
          {named("모델")}
        </label>
        <select
          id={`${idPrefix}-model`}
          className={selectClass}
          value={value.model ?? ""}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              provider: value.provider,
              model: e.currentTarget.value || null,
            })
          }
        >
          <option value="">{defaultModelLabel}</option>
          {value.model !== null &&
            !models.some((m) => m.id === value.model) && (
              <option value={value.model}>{value.model}</option>
            )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
