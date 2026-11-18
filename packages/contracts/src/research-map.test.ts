import { expect, it } from "vitest";
import {
  researchNodeStatuses,
  researchNodeWorkStatuses,
  researchNodeWorkStatusSchema,
} from "./research-map.ts";

// 편집 화면의 상태 선택지가 이 순서로 보인다.
it("offers every research node status except discarded, in the same order", () => {
  expect(researchNodeStatuses).toEqual([
    "proposed",
    "in_progress",
    "done",
    "rejected",
    "discarded",
  ]);
  expect(researchNodeWorkStatuses).toEqual([
    "proposed",
    "in_progress",
    "done",
    "rejected",
  ]);
  expect(researchNodeWorkStatusSchema.safeParse("discarded").success).toBe(
    false
  );
});
