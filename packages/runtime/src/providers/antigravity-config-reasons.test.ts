import { expect, it } from "vitest";
import { readCleanupReasons } from "./antigravity-config.ts";
import { cleanupReasons } from "./antigravity-config-reasons.ts";

// 정리 스크립트가 낼 수 있는 까닭은 한 목록에서 나온다. 서버는 그 목록의 모든 까닭을 그대로 읽는다. 목록이 비면 실패한다
// (#286 리뷰 2회차 STD-3).
it("reads back every reason the cleanup script can send, from the one shared list", () => {
  expect(cleanupReasons.length).toBeGreaterThan(0);
  const lines = cleanupReasons
    .map((reason) => JSON.stringify({ reason, name: `${reason}.json` }))
    .join("\n");
  expect(readCleanupReasons(`${lines}\n`)).toEqual(
    cleanupReasons.map((reason) => ({ reason, name: `${reason}.json` }))
  );
});
