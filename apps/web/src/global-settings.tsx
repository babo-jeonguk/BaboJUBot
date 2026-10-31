import type { ProviderSettings, ProviderSummary } from "@babojubot/contracts";
import { useEffect, useState } from "react";
import {
  useCheckAllReadiness,
  useProviderSettings,
  useRecheckProvider,
  useUpdateProviderDefaults,
  useUpdateProviderLimit,
} from "./api.ts";
import {
  ProviderChoiceFields,
  ReadinessBadge,
  readinessReasonLabel,
  sameDefaults,
} from "./provider-choice.tsx";
import { Loading, LoadError, Page } from "./ui.tsx";

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

type DefaultsValue = Pick<ProviderSettings, "leadDefault" | "workerDefault">;

/**
 * Lead·작업자 기본값. 고치는 동안의 값은 초안으로 두어 다른 탭의 변경이 덮지 않고 저장에 실패해도 남는다.
 * 바뀐 값이 있을 때만 `저장`을 누를 수 있다. 기본값은 이후에 만드는 에이전트에만 복사된다.
 */
function Defaults({ settings }: { settings: ProviderSettings }) {
  const update = useUpdateProviderDefaults();
  const saved: DefaultsValue = {
    leadDefault: settings.leadDefault,
    workerDefault: settings.workerDefault,
  };
  const [draft, setDraft] = useState<DefaultsValue | null>(null);
  const value = draft ?? saved;
  const changed = !sameDefaults(value, saved);
  return (
    <form
      aria-label="기본 프로바이더"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) update.mutate(value, { onSuccess: () => setDraft(null) });
      }}
    >
      <ProviderChoiceFields
        idPrefix="lead-default"
        label="Lead 기본"
        providers={settings.providers}
        value={value.leadDefault}
        onChange={(leadDefault) => setDraft({ ...value, leadDefault })}
        disabled={update.isPending}
      />
      <ProviderChoiceFields
        idPrefix="worker-default"
        label="작업자 기본"
        providers={settings.providers}
        value={value.workerDefault}
        onChange={(workerDefault) => setDraft({ ...value, workerDefault })}
        disabled={update.isPending}
      />
      <div className="flex items-center justify-end gap-3">
        {!update.isPending && update.isError && (
          <p role="alert" className="text-xs text-rose-600">
            저장하지 못했습니다. 다시 시도하세요.
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
