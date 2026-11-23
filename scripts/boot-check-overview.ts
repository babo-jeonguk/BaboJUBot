// 부팅 확인(scripts/boot-check.mjs)이 서버가 준비됐다고 볼 `/api/overview` 응답을 판정한다.
import { orIfUnreadable } from "@babojubot/contracts";

const notJson = Symbol("not JSON");

/**
 * HTTP 200의 `/api/overview` 본문(글)을 판정하고 개요 필드 수를 돌려준다. JSON으로 읽히지 않으면 아직 답이 없는 것으로 보고
 * undefined를 돌려준다(부르는 쪽이 다시 묻는다). 준비된 서버의 답이 아니면 단계 이름과 이유로 던진다.
 */
export function overviewFields(
  label: string,
  text: string
): number | undefined {
  const body: unknown = orIfUnreadable(
    (): unknown => JSON.parse(text),
    notJson
  );
  if (body === notJson) return undefined;
  // 답은 화면이 읽는 개요 객체다. 다른 JSON 값(null, 숫자, 문자열)이면 서버가 준비된 것이 아니다.
  if (typeof body !== "object" || body === null)
    throw new Error(
      `${label}: /api/overview answered ${JSON.stringify(body)}, not an object`
    );
  return Object.keys(body).length;
}
