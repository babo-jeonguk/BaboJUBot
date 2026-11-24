import { expect, it } from "vitest";
import { describeCleanup, readCleanupReasons } from "./antigravity-config.ts";
import { cleanupReasons } from "./antigravity-config-reasons.ts";

const everyReason = () =>
  cleanupReasons
    .map((reason) => JSON.stringify({ reason, name: `${reason}.json` }))
    .join("\n");

// 정리 스크립트가 낼 수 있는 까닭은 한 목록에서 나온다. 서버는 그 목록의 모든 까닭을 그대로 읽는다. 목록이 비면 실패한다
// (#286 리뷰 2회차 STD-3).
it("reads back every reason the cleanup script can send, from the one shared list", () => {
  expect(cleanupReasons.length).toBeGreaterThan(0);
  expect(readCleanupReasons(`${everyReason()}\n`, false)).toEqual(
    cleanupReasons.map((reason) => ({ reason, name: `${reason}.json` }))
  );
});

// 지우지 못했다고 끝났는데 까닭이 없으면 까닭을 모르는 것이다. 빈 목록으로 넘기지 않고 그 상태를 알린다(#286 병합분 항목 13).
it("says the cleanup script gave no reason when it ended unable to clear but wrote none", () => {
  const reasons = readCleanupReasons("", false);
  expect(reasons).toEqual([{ reason: "missing_output", name: "" }]);
  expect(describeCleanup(reasons)).toBe("no reasons given");
});

// 출력이 수집 상한에 닿았으면 그 뒤의 까닭은 버려졌다. 읽은 까닭만으로 넘기지 않고 잘렸다고 함께 알린다(#286 병합분 항목 13).
it("says the reasons were cut off when the cleanup script's output reached its limit", () => {
  const reasons = readCleanupReasons(`${everyReason()}\n`, true);
  expect(reasons).toEqual([
    ...cleanupReasons.map((reason) => ({ reason, name: `${reason}.json` })),
    { reason: "truncated_output", name: "" },
  ]);
  expect(describeCleanup([{ reason: "truncated_output", name: "" }])).toBe(
    "reasons cut off"
  );
});
