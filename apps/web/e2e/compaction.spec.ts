import { expect } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
import { test } from "./support/shared-settings.ts";

test("compaction inputs keep intermediate text, clamp on blur and save with defaults at 390px", async ({
  page,
  request,
  sharedSettings,
}) => {
  // 시작 값을 정해 두고, 끝나면 fixture가 테스트 전 값으로 되돌린다.
  const { leadDefault, workerDefault } = sharedSettings.initial;
  const before = { thresholdTokens: 400000, ratio: 0.9 };
  const start = await request.put("/api/providers/defaults", {
    data: { leadDefault, workerDefault, compaction: before },
  });
  expect(start.status()).toBe(200);
  const storedCompaction = async () =>
    (await (await request.get("/api/providers")).json()).compaction;

  await page.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(page, "/settings");
  const form = page.getByRole("form", { name: "기본 프로바이더" });
  const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
  const ratio = form.getByRole("spinbutton", { name: "압축 시점" });
  const save = form.getByRole("button", { name: /^저장/ });
  const alert = form.getByRole("alert");
  await expect(threshold).toHaveValue("400000");
  await threshold.fill("4");
  await expect(threshold).toHaveValue("4");
  await threshold.blur();
  await expect(threshold).toHaveValue("50000");
  await ratio.fill("99");
  await ratio.blur();
  await expect(ratio).toHaveValue("95");

  // 통신이 끊겨 저장하지 못하면 안내가 뜨고, 고친 값은 초안으로 남으며 서버 값은 그대로다.
  await page.route(
    "**/api/providers/defaults",
    (route) => route.abort("failed"),
    { times: 1 }
  );
  await save.click();
  await expect(alert).toContainText("저장하지 못했습니다");
  await expect(save).toHaveText("저장");
  await expect(save).toBeEnabled();
  await expect(threshold).toHaveValue("50000");
  expect(await storedCompaction()).toEqual(before);

  // 저장하는 동안은 `저장하는 중…`이고 서버에도 아직 저장되지 않았다. 이때는 새로고침하지 않는다.
  const held = await sharedSettings.holdWrite(
    page,
    "**/api/providers/defaults"
  );
  await save.click();
  await held.arrived();
  await expect(save).toHaveText("저장하는 중…");
  await expect(save).toBeDisabled();
  expect(await storedCompaction()).toEqual(before);

  // 서버가 저장값을 담아 성공으로 답하고 화면이 그 값을 받아들인 뒤에 새로고침한다.
  const saved = await held.release();
  expect(saved.status()).toBe(200);
  expect((await saved.json()).compaction).toEqual({
    thresholdTokens: 50000,
    ratio: 0.95,
  });
  await expect(save).toHaveText("저장");
  await expect(save).toBeDisabled();
  await expect(alert).toHaveCount(0);
  await page.reload();
  await expect(threshold).toHaveValue("50000");
  await expect(ratio).toHaveValue("95");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/babojubot-compaction-390.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/babojubot-compaction-1280.png",
    fullPage: true,
  });
});
