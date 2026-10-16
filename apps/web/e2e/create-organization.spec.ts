import { expect, test, type Page } from "@playwright/test";

/** 전체 조직 Event stream 구독이 성립할 때까지 기다린다. */
async function openWithLiveEvents(page: Page, path: string) {
  const ready = new Promise<void>((resolve) =>
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/api/events")) return;
      ws.on(
        "framereceived",
        (f) => String(f.payload).includes('"ready"') && resolve()
      );
    })
  );
  await page.goto(path);
  await ready;
  // 이후 화면 갱신이 새로고침 없이 일어났는지 확인하는 표식.
  await page.evaluate(
    () => ((window as unknown as { marker: number }).marker = 1)
  );
}
const notReloaded = (page: Page) =>
  page.evaluate(() => (window as unknown as { marker?: number }).marker === 1);

test("creating an organization opens its Lead chat and shows up everywhere without reload", async ({
  page,
  context,
}) => {
  const watcher = await context.newPage();
  await openWithLiveEvents(watcher, "/");
  await openWithLiveEvents(page, "/");

  // 조직 없음 빈 상태에서 dialog를 연다.
  await expect(page.getByText("아직 연구 조직이 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "＋ 새 연구 조직" }).click();
  const dialog = page.getByRole("dialog", { name: "새 연구 조직" });
  await expect(
    dialog.getByRole("button", { name: "만들고 Lead 대화로" })
  ).toBeDisabled();
  await dialog.getByLabel("조직 이름").fill("  음성 인식 오류 분석 ");
  await dialog.getByRole("button", { name: "만들고 Lead 대화로" }).click();

  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/chat$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("lead-chat-empty")).toContainText(
    "연구 목표와 완료 기준을 정하세요"
  );
  await expect(page.getByText("Research Lead", { exact: true })).toBeVisible();
  const rail = page.getByRole("navigation", { name: "연구 조직" });
  await expect(
    rail.getByRole("link", { name: "음성 인식 오류 분석 · 목표 설정" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "조직 화면" }).getByText("목표 설정")
  ).toBeVisible();

  // 다른 탭의 홈과 사이드바는 Event stream으로 갱신된다.
  await expect(
    watcher
      .getByRole("region", { name: "목표 설정" })
      .getByText("음성 인식 오류 분석")
  ).toBeVisible();
  await expect(
    watcher
      .getByRole("navigation", { name: "연구 조직" })
      .getByRole("link", { name: "음성 인식 오류 분석 · 목표 설정" })
  ).toBeVisible();

  // 레일 ＋에서 두 번째 조직을 만든다.
  await rail.getByRole("button", { name: "새 연구 조직" }).click();
  await dialog.getByLabel("조직 이름").fill("두 번째 연구");
  await dialog.getByRole("button", { name: "만들고 Lead 대화로" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "조직 화면" })
      .getByText("두 번째 연구")
  ).toBeVisible();
  await expect(page).toHaveURL(/\/chat$/);

  await rail.getByRole("link", { name: /홈/ }).click();
  await expect(page.getByTestId("organization-count")).toHaveText("2");
  await expect(watcher.getByTestId("organization-count")).toHaveText("2");

  expect(await notReloaded(page)).toBe(true);
  expect(await notReloaded(watcher)).toBe(true);
});
