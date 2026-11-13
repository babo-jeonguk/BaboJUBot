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

// 서버로 보낸 저장의 응답을 기다리지 않고 끝난 테스트(응답 대기 시한을 넘긴 경우와 같다). 정리는 그 저장이 끝난 뒤에 되돌려야
// 늦게 끝난 저장이 되돌린 값을 덮지 않는다. 느린 서버는 route가 1초 뒤 page와 상관없는 연결로 같은 PUT을 보내 흉내 낸다.
let lateWrite: Promise<unknown> | undefined;

test("a test that ends while a released settings save is still on its way restores after that save", async ({
  page,
  playwright,
  baseURL,
  sharedSettings,
}) => {
  before = sharedSettings.initial;
  expect(before.compaction?.thresholdTokens).not.toBe(600000);
  const slowServer = await playwright.request.newContext({ baseURL });
  await openWithLiveEvents(page, "/settings");
  const form = page.getByRole("form", { name: "기본 프로바이더" });
  const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
  await threshold.fill("600000");
  await threshold.blur();
  // 나중에 등록한 route가 먼저 돈다. 붙잡은 요청을 보내면 아래 느린 서버로 넘어간다. 이 route를 테스트 내내 두는 것은
  // page의 route가 모두 없어지면 붙잡혀 있던 요청이 곧바로 서버로 가기 때문이다(정리가 문 route를 떼어도 느린 서버는 남는다).
  let slowed = false;
  await page.route("**/api/providers/defaults", async (route) => {
    if (slowed || route.request().method() !== "PUT") return route.fallback();
    slowed = true;
    const sent = new Promise((resolve) => setTimeout(resolve, 1000)).then(() =>
      slowServer.put(route.request().url(), {
        data: route.request().postDataJSON(),
      })
    );
    lateWrite = sent.finally(() => slowServer.dispose());
    // 정리가 이 저장을 기다리지 않으면 page가 먼저 닫혀 응답을 넘길 곳이 없다.
    await route.fulfill({ response: await sent }).catch(() => {});
  });
  const held = await sharedSettings.holdWrite(
    page,
    "**/api/providers/defaults"
  );
  await form.getByRole("button", { name: /^저장/ }).click();
  await held.arrived();
  held.release().catch(() => {});
});

test("after a test that ended with a save on its way, the settings are the ones from before it", async ({
  request,
}) => {
  expect(lateWrite, "앞 테스트가 저장을 보냈다").toBeDefined();
  await lateWrite;
  await expectSettingsFromBefore(request);
});
