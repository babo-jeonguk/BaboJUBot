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
}

const runs = { timeout: 15_000 };

test("the owner sorts failed runs and approval requests in the Inbox panel by attention, unread and archive, and another tab follows", async ({
  page,
  browser,
}) => {
  const name = "Inbox E2E 조직";
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const org = (await created.json()) as { id: string };
  const say = (body: string) =>
    page.request.post(`/api/organizations/${org.id}/messages`, {
      data: { body },
    });

  await openWithLiveEvents(page, `/orgs/${org.id}`);
  const card = page.getByRole("navigation", { name: "조직 화면" });
  await expect(
    card.getByRole("button", { name: /이 조직의 Inbox 열기 · 주의 필요 0개/ })
  ).toBeVisible();

  // 가짜 Lead에게 실패 연습을 부탁하면 실패한 실행 시도가 새로고침 없이 주의 필요로 뜬다.
  await say("실패 연습");
  const openForOrg = card.getByRole("button", {
    name: /이 조직의 Inbox 열기 · 주의 필요 1개/,
  });
  await expect(openForOrg).toBeVisible(runs);
  await openForOrg.click();
  const panel = page.getByRole("complementary", { name: "Inbox" });
  await expect(
    panel.getByRole("button", { name: "현재 조직" })
  ).toHaveAttribute("aria-pressed", "true");
  const attention = panel.getByRole("list", { name: "주의 필요" });
  const failure = attention.getByRole("listitem").filter({
    hasText: "실행 시도 실패",
  });
  await expect(failure).toContainText(name);
  await expect(failure).toContainText("사용자가 부탁한 실패 연습입니다");
  await expect(failure).toContainText("안 읽음");
  await expect(
    panel.getByRole("button", { name: "주의 필요 1" })
  ).toBeVisible();

  // 초기 연구 승인 요청도 주의 필요다. 읽어도 결정이 남아 있어 주의 필요에서 빠지지 않는다.
  await say("목표: Inbox 정리\n완료 기준: 읽음과 보관이 구분된다");
  const request = attention
    .getByRole("listitem")
    .filter({ hasText: "초기 연구 승인 요청" });
  await expect(request).toBeVisible(runs);
  await request.getByRole("button", { name: "읽음으로" }).click();
  await expect(
    request.getByRole("button", { name: "안 읽음으로" })
  ).toBeVisible();
  await expect(request).toBeVisible();

  // 다른 탭은 패널을 열고 전체 필터를 본다.
  const other = await browser.newPage();
  await openWithLiveEvents(other, `/orgs/${org.id}`);
  await other
    .getByRole("navigation", { name: "조직 화면" })
    .getByRole("button", { name: /이 조직의 Inbox 열기/ })
    .click();
  const otherPanel = other.getByRole("complementary", { name: "Inbox" });
  await expect(
    otherPanel.getByRole("button", { name: "보관됨 0" })
  ).toBeVisible();

  // 실패는 읽으면 주의 필요에서 빠지고, 보관하면 전체에서도 빠져 보관됨에 남는다.
  await failure.getByRole("button", { name: "읽음으로" }).click();
  await expect(failure).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "안 읽음 0" })).toBeVisible();
  await panel.getByRole("button", { name: /^전체 \d/ }).click();
  const all = panel.getByRole("list", { name: "전체" });
  const readFailure = all
    .getByRole("listitem")
    .filter({ hasText: "실행 시도 실패" });
  await expect(
    readFailure.getByRole("button", { name: "안 읽음으로" })
  ).toBeVisible();
  await readFailure.getByRole("button", { name: "보관" }).click();
  await expect(readFailure).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "보관됨 1" })).toBeVisible();
  await expect(
    otherPanel.getByRole("button", { name: "보관됨 1" })
  ).toBeVisible();
  await other.close();

  await panel.getByRole("button", { name: "보관됨 1" }).click();
  const archived = panel
    .getByRole("list", { name: "보관됨" })
    .getByRole("listitem")
    .filter({ hasText: "실행 시도 실패" });
  await expect(archived).toContainText("보관됨");
  // 상세로 가도 1280px 이상에서는 패널이 그대로 붙어 있다.
  await archived.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`/orgs/${org.id}/runs/[0-9a-f-]{36}$`)
  );
  await expect(panel).toBeVisible();

  // 보관은 승인 요청의 결정이나 단계를 바꾸지 않는다.
  const detail = await page.request.get(`/api/organizations/${org.id}`);
  expect(((await detail.json()) as { stage: string }).stage).toBe(
    "awaiting_approval"
  );
});

test("on a phone the top bar opens the Inbox as a drawer that closes when an item is picked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const name = "Inbox 모바일 조직";
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const org = (await created.json()) as { id: string };
  await page.request.post(`/api/organizations/${org.id}/messages`, {
    data: { body: "실패 연습" },
  });
  await openWithLiveEvents(page, "/");

  await page
    .getByRole("button", { name: /^Inbox · 주의 필요/ })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: "Inbox" });
  const item = drawer
    .getByRole("list", { name: "주의 필요" })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(item).toContainText("실행 시도 실패", runs);
  await item.getByRole("link").click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/runs/`));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("global settings shows the places for the runtime, environment templates, secrets and messaging apps", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "연구 조직" })
    .getByRole("link", { name: "전역 설정" })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "전역 설정" })).toBeVisible();
  for (const region of [
    "실행기 adapter",
    "연구 환경 템플릿",
    "비밀값",
    "메시지 앱 연결",
  ])
    await expect(page.getByRole("region", { name: region })).toContainText(
      "준비 중"
    );
  await expect(
    page.getByRole("region", { name: "메시지 앱 연결" })
  ).toContainText("가짜 채널");
});
