import {
  defaultCompactionSettings,
  type ProviderSettings,
  type ProviderSummary,
} from "@babojubot/contracts";
import { useEffect, useState } from "react";
import {
  ApiError,
  useCheckAllReadiness,
  useProviderSettings,
  useRecheckProvider,
  useUpdateProviderDefaults,
  useUpdateProviderLimit,
  useUpdateIsolation,
} from "./api.ts";
import { focusFirstChoiceProblem, isChoiceRefusal } from "./choice-problems.ts";
import {
  ProviderChoiceFields,
  ReadinessBadge,
  readinessReasonLabel,
  sameDefaults,
} from "./provider-choice.tsx";
import { Loading, LoadError, Page, SaveStatus } from "./ui.tsx";

/**
 * 전역 설정. 프로바이더 칸은 Lead·작업자 기본 프로바이더·모델과 연결별 준비 상태·동시 실행 상한이다(#94, #96).
 * 화면을 열면 서버가 모든 연결의 준비 상태를 다시 확인한다.
 * 나머지 칸(연구 환경 템플릿, 비밀값, 메시지 앱 연결)은 자리만 있고, 지금 쓰는 것을 그대로 알리며 동작하는 것처럼 보이지 않는다.
 */
export function GlobalSettingsPage() {
  return (
    <Page width="reading">
      <h1 className="mb-5 text-xl font-semibold">전역 설정</h1>
      <div className="space-y-3">
        <Providers />
        <Placeholder title="연구 환경 템플릿" now="조직별 연구 환경 명세" />
        <Placeholder title="비밀값" now="없음" />
        <Placeholder title="메시지 앱 연결" now="가짜 채널" />
      </div>
    </Page>
  );
}

