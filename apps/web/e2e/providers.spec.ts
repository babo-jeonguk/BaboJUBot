import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
import { goalInput } from "./support/organization.ts";

// E2E 서버는 가짜 프로바이더 연결 둘(`fake`, `fake-2`)을 띄운다(playwright.config.ts `BABOJUBOT_FAKE_PROVIDERS`).
// 같은 서버를 쓰는 다음 spec이 처음 기본값을 보도록 끝나면 되돌린다.
const initialDefaults = {
  leadDefault: { provider: "fake", model: null },
  workerDefault: { provider: "fake", model: null },
};
test.afterEach(async ({ request }) => {
  await request.put("/api/providers/defaults", { data: initialDefaults });
  for (const provider of ["fake", "fake-2"])
    await request.put(`/api/providers/${provider}/limit`, {
      data: { maxConcurrentRuns: 2 },
    });
});

const providers = (p: Page) => p.getByRole("region", { name: "프로바이더" });
const select = (p: Page, name: string) =>
  providers(p).getByRole("combobox", { name, exact: true });

test("the owner sets the Lead and worker defaults and each connection's run cap, and another tab follows without a reload", async ({
  page,
  context,
}) => {
  await openWithLiveEvents(page, "/settings");
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(other, "/settings");
  const save = providers(page).getByRole("button", { name: "저장" });

  // 처음 기본값은 가짜 프로바이더·기본 모델이고, 바뀐 값이 없으면 저장할 수 없다.
  await expect(select(page, "Lead 기본 프로바이더")).toHaveValue("fake");
  await expect(
    select(page, "Lead 기본 모델").locator("option").first()
  ).toHaveText("기본 모델");
  await expect(select(page, "Lead 기본 모델")).toHaveValue("");
  await expect(save).toBeDisabled();

  // 프로바이더를 바꾸면 모델은 기본 모델로 돌아가고 그 연결의 모델만 고를 수 있다.
  await select(page, "작업자 기본 모델").selectOption({ label: "맥스" });
  await expect(select(page, "작업자 기본 모델")).toHaveValue("fake-max");
  await select(page, "작업자 기본 프로바이더").selectOption({
    label: "가짜 프로바이더 2",
  });
  await expect(select(page, "작업자 기본 모델")).toHaveValue("");
  await select(page, "작업자 기본 모델").selectOption({ label: "미니" });
  await expect(save).toBeEnabled();

  // 저장이 실패하면 고친 값은 초안으로 남는다.
  let failed = false;
  await page.route("**/api/providers/defaults", (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":{"code":"internal"}}',
    });
  });
  await save.click();
  await expect(providers(page).getByRole("alert")).toContainText(
    "저장하지 못했습니다"
  );
  await expect(select(page, "작업자 기본 프로바이더")).toHaveValue("fake-2");
  await expect(select(page, "작업자 기본 모델")).toHaveValue("fake-2-mini");
  await expect(select(other, "작업자 기본 프로바이더")).toHaveValue("fake");

  await save.click();
  await expect(save).toBeDisabled();
  await expect(select(other, "작업자 기본 프로바이더")).toHaveValue("fake-2");
  await expect(select(other, "작업자 기본 모델")).toHaveValue("fake-2-mini");

  // 동시 실행 상한은 기본 2이고 −·＋로 곧바로 바뀐다. 1 아래는 무제한(0)이며 거기서 −는 누를 수 없다.
  const cap = (p: Page) =>
    providers(p).getByRole("group", { name: "가짜 프로바이더 동시 실행 상한" });
  const value = (p: Page) =>
    cap(p).getByRole("textbox", { name: "가짜 프로바이더 동시 실행 상한" });
  const fewer = (p: Page) => cap(p).getByRole("button", { name: /줄이기$/ });
  const more = (p: Page) => cap(p).getByRole("button", { name: /늘리기$/ });
  await expect(value(page)).toHaveValue("2");
  await fewer(page).click();
  await expect(value(page)).toHaveValue("1");
  await fewer(page).click();
  await expect(value(page)).toHaveValue("무제한");
  await expect(fewer(page)).toBeDisabled();
  await expect(value(other)).toHaveValue("무제한");
  await more(page).click();
  await expect(value(page)).toHaveValue("1");
  // 숫자 칸에 적은 값은 Enter로 저장하고, 0 이상 정수가 아니면 되돌린다.
  await value(other).fill("5");
  await value(other).press("Enter");
  await expect(value(page)).toHaveValue("5");
  await value(other).fill("다섯");
  await value(other).press("Enter");
  await expect(value(other)).toHaveValue("5");
  // 다른 연결의 상한은 따로다.
  await expect(
    providers(page)
      .getByRole("group", { name: "가짜 프로바이더 2 동시 실행 상한" })
      .getByRole("textbox")
  ).toHaveValue("2");
});

