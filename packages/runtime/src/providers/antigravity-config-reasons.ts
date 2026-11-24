/** 옛 Antigravity 설정 정리 스크립트(`antigravity-config-clear.ts`)가 표준 오류로 보내는 까닭. 스크립트와 서버(`antigravity-config.ts`)가 이 한 목록에서 타입과 해석을 끌어온다. */
export const cleanupReasons = [
  "not_checkable",
  "unmarked",
  "not_regular",
  "changed",
  "restored",
  "kept_aside",
  "handle_not_closed",
] as const;
export type ScriptCleanupReason = (typeof cleanupReasons)[number];