function Providers() {
  const settings = useProviderSettings();
  const checkAll = useCheckAllReadiness();
  const { mutate: startChecks } = checkAll;
  useEffect(() => startChecks(), [startChecks]);
  return (
    <section aria-label="프로바이더" className="card p-4 text-sm">
      <h2 className="mb-3 font-semibold">프로바이더</h2>
      {settings.isPending ? (
        <Loading />
      ) : settings.isError ? (
        <LoadError
          what="프로바이더 설정"
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <Defaults settings={settings.data} />
          <ul
            aria-label="실행 환경"
            className="mt-4 border-t border-slate-100 pt-1"
          >
            <IsolationSwitch isolated={settings.data.isolated} />
          </ul>
          <div className="mt-4 flex border-t border-slate-100 pt-3 text-xs text-slate-500">
            <span className="flex-1">연결</span>
            <span>동시 실행 상한</span>
          </div>
          <ul aria-label="연결" className="divide-y divide-slate-100">
            {settings.data.providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type DefaultsValue = Pick<
  ProviderSettings,
  "leadDefault" | "workerDefault" | "compaction"
>;

/**
 * Lead·작업자 기본값. 고치는 동안의 값은 초안으로 두어 다른 탭의 변경이 덮지 않고 저장에 실패해도 남는다.
 * 바뀐 값이 있을 때만 `저장`을 누를 수 있다. 기본값은 이후에 만드는 에이전트에만 복사된다.
 */
function Defaults({ settings }: { settings: ProviderSettings }) {
  const update = useUpdateProviderDefaults();
  const saved: DefaultsValue = {
    leadDefault: settings.leadDefault,
    workerDefault: settings.workerDefault,
    compaction: settings.compaction ?? defaultCompactionSettings,
  };
  const [draft, setDraft] = useState<DefaultsValue | null>(null);
  const value = draft ?? saved;
  const compact = value.compaction ?? defaultCompactionSettings;
  const changed =
    !sameDefaults(value, saved) ||
    compact.thresholdTokens !== saved.compaction!.thresholdTokens ||
    compact.ratio !== saved.compaction!.ratio;
  // 서버가 거부할 프로바이더·모델은 보내기 전에 그 칸의 오류로 알린다. 그사이 목록이 바뀌어 서버가 거부하면 목록을 다시 받아
  // 그 칸에 알린다. 그 밖의 저장 실패(통신·서버)는 칸과 잇지 않는 폼 아래 안내다.
  const [showProblem, setShowProblem] = useState(false);
  const list = useProviderSettings();
  const fields = (v: DefaultsValue) => [
    { idPrefix: "lead-default", choice: v.leadDefault },
    { idPrefix: "worker-default", choice: v.workerDefault },
  ];
  const refused =
    update.error instanceof ApiError && isChoiceRefusal(update.error.code);
  return (
    <form
      aria-label="기본 프로바이더"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed) return;
        if (focusFirstChoiceProblem(settings.providers, fields(value))) {
          setShowProblem(true);
          return;
        }
        update.mutate(value, {
          onSuccess: () => setDraft(null),
          onError: async (error) => {
            if (!(error instanceof ApiError && isChoiceRefusal(error.code)))
              return;
            setShowProblem(true);
            const fresh = (await list.refetch()).data;
            if (fresh) focusFirstChoiceProblem(fresh.providers, fields(value));
          },
        });
      }}
    >
      <ProviderChoiceFields
        idPrefix="lead-default"
        label="Lead 기본"
        providers={settings.providers}
        value={value.leadDefault}
        onChange={(leadDefault) => setDraft({ ...value, leadDefault })}
        disabled={update.isPending}
        showProblem={showProblem}
      />
      <ProviderChoiceFields
        idPrefix="worker-default"
        label="작업자 기본"
        providers={settings.providers}
        value={value.workerDefault}
        onChange={(workerDefault) => setDraft({ ...value, workerDefault })}
        disabled={update.isPending}
        showProblem={showProblem}
      />
      <CompactionNumber
        label="압축 기준"
        unit="토큰"
        min={50000}
        max={1000000}
        step={10000}
        value={compact.thresholdTokens}
        disabled={update.isPending}
        onChange={(thresholdTokens) =>
          setDraft({ ...value, compaction: { ...compact, thresholdTokens } })
        }
      />
      <CompactionNumber
        label="압축 시점"
        unit="%"
        min={50}
        max={95}
        step={5}
        value={compact.ratio * 100}
        disabled={update.isPending}
        onChange={(percent) =>
          setDraft({
            ...value,
            compaction: { ...compact, ratio: percent / 100 },
          })
        }
      />
      <div className="flex items-center justify-end gap-3">
        {!update.isPending && update.isError && (
          <p role="alert" className="text-xs text-rose-600">
            {refused
              ? "서버가 고른 프로바이더나 모델을 받지 않았습니다. 표시한 칸을 고치세요."
              : "저장하지 못했습니다. 다시 시도하세요."}
          </p>
        )}
        <button
          type="submit"
          className="btn-soft"
          disabled={update.isPending || !changed}
        >
          {update.isPending ? "저장하는 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}

/** 0은 무제한이다. */
const limitText = (n: number) => (n === 0 ? "무제한" : String(n));

/**
 * 연결 한 줄: 이름, 준비 상태 배지·이유, `다시 확인`(이유가 제품 로그인 없음이면 `로그인 명령 복사`도), 동시 실행 상한 stepper.
 * stepper는 −·＋와 숫자 칸으로 바꾸며 바꾸면 곧바로 저장한다. 0(무제한)에서 −는 누를 수 없고,
 * 1에서 −를 누르면 무제한, 무제한에서 ＋를 누르면 1이다. 숫자 칸은 Enter나 칸을 벗어날 때 저장하고, 0 이상 정수가 아니면 되돌린다.
 */
function ProviderRow({ provider }: { provider: ProviderSummary }) {
  const update = useUpdateProviderLimit();
  const [typed, setTyped] = useState<string | null>(null);
  const value = provider.maxConcurrentRuns;
  const save = (maxConcurrentRuns: number) => {
    if (maxConcurrentRuns !== value)
      update.mutate({ provider: provider.id, maxConcurrentRuns });
  };
  const commit = () => {
    if (typed === null) return;
    const text = typed.trim();
    setTyped(null);
    if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text)))
      save(Number(text));
  };
  const name = `${provider.label} 동시 실행 상한`;
  return (
    <li
      className="flex flex-wrap items-center gap-3 py-3"
      aria-label={provider.label}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{provider.label}</span>
        <Readiness provider={provider} />
      </div>
      <div className="flex items-center gap-1" role="group" aria-label={name}>
        <button
          type="button"
          className="btn-soft size-8 justify-center p-0"
          aria-label={`${name} 줄이기`}
          disabled={value === 0 || update.isPending}
          onClick={() => save(value - 1)}
        >
          −
        </button>
        <input
          aria-label={name}
          inputMode="numeric"
          className="w-20 rounded-xl bg-slate-50 px-2 py-1.5 text-center text-sm tabular-nums ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400 disabled:opacity-60"
          value={typed ?? limitText(value)}
          disabled={update.isPending}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setTyped(null);
          }}
        />
        <button
          type="button"
          className="btn-soft size-8 justify-center p-0"
          aria-label={`${name} 늘리기`}
          disabled={update.isPending}
          onClick={() => save(value + 1)}
        >
          ＋
        </button>
      </div>
      {!update.isPending && update.isError && (
        <p role="alert" className="w-full text-right text-xs text-rose-600">
          저장하지 못했습니다. 다시 시도하세요.
        </p>
      )}
    </li>
  );
}

/**
 * 연결의 준비 상태: 배지와 이유, `다시 확인`, 이유가 제품 로그인 없음이고 연결이 로그인 명령을 줄 때만 `로그인 명령 복사`.
 * 확인 중에는 배지 자리에 spinner가 있고 이유는 마지막 확인의 것이다.
 */
