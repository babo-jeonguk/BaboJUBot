import { expect, test, type Page, type Request } from "@playwright/test";
import {
  goalInput,
  messageAnswered,
  runsSettled,
  sendingMessage,
  sentMessage,
} from "./support/organization.ts";
import { openWithLiveEvents, pageLoad } from "./support/live-events.ts";
import { expectNoHorizontalOverflow, settledBoxes } from "./support/layout.ts";

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
  /** 화면에서 보내고 서버가 저장한 메시지를 돌려준다. */
  const send = async (p: Page, body: string) => {
    await p.getByLabel("Lead에게 보낼 메시지").fill(body);
    return sendingMessage(p, () =>
      p.getByRole("button", { name: "보내기", exact: true }).click()
    );
  };

  // 생성으로 깨어난 Lead는 사용자 메시지 없이 한 일(초기 연구 승인 요청)을 기본 대화로 알린다.
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  await expect(page.getByRole("heading", { name: "기본 대화" })).toBeVisible();
  await runsSettled(page.request, org.id);
  await expect(thread(page).locator('[data-author="agent"]')).toContainText(
    "초기 연구 승인을 요청했습니다"
  );
  // 기본 대화에서 한 번 주고받는다.
  await messageAnswered(
    page.request,
    org.id,
    await send(page, "기본 대화의 질문입니다")
  );
  await expect(
    thread(page)
      .locator('[data-author="agent"]')
      .filter({ hasText: "기본 대화의 질문입니다" })
  ).toBeVisible();

  // 다른 탭은 기본 대화를 보고 있다.
  const other = await context.newPage();
  await openWithLiveEvents(other, `/orgs/${org.id}/chat`);
  await expect(listOf(other).getByRole("link")).toHaveText(
    [/새 대화/, /기본 대화/],
    pageLoad
  );

  // 새 대화는 빈 화면에서 입력창에 바로 쓸 수 있고, 보내기 전에는 목록에 생기지 않는다.
  await listOf(page).getByRole("link", { name: "새 대화" }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
  await expect(page.getByRole("heading", { name: "새 대화" })).toBeVisible();
  await expect(input).toBeFocused();
  await expect(thread(page)).toHaveCount(0);
  await expect(listOf(page).getByRole("listitem")).toHaveCount(1);

  await input.fill("학습 데이터 후보를 비교해 주세요");
  const first = await sendingMessage(page, () => page.keyboard.press("Enter"));
  await expect(page).toHaveURL(uuidPath);
  const conversationUrl = new URL(page.url()).pathname;
  await messageAnswered(page.request, org.id, first);
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
  // 서버가 메시지를 받아 Lead가 답할 때까지 기다린 뒤 다른 탭의 화면을 본다.
  await messageAnswered(
    page.request,
    org.id,
    await send(page, "라이선스도 같이 봐 주세요")
  );
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
  const unseenMessage = await sentMessage(started);
  const unseenConversation = { id: unseenMessage.conversationId };
  const unseen = listOf(other).getByRole("link", {
    name: /평가 지표를 정리해 주세요/,
  });
  const unread = unseen.getByTestId("conversation-unread");
  await messageAnswered(page.request, org.id, unseenMessage);
  await expect(unread).toBeVisible();

  // 열 때 함께 나가는 목록 조회가 읽음 기록보다 먼저 서버 상태(읽지 않음)를 받고, 읽음이 화면에 반영된 뒤에야
  // 도착하게 한다. 늦게 온 옛 목록이 읽음을 덮으면 점이 다시 나타난다(#211).
  const listPath = `/api/organizations/${org.id}/conversations`;
  let staleSeen!: (request: Request) => void;
  const stale = new Promise<Request>((resolve) => {
    staleSeen = resolve;
  });
  // 옛 목록이 끝내 오지 않아도 정리에서 읽음 기록을 보내 붙잡힌 요청이 남지 않게 한다.
  let letReadThrough!: () => void;
  const readHeld = new Promise<void>((resolve) => {
    letReadThrough = resolve;
  });
  void stale.then(() => letReadThrough());
  let releaseStale!: () => void;
  const staleHeld = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let holding = true;
  await other.route(
    (url) => url.pathname === listPath,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const list = (await response.json()) as { id: string; unread: boolean }[];
      if (
        holding &&
        list.some((c) => c.id === unseenConversation.id && c.unread)
      ) {
        holding = false;
        staleSeen(route.request());
        await staleHeld;
      }
      await route.fulfill({ response });
    }
  );
  // 옛 목록을 받아 둔 뒤에야 읽음 기록이 서버에 닿는다.
  await other.route(
    (url) => url.pathname === `${listPath}/${unseenConversation.id}/read`,
    async (route) => {
      await readHeld;
      await route.continue();
    }
  );
  try {
    const read = other.waitForResponse(
      (r) =>
        r.url().endsWith(`${listPath}/${unseenConversation.id}/read`) &&
        r.request().method() === "PUT"
    );
    await unseen.click();
    await expect(thread(other).locator('[data-author="agent"]')).toContainText(
      "평가 지표를 정리해 주세요"
    );
    const staleRequest = await stale;
    expect((await read).ok()).toBe(true);
    await expect(unread).toHaveCount(0);

    // 옛 목록을 놓아주고, 브라우저가 받아 화면이 그 응답을 처리할 기회를 준 뒤에도 점이 없다.
    const delivered = other.waitForEvent(
      "requestfinished",
      (r) => r === staleRequest
    );
    releaseStale();
    await delivered;
    await other.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            setTimeout(() => requestAnimationFrame(() => resolve()), 0)
          )
        )
    );
    await expect(unread).toHaveCount(0);
  } finally {
    releaseStale();
    letReadThrough();
    await other.unrouteAll({ behavior: "wait" });
  }

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
  const startedMessage = await sentMessage(started);
  const conversation = { id: startedMessage.conversationId };

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
  await messageAnswered(page.request, org.id, startedMessage);
  await expect(thread(page).locator('[data-author="agent"]')).toContainText(
    "좁은 화면에서 이어 갈 대화"
  );
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await expect(input).toBeInViewport();
  const [box] = await settledBoxes([input]);
  expect(box.y + box.height).toBeGreaterThan(844 * 0.7);
  // 화면이 옆으로 넘치지 않는다.
  await expectNoHorizontalOverflow(page);

  // 머리의 새 대화 버튼으로 빈 새 대화를 시작한다.
  await page.getByRole("link", { name: "새 대화" }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
  await expect(input).toBeFocused();
});
