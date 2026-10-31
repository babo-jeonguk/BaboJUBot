import {
  sameProviderChoice,
  type ProviderChoice,
  type ProviderReadiness,
  type ProviderReadinessReason,
  type ProviderReadinessStatus,
  type ProviderSettings,
  type ProviderSummary,
} from "@babojubot/contracts";
import { useCallback } from "react";
import { useProviderSettings } from "./api.ts";

// 프로바이더·모델 고르기(#94). 새 연구 조직 창·에이전트 설정·전역 설정의 기본값이 같은 Select 쌍을 쓴다.

/** 모델을 비운 선택. 실행 시도 요청의 모델이 비어 프로바이더가 기본 모델을 쓴다. */
export const defaultModelLabel = "기본 모델";

/** 프로바이더 이름과 모델 이름. 서버에 없는 연결·목록에 없는 모델은 ID 그대로다. */
export function choiceParts(
  providers: readonly ProviderSummary[] | undefined,
  { provider, model }: ProviderChoice
): [provider: string, model: string] {
  const connection = providers?.find((p) => p.id === provider);
  const modelLabel =
    model === null
      ? defaultModelLabel
      : (connection?.models.find((m) => m.id === model)?.label ?? model);
  return [connection?.label ?? provider, modelLabel];
}

/** `프로바이더 · 모델`. */
export const choiceLabel = (
  providers: readonly ProviderSummary[] | undefined,
  choice: ProviderChoice
) => choiceParts(providers, choice).join(" · ");

/** 지금 프로바이더 설정으로 `프로바이더 · 모델`을 만드는 함수. 설정을 읽기 전에는 ID를 보인다. */
export function useChoiceLabel() {
  const providers = useProviderSettings().data?.providers;
  return useCallback(
    (choice: ProviderChoice) => choiceLabel(providers, choice),
    [providers]
  );
}

/** 지금 프로바이더 설정으로 프로바이더 이름과 모델 이름을 따로 내는 함수. */
export function useChoiceParts() {
  const providers = useProviderSettings().data?.providers;
  return useCallback(
    (choice: ProviderChoice) => choiceParts(providers, choice),
    [providers]
  );
}

export const sameDefaults = (
  a: Pick<ProviderSettings, "leadDefault" | "workerDefault">,
  b: Pick<ProviderSettings, "leadDefault" | "workerDefault">
) =>
  sameProviderChoice(a.leadDefault, b.leadDefault) &&
  sameProviderChoice(a.workerDefault, b.workerDefault);

/** 준비 상태 배지의 라벨·톤·앞 아이콘. 색만으로 구분하지 않도록 아이콘과 라벨이 함께 간다. */
const readinessBadge: Record<
  ProviderReadinessStatus,
  { label: string; icon: string; tone: string }
> = {
  ready: { label: "준비됨", icon: "✓", tone: "bg-emerald-50 text-emerald-800" },
  not_ready: { label: "준비안됨", icon: "!", tone: "bg-rose-50 text-rose-800" },
  unknown: {
    label: "알수없음",
    icon: "?",
    tone: "bg-slate-100 text-slate-700",
  },
};

/** 준비 상태의 이유. */
export const readinessReasonLabel: Record<ProviderReadinessReason, string> = {
  program_missing: "프로그램 없음",
  version_unsupported: "지원하지 않는 버전",
  product_login_missing: "제품 로그인 없음",
  credentials_invalid: "자격 증명 거부됨",
  credentials_unverified: "자격 증명 확인 불가",
  not_checked: "확인 전",
  check_failed: "확인 실패",
  check_timeout: "확인 시간 초과",
};

/**
 * 프로바이더 연결의 준비 상태 배지: 앞 아이콘 + 짧은 라벨 + 톤. 확인 중이면 라벨 없는 spinner이며, 화면 읽기 프로그램에는
 * 연결 이름과 함께 `확인 중`으로 읽힌다.
 */
export function ReadinessBadge({
  provider,
  readiness,
  checking = readiness.checking,
}: {
  provider: string;
  readiness: ProviderReadiness;
  checking?: boolean;
}) {
  if (checking)
    return (
      <span
        role="status"
        aria-label={`${provider} 준비 상태 확인 중`}
        data-testid="readiness-checking"
        className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500"
      />
    );
  const { label, icon, tone } = readinessBadge[readiness.status];
  return (
    <span
      data-testid="readiness-badge"
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      <span aria-hidden className="font-bold">
        {icon}
      </span>
      {label}
    </span>
  );
}

const selectClass =
  "mt-1 w-full rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400 disabled:opacity-60";

/**
 * 프로바이더 Select와 모델 Select. 모델의 첫 옵션은 `기본 모델`(값 없음)이고, 프로바이더를 바꾸면 모델은 `기본 모델`이 된다.
 * 서버에 없는 연결이나 목록에 없는 모델이 지금 값이면 그 값도 옵션에 남겨 보인다. 고른 연결의 준비 상태 배지가 칸 옆에 있고,
 * 준비안됨 연결도 목록에 그대로 남는다.
 */
export function ProviderChoiceFields({
  idPrefix,
  label,
  providers,
  value,
  onChange,
  disabled = false,
  inTableRow = false,
}: {
  idPrefix: string;
  /** 칸 이름 앞에 붙는 말(예: `Lead`). 없으면 `프로바이더`·`모델`이다. */
  label?: string;
  providers: readonly ProviderSummary[];
  value: ProviderChoice;
  onChange: (next: ProviderChoice) => void;
  disabled?: boolean;
  /** 표의 한 줄로 쓴다: 열 머리가 칸 이름을 보이므로 칸 이름은 화면 읽기 프로그램에만 남기고, 두 칸을 늘 나란히 둔다. */
  inTableRow?: boolean;
}) {
  const connection = providers.find((p) => p.id === value.provider);
  const models = connection?.models ?? [];
  const badge = connection && (
    <ReadinessBadge
      provider={connection.label}
      readiness={connection.readiness}
    />
  );
  const named = (name: string) => (label ? `${label} ${name}` : name);
  const labelClass = inTableRow
    ? "sr-only"
    : "text-xs font-medium text-slate-600";
  return (
    <div
      className={
        inTableRow
          ? "grid grid-cols-2 gap-2 [&_select]:mt-0"
          : "grid grid-cols-1 gap-3 sm:grid-cols-2"
      }
    >
      <div>
        <label className={labelClass} htmlFor={`${idPrefix}-provider`}>
          {named("프로바이더")}
        </label>
        <div className="flex items-center gap-2 [&_select]:min-w-0 [&_select]:flex-1">
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
          {badge}
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor={`${idPrefix}-model`}>
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