test("the owner picks the Lead's provider when creating an organization and later changes it for the next run", async ({
  page,
  request,
}) => {
  await request.put("/api/providers/defaults", {
    data: {
      leadDefault: { provider: "fake-2", model: "fake-2-max" },
      workerDefault: { provider: "fake", model: null },
    },
  });
  await openWithLiveEvents(page, "/");
  const rail = page.getByRole("navigation", { name: "연구 조직" });
  await rail.getByRole("button", { name: "새 연구 조직" }).click();
  const dialog = page.getByRole("dialog", { name: "새 연구 조직" });
  const leadProvider = dialog.getByRole("combobox", {
    name: "Lead 프로바이더",
  });
  const leadModel = dialog.getByRole("combobox", { name: "Lead 모델" });

  // Lead 칸은 전역 Lead 기본값으로 채워져 있다.
  await expect(leadProvider).toHaveValue("fake-2");
  await expect(leadModel).toHaveValue("fake-2-max");
  await dialog.getByLabel("조직 이름").fill("프로바이더 E2E 조직");
  await dialog.getByLabel("연구 목표").fill(goalInput.goal);
  await leadProvider.selectOption({ label: "가짜 프로바이더" });
  await expect(leadModel).toHaveValue("");

  // 닫아도 입력은 초안으로 남는다.
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(dialog).toBeHidden();
  await rail.getByRole("button", { name: "새 연구 조직" }).click();
  await expect(dialog.getByLabel("조직 이름")).toHaveValue(
    "프로바이더 E2E 조직"
  );
  await expect(leadProvider).toHaveValue("fake");
  await leadModel.selectOption({ label: "맥스" });

  // 좁은 화면에서는 아래에 붙은 시트다(올라오는 움직임이 끝난 뒤의 자리).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box && [box.x, box.width, box.y + box.height].map(Math.round);
    })
    .toEqual([0, 390, 844]);
  await page.setViewportSize({ width: 1280, height: 720 });

  await dialog.getByRole("button", { name: "만들기" }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/chat$/);
  const orgId = page.url().match(/orgs\/([0-9a-f-]{36})/)![1]!;
  const org = (await (
    await request.get(`/api/organizations/${orgId}`)
  ).json()) as { agents: { id: string; role: string }[] };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;

  // 만든 Lead는 고른 프로바이더로 깨어났고, 실행 시도 목록 행에 프로바이더·모델이 보인다.
  await openWithLiveEvents(page, `/orgs/${orgId}/agents/${leadId}`);
  const recent = page.getByRole("region", { name: "최근 실행 시도" });
  await expect(recent.getByRole("listitem")).toHaveCount(1);
  await expect(recent.getByRole("listitem").first()).toContainText(
    "가짜 프로바이더 · 맥스"
  );
  await expect(select(page, "프로바이더")).toHaveValue("fake");
  await expect(select(page, "모델")).toHaveValue("fake-max");

  // 바꾸면 모델은 기본 모델로 돌아가고 확인 없이 저장된다. 이미 끝난 실행 시도의 행은 그대로이고 다음 실행 시도가 새 값이다.
  const save = providers(page).getByRole("button", { name: "저장" });
  await expect(save).toBeDisabled();
  await select(page, "프로바이더").selectOption({ label: "가짜 프로바이더 2" });
  await expect(select(page, "모델")).toHaveValue("");
  await save.click();
  await expect(save).toBeDisabled();
  const sent = await request.post(`/api/organizations/${orgId}/messages`, {
    data: { body: "다음 실행 시도" },
  });
  expect(sent.status()).toBe(201);
  await expect(recent.getByRole("listitem")).toHaveCount(2);
  await expect(recent.getByRole("listitem").first()).toContainText(
    "가짜 프로바이더 2 · 기본 모델"
  );
  await expect(recent.getByRole("listitem").last()).toContainText(
    "가짜 프로바이더 · 맥스"
  );
});
