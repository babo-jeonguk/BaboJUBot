import type { ProposedWorker, ProviderChoice } from "@babojubot/contracts";

// 승인 결정 폼과 결정 뒤 비교 표의 작업자별 프로바이더·모델(#95). 화면에 보이는 값에서만 보낼 값과 `변경` 표시를 낸다.

/** 사용자가 바꾼 작업자의 값. 바꾸지 않은 작업자는 비어 있다(Lead 제안). */
export type ChoiceDraft = readonly (ProviderChoice | undefined)[];

/**
 * 결정 폼의 작업자별 값. `shown`은 표의 값(바꾼 값, 없으면 Lead 제안, Lead 제안이 없는 예전 요청은 지금의 작업자 기본값)이고,
 * 아직 모르는 칸(기본값을 읽기 전)은 비어 있다. 승인은 모든 칸을 알 때만 할 수 있고(`ready`), 보내는 값은 언제나 `shown` 그대로다.
 * 바꾼 칸도 예전 요청도 없으면 보내지 않는다. 그때 서버는 같은 Lead 제안을 쓴다.
 */
export function decisionChoices(
  workers: readonly ProposedWorker[],
  draft: ChoiceDraft | undefined,
  workerDefault: ProviderChoice | undefined
): {
  shown: (ProviderChoice | undefined)[];
  ready: boolean;
  send: ProviderChoice[] | undefined;
} {
  const shown = workers.map((w, i) => draft?.[i] ?? w.choice ?? workerDefault);
  const known = shown.filter((c): c is ProviderChoice => c !== undefined);
  const ready = known.length === shown.length;
  const needsSend = !!draft || workers.some((w) => !w.choice);
  return { shown, ready, send: ready && needsSend ? known : undefined };
}

/** 결정 뒤 비교 표에서 `Lead 제안`과 `결정`이 다른 칸. 칸마다 그 칸의 값만 견준다. */
export const changedChoiceFields = (
  lead: ProviderChoice,
  decided: ProviderChoice
) => ({
  provider: lead.provider !== decided.provider,
  model: lead.model !== decided.model,
});
