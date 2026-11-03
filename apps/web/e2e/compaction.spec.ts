import { expect, test } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
test("compaction inputs keep intermediate text, clamp on blur and save with defaults at 390px", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(page, "/settings");
  const threshold = page.getByRole("spinbutton", { name: "압축 기준" });
  const ratio = page.getByRole("spinbutton", { name: "압축 시점" });
  await expect(threshold).toHaveValue("400000");
  await threshold.fill("4");
  await expect(threshold).toHaveValue("4");
  await threshold.blur();
  await expect(threshold).toHaveValue("50000");
  await ratio.fill("99");
  await ratio.blur();
  await expect(ratio).toHaveValue("95");
  await page.getByRole("button", { name: "저장", exact: true }).click();
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
  const settings = await (await request.get("/api/providers")).json();
  await request.put("/api/providers/defaults", {
    data: {
      leadDefault: settings.leadDefault,
      workerDefault: settings.workerDefault,
      compaction: { thresholdTokens: 400000, ratio: 0.9 },
    },
  });
});
