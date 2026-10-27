import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

test("the owner turns an agent's heartbeat on, changes its interval, sees the next heartbeat in another tab, and turns it off", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "heartbeat E2E 조직" },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const path = `/orgs/${org.id}/agents/${leadId}`;
  await openWithLiveEvents(page, path);
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(other, path);

  const section = (p: Page) => p.getByRole("region", { name: "Heartbeat" });
  const toggle = (p: Page) =>
    section(p).getByRole("checkbox", { name: "heartbeat 켜기" });
  const interval = (p: Page) =>
    section(p).getByRole("spinbutton", { name: "간격(분)" });
  const save = (p: Page) => section(p).getByRole("button", { name: "저장" });
  const status = (p: Page) => section(p).getByRole("status");

  // 새 에이전트는 꺼져 있고 간격은 Role 기본값이다.
  await expect(status(page)).toHaveText("꺼짐");
  await expect(interval(page)).toHaveValue("60");
  await expect(save(page)).toBeDisabled();

  // 계약 밖의 간격은 저장할 수 없고 무엇이 틀렸는지 보인다.
  await toggle(page).check();
  await interval(page).fill("0");
  await expect(save(page)).toBeDisabled();
  await expect(interval(page)).toHaveAttribute("aria-invalid", "true");
  await expect(section(page)).toContainText("1~10080분");

  // 저장이 실패하면 입력은 그대로이고 저장된 설정을 알린다.
  await interval(page).fill("15");
  let failed = false;
  await page.route("**/agents/*/heartbeat", (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":{"code":"internal"}}',
    });
  });
  await save(page).click();
  await expect(section(page).getByRole("alert")).toContainText(
    "저장하지 못했습니다"
  );
  await expect(toggle(page)).toBeChecked();
  await expect(interval(page)).toHaveValue("15");
  await expect(status(page)).toHaveText("꺼짐");

  await save(page).click();
  for (const p of [page, other]) {
    await expect(status(p)).toContainText("분마다");
    await expect(status(p)).toContainText("15분마다");
    await expect(toggle(p)).toBeChecked();
    await expect(interval(p)).toHaveValue("15");
  }
  await expect(section(page).getByRole("alert")).toHaveCount(0);
  const saved = await page.request.get(
    `/api/organizations/${org.id}/agents/${leadId}`
  );
  const nextAt = ((await saved.json()) as { heartbeat: { nextAt: string } })
    .heartbeat.nextAt;
  const minutesAhead = (Date.parse(nextAt) - Date.now()) / 60_000;
  expect(minutesAhead).toBeGreaterThan(13);
  expect(minutesAhead).toBeLessThanOrEqual(15);

  // 좁은 화면의 다른 탭에서도 고치고 저장할 수 있다.
  await interval(other).fill("45");
  await save(other).scrollIntoViewIfNeeded();
  await save(other).click();
  await expect(status(page)).toContainText("45분마다");

  // 에이전트를 일시정지하면 예정은 남지만 깨우지 않는다고 보인다.
  await page
    .getByRole("region", { name: "에이전트 제어" })
    .getByRole("button", { name: /에이전트 일시정지/ })
    .click();
  await expect(status(other)).toContainText("일시정지 중");
  await page
    .getByRole("region", { name: "에이전트 제어" })
    .getByRole("button", { name: /에이전트 재개/ })
    .click();

  await toggle(other).uncheck();
  await save(other).click();
  for (const p of [page, other]) await expect(status(p)).toHaveText("꺼짐");
});
