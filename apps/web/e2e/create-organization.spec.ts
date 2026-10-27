import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

/** 화면을 열어 구독 성립을 기다린 뒤, 이후 화면 갱신이 새로고침 없이 일어났는지 확인할 표식을 심는다. */
async function openMarked(page: Page, path: string) {
  await openWithLiveEvents(page, path);
  await page.evaluate(
    () => ((window as unknown as { marker: number }).marker = 1)
  );
}
const notReloaded = (page: Page) =>
  page.evaluate(() => (window as unknown as { marker?: number }).marker === 1);

test("creating an organization with a goal opens its Lead chat, wakes the Lead and shows up everywhere without reload", async ({
  page,
  context,
}) => {
  const watcher = await context.newPage();
  await openMarked(watcher, "/");
  await openMarked(page, "/");

  // 조직 없음 빈 상태에서 dialog를 연다. 이름과 연구 목표가 있어야 만들 수 있고 완료 기준은 비워도 된다.
  await expect(page.getByText("아직 연구 조직이 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "＋ 새 연구 조직" }).click();
  const dialog = page.getByRole("dialog", { name: "새 연구 조직" });
  const create = dialog.getByRole("button", { name: "만들기" });
  await expect(create).toBeDisabled();
  await dialog.getByLabel("조직 이름").fill("  음성 인식 오류 분석 ");
  await expect(create).toBeDisabled();
  await dialog
    .getByLabel("연구 목표")
    .fill("한국어 음성 인식 오류율을\n절반으로 줄인다");
  await expect(dialog.getByLabel(/완료 기준/)).toHaveAttribute(
    "placeholder",
    "비워 두면 Lead가 제안합니다"
  );
  await dialog.getByLabel(/완료 기준/).fill("공개 평가셋 WER 10% 이하");
  await create.click();

  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/chat$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Research Lead", { exact: true })).toBeVisible();
  // Lead 대화로 목표를 보내지 않아도 생성으로 깨어난 Lead가 초기 연구 승인을 요청한다.
  await expect(
    page.getByRole("list", { name: "대화" }).locator('[data-author="agent"]')
  ).toContainText("초기 연구 승인을 요청했습니다");
  const rail = page.getByRole("navigation", { name: "연구 조직" });
  await expect(
    rail.getByRole("link", { name: "음성 인식 오류 분석 · 승인 대기" })
  ).toBeVisible();

  // 다른 탭의 홈과 사이드바는 Event stream으로 갱신된다. 초기 연구 승인 요청이 있어 홈의 주의 필요에 놓인다.
  await expect(
    watcher
      .getByRole("region", { name: "주의 필요" })
      .getByText("음성 인식 오류 분석")
  ).toBeVisible();
  await expect(
    watcher
      .getByRole("navigation", { name: "연구 조직" })
      .getByRole("link", { name: "음성 인식 오류 분석 · 승인 대기" })
  ).toBeVisible();

  // 사용자가 적은 목표와 완료 기준이 대시보드와 Event log에 사용자 입력으로 남는다.
  await page
    .getByRole("navigation", { name: "조직 화면" })
    .getByRole("link", { name: "대시보드" })
    .click();
  await expect(page.getByTestId("goal")).toHaveText(
    "한국어 음성 인식 오류율을\n절반으로 줄인다"
  );
  await expect(page.getByTestId("completion-criteria")).toHaveText(
    "공개 평가셋 WER 10% 이하"
  );

  await page
    .getByRole("navigation", { name: "조직 화면" })
    .getByRole("link", { name: "활동" })
    .click();
  await expect(page.getByRole("main")).toContainText(
    "사용자가 조직 “음성 인식 오류 분석”을 만들고 연구 목표를 정했습니다"
  );

  // 레일 ＋에서 두 번째 조직을 만든다. 완료 기준은 비워 둔다.
  await rail.getByRole("button", { name: "새 연구 조직" }).click();
  await dialog.getByLabel("조직 이름").fill("두 번째 연구");
  await dialog.getByLabel("연구 목표").fill("두 번째 목표");
  await create.click();
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
