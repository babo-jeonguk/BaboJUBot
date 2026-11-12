// 셸 이동·포커스·탭·인라인 확인의 접근성 회귀(#151 F2·F3·F7·F14·F16). 역할 기반 locator, 포커스, 페이지 제목,
// ARIA 연결로 확인한다. 실제 스크린 리더 낭독은 이 검사 범위 밖이다.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };
const widths = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

type Org = { id: string; name: string; agents: { id: string; role: string }[] };

/** 조직을 만든다. 같은 spec을 다시 돌려도 이름이 겹치지 않게 뒤에 짧은 표지를 붙인다. */
async function createOrganization(page: Page, label: string) {
  const name = `${label} ${Math.random().toString(36).slice(2, 7)}`;
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as Org;
}

/** 지금 포커스가 있는 요소의 id. 포커스 대상이 바뀌었는지 비교할 때 쓴다. */
const idOf = (locator: Locator) => locator.getAttribute("id");

for (const size of widths) {
  test.describe(`${size.name} ${size.width}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    const mobile = size.width < 768;

    test("moving between screens focuses the new heading and names the screen and organization in the title", async ({
      page,
    }) => {
      const first = await createOrganization(
        page,
        `셸 이동 ${size.name} 첫 조직`
      );
      const second = await createOrganization(
        page,
        `셸 이동 ${size.name} 둘째 조직`
      );

      await openWithLiveEvents(page, "/");
      // 홈에는 홈을 알리는 h1이 하나 있다.
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText("연구 조직 홈");
      await expect(page).toHaveTitle("홈 · BaboJUBot");

      // 홈의 조직 방에서 대시보드로.
      await page
        .getByRole("region", { name: first.name, exact: true })
        .getByRole("link")
        .first()
        .click();
      await expect(page).toHaveURL(new RegExp(`/orgs/${first.id}$`));
      await expect(h1).toHaveText(first.name);
      await expect(h1).toBeFocused();
      await expect(page).toHaveTitle(`대시보드 · ${first.name} · BaboJUBot`);

      // 섹션 목록에서 Lead 대화로. 좁은 화면에서는 탐색 시트를 연다.
      const sections = mobile
        ? page.getByRole("dialog", { name: "탐색" })
        : page.getByRole("navigation", { name: "조직 화면" });
      if (mobile) await page.getByRole("button", { name: "탐색 열기" }).click();
      await sections.getByRole("link", { name: "Lead 대화" }).click();
      await expect(page).toHaveURL(new RegExp(`/orgs/${first.id}/chat`));
      if (mobile) await expect(sections).toBeHidden();
      await expect(h1).toBeFocused();
      await expect(page).toHaveTitle(`Lead 대화 · ${first.name} · BaboJUBot`);

      // 같은 화면의 실시간 갱신은 사용자가 쓰고 있는 입력의 포커스를 빼앗지 않는다.
      const composer = page.getByRole("textbox", {
        name: "Lead에게 보낼 메시지",
      });
      await composer.click();
      await composer.fill("쓰는 중");
      await page.request.post(`/api/organizations/${first.id}/messages`, {
        data: { body: "다른 탭에서 보낸 메시지" },
      });
      await expect(
        page.getByText("다른 탭에서 보낸 메시지").first()
      ).toBeVisible(runs);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("쓰는 중");

      // 다른 조직으로 옮기면 그 조직 정보를 불러오는 동안에도 앞 조직 이름이 제목에 남지 않는다.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`**/api/organizations/${second.id}`, async (route) => {
        await held;
        await route.continue();
      });
      if (mobile) {
        await page.getByRole("button", { name: "탐색 열기" }).click();
        await page
          .getByRole("dialog", { name: "탐색" })
          .getByRole("link", { name: new RegExp(`^${second.name} · `) })
          .click();
      } else {
        await page
          .getByRole("navigation", { name: "연구 조직" })
          .getByRole("link", { name: new RegExp(`^${second.name} · `) })
          .click();
      }
      await expect(page).toHaveURL(new RegExp(`/orgs/${second.id}$`));
      await expect(page).toHaveTitle("대시보드 · BaboJUBot");
      release();
      await expect(h1).toHaveText(second.name);
      await expect(h1).toBeFocused();
      await expect(page).toHaveTitle(`대시보드 · ${second.name} · BaboJUBot`);
      await page.unrouteAll({ behavior: "wait" });

      // 홈으로 돌아와도 제목에 조직이 남지 않는다.
      if (mobile) await page.getByRole("button", { name: "탐색 열기" }).click();
      await (mobile ? page.getByRole("dialog", { name: "탐색" }) : page)
        .getByRole("navigation", { name: "연구 조직" })
        .getByRole("link", { name: /홈$/ })
        .click();
      await expect(h1).toHaveText("연구 조직 홈");
      await expect(h1).toBeFocused();
      await expect(page).toHaveTitle("홈 · BaboJUBot");
    });

    test("the home without organizations still has one h1 naming the home", async ({
      page,
    }) => {
      await page.route("**/api/overview", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
          response,
          json: { ...body, organizations: [] },
        });
      });
      await page.goto("/");
      await expect(page.getByText("아직 연구 조직이 없습니다")).toBeVisible();
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText("연구 조직 홈");
      await expect(page).toHaveTitle("홈 · BaboJUBot");
    });

    test("the instruction copy tabs use one tab stop, arrow keys and linked panels, and keep the unsaved draft guard", async ({
      page,
    }) => {
      const org = await createOrganization(page, `사본 탭 ${size.name} 조직`);
      const leadId = org.agents.find((a) => a.role === "lead")!.id;
      await openWithLiveEvents(
        page,
        `/orgs/${org.id}/agents/${leadId}/instructions`
      );
      const tablist = page.getByRole("tablist", { name: "사본 파일" });
      const tabs = tablist.getByRole("tab");
      await expect(tabs.first()).toBeVisible();
      const count = await tabs.count();
      expect(count).toBeGreaterThanOrEqual(2);
      const afterSecond = 2 % count;
      const panel = page.getByRole("tabpanel");

      /** 고른 탭이 하나뿐이고 그 탭만 Tab 순서에 있으며 패널과 서로 이어진다. */
      const expectSelected = async (index: number) => {
        const tab = tabs.nth(index);
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(tablist.locator('[aria-selected="true"]')).toHaveCount(1);
        await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
        await expect(tab).toHaveAttribute("tabindex", "0");
        const tabId = await idOf(tab);
        expect(tabId).toBeTruthy();
        await expect(panel).toHaveAttribute("aria-labelledby", tabId!);
        for (let i = 0; i < count; i++) {
          const controls = await tabs.nth(i).getAttribute("aria-controls");
          expect(controls).toBeTruthy();
          await expect(page.locator(`[id="${controls}"]`)).toHaveRole(
            "tabpanel"
          );
        }
        await expect(panel).toHaveAccessibleName(
          (await tab.textContent())!.trim()
        );
      };
      await expectSelected(0);
      const ids = await Promise.all(
        Array.from({ length: count }, (_, i) => idOf(tabs.nth(i)))
      );
      expect(new Set(ids).size).toBe(count);

      // 화살표는 포커스만 옮기고(수동 선택), Enter·Space로 고른다. 양 끝에서 순환하고 Home/End는 처음·끝으로 간다.
      await tabs.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(tabs.nth(1)).toBeFocused();
      await expectSelected(0);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(tabs.nth(count - 1)).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(tabs.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(tabs.nth(count - 1)).toBeFocused();
      await page.keyboard.press("Home");
      await expect(tabs.first()).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expectSelected(1);
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      await expectSelected(afterSecond);

      // Tab은 고른 탭 하나만 지나 패널 안으로 간다.
      await page.keyboard.press("Shift+Tab");
      await expect(tabs.nth(afterSecond)).not.toBeFocused();
      await page.keyboard.press("Tab");
      await expect(tabs.nth(afterSecond)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(panel.getByRole("button", { name: "✎ 편집" })).toBeFocused();

      // 저장하지 않은 편집이 있으면 키보드로 다른 탭을 골라도 버릴지 묻고, 계속 편집하면 초안이 남는다.
      await page.keyboard.press("Enter");
      const editor = panel.getByRole("textbox");
      await editor.fill("키보드 전환 초안");
      await tabs.nth(afterSecond).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      const ask = page.getByRole("dialog", { name: "편집한 내용을 버릴까요?" });
      await expect(ask).toBeVisible();
      await ask.getByRole("button", { name: "계속 편집" }).click();
      await expect(ask).toBeHidden();
      await expectSelected(afterSecond);
      await expect(editor).toHaveValue("키보드 전환 초안");
    });

    test("cancelling the stop confirmation with Escape or the cancel button returns focus to the stop button without stopping", async ({
      page,
    }) => {
      const org = await createOrganization(page, `중단 확인 ${size.name} 조직`);
      await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
      const stops: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().endsWith(`/${org.id}/stop`))
          stops.push(r.url());
      });
      const controls = page.getByRole("region", { name: "조직 제어" });
      const trigger = controls.getByRole("button", { name: "⏹ 중단…" });
      const confirm = controls.getByRole("group", {
        name: "조직을 중단할까요?",
      });

      await trigger.click();
      await expect(confirm.getByRole("button", { name: "취소" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(confirm).toBeHidden();
      await expect(trigger).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "취소" }).click();
      await expect(confirm).toBeHidden();
      await expect(trigger).toBeFocused();

      expect(stops).toEqual([]);
      await expect(page.getByTestId("org-stage")).not.toHaveText("중단됨");
    });
  });
}

test("the docked Inbox takes focus when opened, is linked from its triggers, and returns focus to the trigger that opened it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const org = await createOrganization(page, "Inbox 포커스 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}`);
  const panel = page.getByRole("complementary", { name: "Inbox" });
  const heading = panel.getByRole("heading", { name: "Inbox" });

  for (const trigger of [
    page
      .getByRole("navigation", { name: "조직 화면" })
      .getByRole("button", { name: /이 조직의 Inbox 열기/ }),
    page
      .getByRole("navigation", { name: "연구 조직" })
      .getByRole("button", { name: /^Inbox · / }),
  ]) {
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await expect(heading).toBeFocused();
    const controls = await trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(await panel.getAttribute("id")).toBe(controls);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // 패널 안에서 Tab으로 이어 간다.
    await page.keyboard.press("Tab");
    await expect(
      panel.getByRole("button", { name: "Inbox 닫기" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
});

test("the narrow Inbox drawer still traps focus and returns it to its trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(page, "/");
  // drawer가 열리면 바깥이 접근성 트리에서 숨으므로 트리거는 속성으로 찾는다.
  const trigger = page.locator('main button[aria-label^="Inbox · "]');
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Inbox" });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(":focus")).toHaveCount(1);
  expect(await trigger.getAttribute("aria-controls")).toBe(
    await drawer.getAttribute("id")
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await drawer.getByRole("button", { name: "Inbox 닫기" }).click();
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("cancelling the final completion confirmation returns focus to its button without deciding", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const org = await createOrganization(page, "최종 완료 확인 조직");
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/approvals"));
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    }, runs)
    .not.toBe("");
  await page.request.post(api(`/approvals/${approvalId}/decision`), {
    data: { decision: "approve" },
  });
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/tasks"));
      return ((await res.json()) as { status: string }[]).filter(
        (t) => t.status === "completed"
      ).length;
    }, runs)
    .toBe(2);
  await page.request.post(api("/messages"), {
    data: { body: "결과 제출 부탁해요" },
  });
  let submissionId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/results"));
      submissionId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return submissionId;
    }, runs)
    .not.toBe("");

  const decisions: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/decision"))
      decisions.push(r.url());
  });
  for (const size of widths) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openWithLiveEvents(page, `/orgs/${org.id}/results/${submissionId}`);
    const decision = page.getByRole("region", { name: "결정" });
    const trigger = decision.getByRole("button", { name: "최종 완료" });
    const confirm = decision.getByRole("group", { name: "최종 완료할까요?" });

    await trigger.click();
    await expect(confirm.getByRole("button", { name: "취소" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "취소" }).click();
    await expect(confirm).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  expect(decisions).toEqual([]);
  await expect(page.getByRole("main")).toContainText("검토 대기");
});
