import { expect, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
import { goalInput } from "./support/organization.ts";
import { test } from "./support/shared-settings.ts";

// E2E 서버는 가짜 프로바이더 연결 둘(`fake`, `fake-2`)을 띄운다(playwright.config.ts `BABOJUBOT_FAKE_PROVIDERS`).
// 같은 서버를 쓰는 다른 spec이 영향받지 않도록 전역 설정은 테스트가 끝나면(실패해도) 시작 전 값으로 되돌린다(support/shared-settings.ts).

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
  sharedSettings,
}) => {
  const defaults = await request.put("/api/providers/defaults", {
    data: {
      leadDefault: { provider: "fake-2", model: "fake-2-max" },
      workerDefault: { provider: "fake", model: null },
    },
  });
  expect(defaults.status()).toBe(200);
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
  const save = providers(page).getByRole("button", { name: /^저장/ });
  const alert = providers(page).getByRole("alert");
  const stored = async () => {
    const agent = (await (
      await request.get(`/api/organizations/${orgId}/agents/${leadId}`)
    ).json()) as { provider: string; model: string | null };
    return { provider: agent.provider, model: agent.model };
  };
  await expect(save).toBeDisabled();
  await select(page, "프로바이더").selectOption({ label: "가짜 프로바이더 2" });
  await expect(select(page, "모델")).toHaveValue("");

  // 서버가 거부하면 안내가 뜨고 고친 값은 초안으로 남으며 저장된 값은 그대로다.
  const providerPath = `**/api/organizations/${orgId}/agents/${leadId}/provider`;
  await page.route(
    providerPath,
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":{"code":"internal"}}',
      }),
    { times: 1 }
  );
  await save.click();
  await expect(alert).toContainText("저장하지 못했습니다");
  await expect(save).toHaveText("저장");
  await expect(save).toBeEnabled();
  await expect(select(page, "프로바이더")).toHaveValue("fake-2");
  expect(await stored()).toEqual({ provider: "fake", model: "fake-max" });

  // 저장하는 동안 버튼은 잠기지만 아직 저장되지 않았다. 이때 다음 실행 시도를 시작하지 않는다.
  const held = await sharedSettings.holdWrite(page, providerPath);
  await save.click();
  await held.arrived();
  await expect(save).toHaveText("저장하는 중…");
  await expect(save).toBeDisabled();
  expect(await stored()).toEqual({ provider: "fake", model: "fake-max" });

  // 서버가 새 값을 저장했다고 답하고 화면이 그 값을 받아들인 뒤에 다음 실행 시도를 시작한다.
  const saved = await held.release();
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ provider: "fake-2", model: null });
  await expect(save).toHaveText("저장");
  await expect(save).toBeDisabled();
  await expect(alert).toHaveCount(0);
  await expect(select(page, "프로바이더")).toHaveValue("fake-2");
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

test("the owner turns isolated runs on and off with one switch that saves at once, and another tab follows", async ({
  page,
  context,
}) => {
  await openWithLiveEvents(page, "/settings");
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(other, "/settings");
  const isolation = (p: Page) =>
    providers(p).getByRole("switch", { name: "격리 실행" });

  // 기본은 꺼짐이며, 그 행에는 이름과 스위치만 있고 설명문이 없다.
  await expect(isolation(page)).not.toBeChecked();
  await expect(
    providers(page)
      .getByRole("listitem")
      .filter({ has: page.getByRole("switch", { name: "격리 실행" }) })
  ).toHaveText("격리 실행");

  // 누르면 저장 버튼 없이 곧바로 저장되고 다른 탭(390px)도 따라온다.
  await isolation(page).click();
  await expect(isolation(page)).toBeChecked();
  await expect(isolation(other)).toBeChecked();

  // 키보드로도 바꾼다.
  await isolation(other).focus();
  await other.keyboard.press("Space");
  await expect(isolation(other)).not.toBeChecked();
  await expect(isolation(page)).not.toBeChecked();

  // 저장이 실패하면 서버에 저장된 값으로 돌아간다.
  await page.route("**/api/providers/isolation", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":{"code":"internal"}}',
    })
  );
  await isolation(page).click();
  await expect(providers(page).getByRole("alert")).toContainText(
    "저장하지 못했습니다"
  );
  await expect(isolation(page)).not.toBeChecked();
  await expect(isolation(other)).not.toBeChecked();
});
