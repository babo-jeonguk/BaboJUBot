import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

/**
 * API로 조직을 만든다. 다른 spec이 남긴 조직이 있으므로 화면 확인은 이 조직들로 좁힌다.
 * 조직을 만들면 가짜 Lead가 깨어나 곧바로 초기 연구 승인을 요청한다.
 */
async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, goal: `${name} 목표`, completionCriteria: "근거 메모" },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${id}${path}`;
  return { id, name, api };
}
type Org = Awaited<ReturnType<typeof createOrganization>>;

/** 생성으로 깨어난 가짜 Lead의 초기 연구 승인 요청(주의 필요)을 받고, 그 실행 시도가 끝날 때까지 기다린다. */
async function awaitingApproval(page: Page, org: Org) {
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(org.api("/approvals"));
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    }, runs)
    .not.toBe("");
  await expect
    .poll(async () => {
      const res = await page.request.get(org.api("/runs?status=running"));
      return ((await res.json()) as unknown[]).length;
    }, runs)
    .toBe(0);
  return approvalId;
}

test("the home puts organizations that need the owner first, the rest in progress and closed ones folded away, and follows changes live", async ({
  page,
}) => {
  // 진행 중 조직은 초기 연구 승인을 받아 주의 필요가 없다.
  const idle = await createOrganization(page, "홈 E2E 진행 조직");
  const idleApproval = await awaitingApproval(page, idle);
  expect(
    (
      await page.request.post(idle.api(`/approvals/${idleApproval}/decision`), {
        data: { decision: "approve" },
      })
    ).ok()
  ).toBe(true);
  const older = await createOrganization(page, "홈 E2E 먼저 승인 요청");
  await awaitingApproval(page, older);
  const newer = await createOrganization(page, "홈 E2E 나중 승인 요청");
  const newerApproval = await awaitingApproval(page, newer);
  const closed = await createOrganization(page, "홈 E2E 중단 조직");
  expect(
    (await page.request.post(closed.api("/stop"), { data: {} })).ok()
  ).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithLiveEvents(page, "/");
  const main = page.getByRole("main");
  const attention = main.getByRole("region", { name: "주의 필요" });
  const progress = main.getByRole("region", { name: "진행 중" });
  const card = (scope: typeof main, org: Org) =>
    scope.locator(`a[data-org-id="${org.id}"]`);

  // 주의 필요: 승인 요청을 받은 조직. 주의 수가 같으면 최근 활동이 먼저다.
  await expect(card(attention, newer)).toBeVisible();
  await expect(
    card(attention, newer).getByTestId("organization-attention")
  ).toHaveText("주의 1");
  await expect(card(attention, newer)).toContainText("승인 대기");
  await expect(card(attention, newer)).toContainText(`${newer.name} 목표`);
  const ids = await attention
    .locator("a[data-org-id]")
    .evaluateAll((as) => as.map((a) => a.getAttribute("data-org-id")));
  expect(ids.indexOf(newer.id)).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

  // 진행 중: 주의가 없는 끝나지 않은 조직. 단계와 마지막 활동 시각을 보인다.
  await expect(card(attention, idle)).toHaveCount(0);
  await expect(card(progress, idle)).toContainText("연구 진행", runs);
  await expect(
    card(progress, idle).getByTestId("organization-last-activity")
  ).toHaveText(/방금|분 전/);
  await expect(
    card(progress, idle).getByTestId("organization-attention")
  ).toHaveCount(0);

  // 끝난 조직은 접혀 있어 진행 중 조직 사이에 끼지 않는다. 펼치면 보인다.
  await expect(card(progress, closed)).toHaveCount(0);
  await expect(card(attention, closed)).toHaveCount(0);
  const closedList = main.getByRole("list", { name: "끝난 조직" });
  await expect(card(main, closed)).toBeHidden();
  const closedToggle = main.locator("summary", { hasText: "끝난 조직" });
  await expect(
    closedToggle.getByTestId("closed-organization-count")
  ).toHaveText(/^[1-9]\d*$/);
  await closedToggle.click();
  await expect(card(closedList, closed)).toContainText("중단됨");

  // 주의 필요 수는 Inbox를 연다.
  await main.getByRole("button", { name: /^주의 필요 \d+개/ }).click();
  await expect(
    page.getByRole("complementary", { name: "Inbox" })
  ).toBeVisible();

  // 승인하면 새로고침 없이 주의 필요에서 진행 중으로 옮겨 간다.
  expect(
    (
      await page.request.post(
        newer.api(`/approvals/${newerApproval}/decision`),
        { data: { decision: "approve" } }
      )
    ).ok()
  ).toBe(true);
  await expect(card(attention, newer)).toHaveCount(0, runs);
  await expect(card(progress, newer)).toContainText("연구 진행", runs);

  // 390px에서도 가로로 넘치지 않는다.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card(attention, older)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
