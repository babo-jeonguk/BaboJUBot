import { modelOptionSchema, type ModelOption } from "@babojubot/contracts";
import { settingName } from "./process.ts";

/**
 * 제품에 담아 내는 Claude 모델 목록. 고르는 칸에 이 순서로 보이고, 고른 ID를 그대로 `--model`로 넘긴다.
 * Claude가 알려 주는 목록은 계열 별칭뿐이라 제품 판과 함께 갱신한다. 일부 계정만 쓰는 모델은 넣지 않는다.
 * 그런 모델이나 아직 담지 못한 새 모델은 `BABOJUBOT_<연결>_ADDITIONAL_MODELS`로 더한다.
 */
export const claudeModels: readonly ModelOption[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-sonnet-5[1m]", label: "Sonnet 5 1M" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

/**
 * 연결의 모델 목록. 내장 목록에 `BABOJUBOT_<연결>_ADDITIONAL_MODELS`(`[{"id":"…","label":"…"}]`)를 합친다.
 * 새 ID는 적은 순서대로 끝에 붙고, 같은 ID는 그 자리에서 바꾼다. 쓸 수 없는 값은 경고하고 건너뛰어 서버 시작을 막지 않는다.
 */
export function claudeModelsFor(id: string): ModelOption[] {
  const name = settingName(id, "ADDITIONAL_MODELS");
  const merged = [...claudeModels];
  const raw = process.env[name]?.trim();
  if (!raw) return merged;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    console.warn(`[providers] ${name} is not valid JSON; ignoring it`);
    return merged;
  }
  if (!Array.isArray(rows)) {
    console.warn(`[providers] ${name} must be a JSON array; ignoring it`);
    return merged;
  }
  rows.forEach((row: unknown, index) => {
    const model = modelOptionSchema.safeParse(row);
    if (!model.success) {
      console.warn(`[providers] ${name}: skipping unusable entry ${index}`);
      return;
    }
    const at = merged.findIndex((m) => m.id === model.data.id);
    if (at === -1) merged.push(model.data);
    else merged[at] = model.data;
  });
  return merged;
}
