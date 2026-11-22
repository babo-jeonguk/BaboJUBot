import { describe, expect, test } from "vitest";
import { sectionOfPath } from "./shell.tsx";

describe("sectionOfPath", () => {
  test("puts a detail path under the section it belongs to and keeps other segments as they are", () => {
    expect(sectionOfPath("runs")).toBe("agents");
    expect(sectionOfPath("results")).toBe("review");
    expect(sectionOfPath("dashboard")).toBe("dashboard");
  });

  // 주소는 사용자가 적는다. 모든 객체가 물려받는 이름(constructor·toString)도 그냥 모르는 섹션이다(#281 리뷰 REC-1과 같은 모양).
  test.each(["constructor", "toString", "__proto__"])(
    "keeps the inherited name %s as an unknown section",
    (segment) => {
      expect(sectionOfPath(segment)).toBe(segment);
    }
  );
});
