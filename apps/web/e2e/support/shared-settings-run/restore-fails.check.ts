import { expect } from "@playwright/test";
import { readSettings } from "../shared-settings.ts";
import { test } from "./fixture.ts";

// 격리 실행과 연결별 상한을 바꾸고 끝나는데, 정리의 기본값 되돌리기 PUT이 실패한다(fixture.ts `failingPut`). 정리는 그 실패를
// 남기면서도 격리 실행과 상한을 되돌려야 한다. 바깥 시험이 실패 문구와 정리 뒤 설정을 본다. 기본값은 바꾸지 않으므로 그 되돌리기가
// 실패해도 시작 전 값 그대로다.
test.use({ failingPut: "/api/providers/defaults" });

test("ends after changing settings whose defaults cannot be restored", async ({
  request,
  sharedSettings,
}) => {
  for (const [path, data] of [
    [
      "/api/providers/isolation",
      { isolated: !sharedSettings.initial.isolated },
    ],
    ["/api/providers/fake/limit", { maxConcurrentRuns: 7 }],
  ] as const)
    expect((await request.put(path, { data })).status()).toBe(200);
  expect(await readSettings(request), "바꾼 전역 설정").toMatchObject({
    isolated: !sharedSettings.initial.isolated,
    limits: { fake: 7 },
  });
});
