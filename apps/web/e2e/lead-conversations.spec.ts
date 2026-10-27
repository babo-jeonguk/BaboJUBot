import { expect, test, type Page } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

const uuidPath = /\/chat\/[0-9a-f-]{36}$/;

/** 대화 목록(넓은 화면의 왼쪽, 좁은 화면의 시트) 안의 대화 링크. */
const listOf = (page: Page) =>
  page.getByRole("navigation", { name: "대화 목록" });
const thread = (page: Page) => page.getByRole("list", { name: "대화" });

test("starts a second conversation, gets the Lead's reply there, and leaves the default conversation as it was; another tab follows live", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "여러 대화 E2E 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const send = async (p: Page, body: string) => {
    await p.getByLabel("Lead에게 보낼 메시지").fill(body);
    await p.getByRole("button", { name: "보내기", exact: true }).click();
  };

  // 생성으로 깨어난 Lead는 사용자 메시지 없이 한 일(초기 연구 승인 요청)을 기본 대화로 알린다.
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  await expect(page.getByRole("heading", { name: "기본 대화" })).toBeVisible();
  await expect(thread(page).locator('[data-author="agent"]')).toContainText(
    "초기 연구 승인을 요청했습니다"
  );
  // 기본 대화에서 한 번 주고받는다.
  await send(page, "기본 대화의 질문입니다");
  await expect(
    thread(page)
      .locator('[data-author="agent"]')
      .filter({ hasText: "기본 대화의 질문입니다" })
  ).toBeVisible();

  // 다른 탭은 기본 대화를 보고 있다.
  const other = await context.newPage();
  await openWithLiveEvents(other, `/orgs/${org.id}/chat`);
  await expect(listOf(other).getByRole("link")).toHaveText([
    /새 대화/,
    /기본 대화/,
  ]);

  // 새 대화는 빈 화면에서 입력창에 바로 쓸 수 있고, 보내기 전에는 목록에 생기지 않는다.
  await listOf(page).getByRole("link", { name: "새 대화" }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
  await expect(page.getByRole("heading", { name: "새 대화" })).toBeVisible();
  await expect(input).toBeFocused();
  await expect(thread(page)).toHaveCount(0);
  await expect(listOf(page).getByRole("listitem")).toHaveCount(1);

  await input.fill("학습 데이터 후보를 비교해 주세요");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(uuidPath);
  const conversationUrl = new URL(page.url()).pathname;
  await expect(
    page.getByRole("heading", { name: "학습 데이터 후보를 비교해 주세요" })
  ).toBeVisible();
  const reply = thread(page).locator('[data-author="agent"]');
  await expect(reply).toHaveCount(1);
  await expect(reply).toContainText("학습 데이터 후보를 비교해 주세요");
  await expect(reply).not.toContainText("기본 대화의 질문입니다");
  const items = listOf(page).getByRole("link");
  await expect(items).toHaveText([
    /새 대화/,
    /기본 대화/,
    /학습 데이터 후보를 비교해 주세요/,
  ]);
  await expect(items.nth(2)).toHaveAttribute("aria-current", "page");

  // 다른 탭의 목록이 새로고침 없이 새 대화를 보인다.
  await expect(listOf(other).getByRole("link")).toHaveText([
    /새 대화/,
    /기본 대화/,
    /학습 데이터 후보를 비교해 주세요/,
  ]);
  // 기본 대화는 그대로다(생성 알림과 처음 주고받은 두 메시지).
  await expect(thread(other).locator("[data-author]")).toHaveCount(3);
  await expect(thread(other)).not.toContainText("학습 데이터 후보");

  // 다른 탭이 새 대화를 열면, 이 탭에서 이어 보낸 메시지와 Lead의 답을 새로고침 없이 따라간다.
  await listOf(other)
    .getByRole("link", { name: /학습 데이터 후보를 비교해 주세요/ })
    .click();
  await expect(other).toHaveURL(conversationUrl);
  await send(page, "라이선스도 같이 봐 주세요");
  await expect(thread(other).locator('[data-author="owner"]')).toHaveText([
    /학습 데이터 후보를 비교해 주세요/,
    /라이선스도 같이 봐 주세요/,
  ]);
  await expect(
    thread(other).locator('[data-author="agent"]').nth(1)
  ).toContainText("라이선스도 같이 봐 주세요");

  // 아무 화면도 보고 있지 않은 대화에 Lead가 답하면 목록에 읽지 않음 점이 붙고, 열면 사라진다.
  const started = await page.request.post(
    `/api/organizations/${org.id}/conversations`,
    { data: { body: "평가 지표를 정리해 주세요" } }
  );
  expect(started.status()).toBe(201);
  const unseen = listOf(other).getByRole("link", {
    name: /평가 지표를 정리해 주세요/,
  });
  await expect(unseen.getByTestId("conversation-unread")).toBeVisible();
  await unseen.click();
  await expect(thread(other).locator('[data-author="agent"]')).toContainText(
    "평가 지표를 정리해 주세요"
  );
  await expect(unseen.getByTestId("conversation-unread")).toHaveCount(0);

  // 기본 대화로 돌아가도 생성 알림과 처음 주고받은 두 메시지뿐이다.
  await listOf(page)
    .getByRole("link", { name: /기본 대화/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/chat$`));
  await expect(thread(page).locator("[data-author]")).toHaveCount(3);
  await expect(thread(page)).not.toContainText("학습 데이터 후보");
  await other.close();
});

test("on a narrow screen the conversation list opens from the chat header and the composer stays at the bottom", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "좁은 화면 대화 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const started = await page.request.post(
    `/api/organizations/${org.id}/conversations`,
    { data: { body: "좁은 화면에서 이어 갈 대화" } }
  );
  const { conversation } = (await started.json()) as {
    conversation: { id: string };
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  // 목록은 접혀 있고 머리의 버튼으로 연다.
  await expect(listOf(page)).toBeHidden();
  await page.getByRole("button", { name: "대화 목록" }).click();
  const sheet = page.getByRole("dialog", { name: "대화 목록" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: /좁은 화면에서 이어 갈 대화/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/chat/${conversation.id}$`));
  await expect(thread(page).locator('[data-author="agent"]')).toContainText(
    "좁은 화면에서 이어 갈 대화"
  );
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await expect(input).toBeInViewport();
  const box = await input.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(844 * 0.7);
  // 화면이 옆으로 넘치지 않는다.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);

  // 머리의 새 대화 버튼으로 빈 새 대화를 시작한다.
  await page.getByRole("link", { name: "새 대화" }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
  await expect(input).toBeFocused();
});
