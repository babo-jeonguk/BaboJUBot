// 부팅 확인(scripts/boot-check.mjs)이 서버가 준비됐다고 볼 `/api/overview` 응답을 판정한다. 대시보드가 같은 응답을 읽는 계약
// (overviewSchema, apps/web/src/api.ts)으로 보아, 대시보드가 거부할 서버를 준비됐다고 하지 않는다.
import { orIfUnreadable, overviewSchema } from "@babojubot/contracts";

const notJson = Symbol("not JSON");

/**
 * HTTP 200의 `/api/overview` 본문(글)을 판정하고 개요 필드 수를 돌려준다. 200은 서버가 답한 것이므로, JSON이 아니거나 개요
 * 계약을 어긴 본문은 다시 묻지 않고 단계 이름과 이유로 던진다.
 */
export function overviewFields(label: string, text: string): number {
  const body: unknown = orIfUnreadable(
    (): unknown => JSON.parse(text),
    notJson
  );
  if (body === notJson)
    throw new Error(
      `${label}: /api/overview answered a body that is not JSON: ${text.slice(0, 200)}`
    );
  const parsed = overviewSchema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      `${label}: /api/overview answered ${JSON.stringify(body).slice(0, 200)} that breaks the overview contract: ${parsed.error.message}`
    );
  return Object.keys(parsed.data).length;
}
