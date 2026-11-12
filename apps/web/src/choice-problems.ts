import type { ProviderChoice, ProviderSummary } from "@babojubot/contracts";

// 프로바이더·모델 칸의 필드 오류. 서버가 저장을 거부할 값(`unknown_provider`·`unknown_model`, core/provider.ts
// `checkProviderChoices`와 같은 규칙)을 화면이 먼저 알아, 보내기 전에 어느 칸이 잘못됐는지 그 칸에 알린다.
// 통신·서버 오류는 여기서 다루지 않는다(폼 전체의 안내).

export type ChoiceProblem = "unknown_provider" | "unknown_model";

/**
 * 이 서버에 없는 연결이면 프로바이더 칸, 고른 연결의 목록에 없는 모델이면 모델 칸의 문제다. 서버처럼 목록이 비었으면(받아 오지
 * 못한 때 포함) 모델이 틀렸다고 단정하지 않는다.
 */
export function choiceProblem(
  providers: readonly ProviderSummary[],
  { provider, model }: ProviderChoice
): ChoiceProblem | undefined {
  const connection = providers.find((p) => p.id === provider);
  if (!connection) return "unknown_provider";
  if (
    model !== null &&
    connection.models.length > 0 &&
    !connection.models.some((m) => m.id === model)
  )
    return "unknown_model";
  return undefined;
}

/** `ProviderChoiceFields`가 그리는 두 칸의 DOM id. 문제 칸으로 포커스를 옮길 때도 이 id를 쓴다. */
export const choiceFieldIds = (idPrefix: string) => ({
  unknown_provider: `${idPrefix}-provider`,
  unknown_model: `${idPrefix}-model`,
});

/** 칸 순서대로 처음 문제가 있는 칸. */
export function firstChoiceProblem(
  providers: readonly ProviderSummary[],
  fields: { idPrefix: string; choice: ProviderChoice | undefined }[]
): { fieldId: string; problem: ChoiceProblem } | undefined {
  for (const { idPrefix, choice } of fields) {
    const problem = choice && choiceProblem(providers, choice);
    if (problem) return { fieldId: choiceFieldIds(idPrefix)[problem], problem };
  }
  return undefined;
}

/** 처음 문제가 있는 칸으로 포커스를 옮기고, 그런 칸이 있었는지 돌려준다. 제출할 때 부른다. */
export function focusFirstChoiceProblem(
  providers: readonly ProviderSummary[],
  fields: { idPrefix: string; choice: ProviderChoice | undefined }[]
) {
  const problem = firstChoiceProblem(providers, fields);
  if (problem) document.getElementById(problem.fieldId)?.focus();
  return problem !== undefined;
}

/** 서버가 저장 때 프로바이더·모델을 거부했다(그사이 목록이 바뀜). 목록을 다시 받아 칸의 오류로 보인다. */
export const isChoiceRefusal = (code: string | undefined) =>
  code === "unknown_provider" || code === "unknown_model";

export const choiceProblemText: Record<ChoiceProblem, string> = {
  unknown_provider: "이 서버에 없는 연결입니다. 다른 프로바이더를 고르세요.",
  unknown_model: "이 연결의 목록에 없는 모델입니다. 다른 모델을 고르세요.",
};
