import { createHash, randomBytes } from "node:crypto";

/**
 * 실행 시도별 토큰. 추측할 수 없는 임의 값이며 DB에는 digest만 남는다.
 * 유효성은 서명이나 만료 시각이 아니라 그 실행 시도가 지금 실행 중인지로 정하므로, 종료와 동시에 읽기까지 막힌다.
 */
export function issueRunToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: digestRunToken(token) };
}

export const digestRunToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
