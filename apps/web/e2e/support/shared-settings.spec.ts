import { expect } from "@playwright/test";
import { openWithLiveEvents } from "./live-events.ts";
import { test, type SharedSettings } from "./shared-settings.ts";

// 앞 테스트가 저장 도중 실패해도 fixture가 시작 전 값으로 되돌렸는지 다음 테스트가 확인한다.
test.describe.configure({ mode: "serial" });

let before: SharedSettings["initial"] | undefined;

test("a test that fails while a settings save is held still hands back the settings it started with", async ({
  page,
  request,
  sharedSettings,
}) => {
  test.fail(true, "중간 단언 실패를 일부러 만든다");
  before = sharedSettings.initial;
  // API로 바꾼 값(기본값·압축·격리 실행·상한)과 화면에서 붙잡힌 저장이 모두 남은 채로 실패한다.
  const changed = await request.put("/api/providers/defaults", {
    data: {
      leadDefault: { provider: "fake-2", model: "fake-2-max" },
      workerDefault: { provider: "fake-2", model: null },
      compaction: { thresholdTokens: 300000, ratio: 0.8 },
    },
  });
  expect(changed.status()).toBe(200);
  expect(
    (
      await request.put("/api/providers/isolation", {
        data: { isolated: !before.isolated },
      })
    ).status()
  ).toBe(200);
  expect(
    (
      await request.put("/api/providers/fake/limit", {
        data: { maxConcurrentRuns: 7 },
      })
    ).status()
  ).toBe(200);

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
  expect("저장 도중 실패").toBe("저장 확정");
});

test("the next test sees the settings from before the failed test, without the held save", async ({
  request,
}) => {
  expect(before, "앞 테스트가 시작 전 값을 남겼다").toBeDefined();
  const settings = await (await request.get("/api/providers")).json();
  expect({
    leadDefault: settings.leadDefault,
    workerDefault: settings.workerDefault,
    compaction: settings.compaction,
    isolated: settings.isolated,
    limits: Object.fromEntries(
      settings.providers.map((p: { id: string; maxConcurrentRuns: number }) => [
        p.id,
        p.maxConcurrentRuns,
      ])
    ),
  }).toEqual(before);
});
