/** JSON에서 읽은 값을 필드 모음으로 본다. 객체가 아니면 빈 모음이라 어느 필드도 없다. */
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