function Readiness({ provider }: { provider: ProviderSummary }) {
  const recheck = useRecheckProvider();
  const [copied, setCopied] = useState(false);
  const { readiness, loginCommand } = provider;
  const checking = readiness.checking || recheck.isPending;
  const copy = async () => {
    if (!loginCommand) return;
    try {
      await navigator.clipboard.writeText(loginCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 복사하지 못하면 버튼은 그대로다.
    }
  };
  return (
    <>
      <ReadinessBadge
        provider={provider.label}
        readiness={readiness}
        checking={checking}
      />
      {readiness.reason && (
        <span className="text-xs text-slate-500" data-testid="readiness-reason">
          {readinessReasonLabel[readiness.reason]}
        </span>
      )}
      <button
        type="button"
        className="btn-ghost px-2 py-1 text-xs"
        disabled={checking}
        aria-label={`${provider.label} 다시 확인`}
        onClick={() => recheck.mutate(provider.id)}
      >
        다시 확인
      </button>
      {readiness.reason === "product_login_missing" && loginCommand && (
        <button
          type="button"
          className="btn-ghost px-2 py-1 text-xs"
          aria-label={`${provider.label} 로그인 명령 복사`}
          onClick={() => void copy()}
        >
          {copied ? "복사됨" : "로그인 명령 복사"}
        </button>
      )}
    </>
  );
}

function Placeholder({ title, now }: { title: string; now: string }) {
  return (
    <section
      aria-label={title}
      className="card flex items-center gap-3 p-4 text-sm"
    >
      <h2 className="flex-1 font-semibold">{title}</h2>
      <span className="text-slate-600">{now}</span>
      <span className="chip bg-slate-100 text-slate-500">준비 중</span>
    </section>
  );
}

function CompactionNumber({
  label,
  unit,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const commit = () => {
    if (typed !== null) {
      onChange(
        typed.trim() && Number.isFinite(Number(typed))
          ? clamp(Number(typed))
          : value
      );
      setTyped(null);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>{label}</span>
      <div className="flex items-center gap-1" role="group" aria-label={label}>
        <button
          type="button"
          className="btn-soft size-8 justify-center p-0"
          aria-label={`${label} 줄이기`}
          disabled={disabled || value <= min}
          onClick={() => {
            setTyped(null);
            onChange(clamp(value - step));
          }}
        >
          −
        </button>
        <input
          type="number"
          aria-label={label}
          className="input w-28 text-right"
          min={min}
          max={max}
          step="any"
          value={typed ?? String(value)}
          disabled={disabled}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <span className="text-xs text-slate-500">{unit}</span>
        <button
          type="button"
          className="btn-soft size-8 justify-center p-0"
          aria-label={`${label} 늘리기`}
          disabled={disabled || value >= max}
          onClick={() => {
            setTyped(null);
            onChange(clamp(value + step));
          }}
        >
          ＋
        </button>
      </div>
    </div>
  );
}

/**
 * 격리 실행 스위치. 누르면 바로 저장하고 설명문은 두지 않으며, 저장 결과는 스위치 옆 상태(`SaveStatus`)로 알린다. 저장하는 동안은 보낸 값으로 잠그고, 실패하면 서버에 저장된 값으로 돌아간다.
 * 보낸 값은 누른 순간 지역 상태에 둔다. mutation 상태는 한 박자 늦게 바뀌어, 그 사이 controlled 스위치가 옛 값으로 되돌아가지 않게 한다.
 */
function IsolationSwitch({ isolated }: { isolated: boolean }) {
  const update = useUpdateIsolation();
  const [requested, setRequested] = useState<boolean | null>(null);
  const saving = requested !== null;
  const checked = requested ?? isolated;
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        <label htmlFor="isolation-switch" className="flex-1 font-medium">
          격리 실행
        </label>
        <SaveStatus
          id="isolation-switch-status"
          label="격리 실행"
          state={saving ? "saving" : update.isSuccess ? "saved" : "idle"}
        />
        <input
          id="isolation-switch"
          type="checkbox"
          role="switch"
          className="switch"
          checked={checked}
          // 저장하는 동안 잠그되 disabled로 바꾸지 않는다. disabled가 되면 키보드 포커스가 스위치에서 빠진다.
          aria-disabled={saving || undefined}
          aria-describedby="isolation-switch-status"
          onChange={(e) => {
            if (saving) return;
            const value = e.currentTarget.checked;
            setRequested(value);
            update.mutate(
              { isolated: value },
              { onSettled: () => setRequested(null) }
            );
          }}
        />
      </div>
      {!saving && update.isError && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          격리 실행 설정을 저장하지 못했습니다. 다시 시도하세요.
        </p>
      )}
    </li>
  );
}
