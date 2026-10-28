import { z } from "zod";

// 에이전트 이름과 얼굴(GLOSSARY): 사용자가 고치는 표시 정보다. 실행 시도의 지침·권한과 상관없고, 조직 안에서만 의미가 있다.

/** 에이전트 이름의 최대 글자 수. 조직 그래프 카드·대화 머리에 한 줄로 들어간다. */
export const agentNameMaxLength = 40;
/**
 * 에이전트 이름. 앞뒤 공백을 지우고 비어 있지 않아야 하며 줄바꿈 같은 제어 문자를 받지 않는다.
 * 같은 조직 안에서 대소문자만 다른 이름도 겹치는 이름이다(Lead가 이름으로 팀원을 가리키므로, db `updateAgentProfile`).
 */
export const agentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(agentNameMaxLength)
  .regex(/^[^\p{Cc}]*$/u);

/** 얼굴 색 프리셋. 실제 색은 대시보드가 정한다. */
export const faceColors = [
  "sky",
  "mint",
  "peach",
  "lilac",
  "lemon",
  "rose",
  "sand",
  "slate",
] as const;
export const faceEyes = ["round", "dot", "oval", "sparkle"] as const;
export const faceMouths = ["smile", "grin", "flat", "small"] as const;
export const faceAccessories = [
  "none",
  "glasses",
  "antenna",
  "headphones",
  "sprout",
] as const;

/** 에이전트 얼굴: 프리셋 조합. 사용자가 고르지 않은 에이전트는 ID에서 정한 기본 얼굴이다(`defaultAgentAppearance`). */
export const agentAppearanceSchema = z.strictObject({
  color: z.enum(faceColors),
  eyes: z.enum(faceEyes),
  mouth: z.enum(faceMouths),
  accessory: z.enum(faceAccessories),
});
export type AgentAppearance = z.infer<typeof agentAppearanceSchema>;

const defaultAccessoryOdds = [
  ...faceAccessories,
  "none",
  "none",
  "none",
] as const;

/**
 * ID에서 정하는 기본 얼굴. 같은 ID는 언제나 같은 얼굴이라 저장하지 않아도 되며, 항목마다 다른 해시 조각을 써서
 * 같은 조직의 에이전트끼리 서로 달라 보이게 한다. 기본 얼굴의 액세서리는 절반쯤 없다.
 */
export function defaultAgentAppearance(id: string): AgentAppearance {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const pick = <T>(options: readonly T[], shift: number) =>
    options[(hash >>> shift) % options.length]!;
  return {
    color: pick(faceColors, 0),
    eyes: pick(faceEyes, 6),
    mouth: pick(faceMouths, 12),
    accessory: pick(defaultAccessoryOdds, 18),
  };
}

/**
 * 사용자의 에이전트 이름·얼굴 변경. 바꿀 항목만 보낸다.
 * 같은 조직의 다른 에이전트와 겹치는 이름은 409 `name_taken`이다.
 */
export const updateAgentProfileInputSchema = z
  .strictObject({
    name: agentNameSchema.optional(),
    appearance: agentAppearanceSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.appearance !== undefined, {
    message: "name 또는 appearance 중 하나는 있어야 합니다",
  });
export type UpdateAgentProfileInput = z.infer<
  typeof updateAgentProfileInputSchema
>;
