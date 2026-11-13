import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./live-events.ts";
import {
  readSettings,
  test,
  type SharedSettings,
  type Snapshot,
} from "./shared-settings.ts";

// 앞 테스트가 전역 설정을 바꾸고 화면의 저장을 붙잡은 채 끝나도 fixture가 시작 전 값으로 되돌렸는지 다음 테스트가 확인한다.
// 정리는 테스트 결과와 상관없이 같은 길로 돈다. 그래서 정리 자체의 실패(멈춘 route callback, 되돌리기 실패)는 정상 종료 경우에서
// 드러나게 하고, 중간 단언 실패 경우는 test.fail로 따로 둔다(test.fail은 정리의 실패도 기대한 실패로 삼키므로 이것만으로는 부족하다).
test.describe.configure({ mode: "serial" });

let before: Snapshot | undefined;

/** API로 전역 설정을 바꾸고, 화면에서 압축 기준 저장을 붙잡은 채 화면을 다시 연다. 붙잡은 저장은 서버에 가지 않았다. */
async function leaveSettingsMidSave(
  page: Page,
  request: APIRequestContext,
  sharedSettings: SharedSettings
) {
  before = sharedSettings.initial;
  const changes: [string, unknown][] = [
    [
      "/api/providers/defaults",
      {
        leadDefault: { provider: "fake-2", model: "fake-2-max" },
        workerDefault: { provider: "fake-2", model: null },
        compaction: { thresholdTokens: 300000, ratio: 0.8 },
      },
    ],
    ["/api/providers/isolation", { isolated: !before.isolated }],
    ["/api/providers/fake/limit", { maxConcurrentRuns: 7 }],
  ];
  for (const [path, data] of changes)
    expect((await request.put(path, { data })).status()).toBe(200);

  await openWithLiveEvents(page, "/settings");
  const form = page.getByRole("form", { name: "기본 프로바이더" });
  const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
  await expect(threshold).toHaveValue("300000");
  await threshold.fill("600000");
  await threshold.blur();
  const held = await sharedSettings.holdWrite(
    page,
    "**/api/providers/defaults"
  );
  await form.getByRole("button", { name: /^저장/ }).click();
  await held.arrived();
  // 붙잡힌 저장이 있는 채로 화면을 다시 열어도 정리는 멈추지 않는다.
  await page.reload();
  await expect(threshold).toHaveValue("300000");
}

async function expectSettingsFromBefore(request: APIRequestContext) {
  expect(before, "앞 테스트가 시작 전 값을 남겼다").toBeDefined();
  expect(await readSettings(request)).toEqual(before);
  before = undefined;
}

test("a test that ends while a settings save is held cleans up without errors", async ({
  page,
  request,
  sharedSettings,
}) => {
  await leaveSettingsMidSave(page, request, sharedSettings);
});

test("after a test that ended mid-save, the settings are the ones from before it", async ({
  request,
}) => {
  await expectSettingsFromBefore(request);
});

test("a test that fails while a settings save is held still hands back the settings it started with", async ({
  page,
  request,
  sharedSettings,
}) => {
  test.fail(true, "중간 단언 실패를 일부러 만든다");
  await leaveSettingsMidSave(page, request, sharedSettings);
  expect("저장 도중 실패").toBe("저장 확정");
});

test("after a test that failed mid-save, the settings are the ones from before it", async ({
  request,
}) => {
  await expectSettingsFromBefore(request);
});
