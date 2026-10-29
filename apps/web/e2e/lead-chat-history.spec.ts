import { expect, test, type Locator, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
import { goalInput } from "./support/organization.ts";

// Lead 대화는 가장 최근 쪽(50개)만 먼저 그리고, 위로 올리면 더 오래된 쪽을 붙인다.
// 맨 아래를 따라가는 동안에는 가장 최근 창(100개 이하)만 남기고, 위로 올리면 덜어 낸 쪽을 다시 받는다.

const runs = { timeout: 30_000 };

type Org = { id: string; leadId: string; api: (path: string) => string };

async function createOrganization(page: Page, name: string): Promise<Org> {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  const result = {
    id: org.id,
    leadId: org.agents.find((a) => a.role === "lead")!.id,
    api,
  };
  await settled(page, result);
  return result;
}

/** Lead의 실행 시도가 모두 끝나고 줄 세운 메시지가 없다. */
async function settled(page: Page, org: Org) {
  await expect
    .poll(async () => {
      const list = (await (
        await page.request.get(org.api("/runs"))
      ).json()) as {
        status: string;
      }[];
      const queued = (await (
        await page.request.get(org.api("/queued-messages"))
      ).json()) as unknown[];
      return (
        list.length > 0 &&
        list.every((r) => r.status !== "running") &&
        queued.length === 0
      );
    }, runs)
    .toBe(true);
}

const post = async (page: Page, url: string, data: unknown = {}) =>
  expect((await page.request.post(url, { data })).ok()).toBe(true);

/**
 * 받은 메시지를 API로 쌓는다. 가짜 Lead를 `실행 유지 연습`으로 붙잡아 둔 채 상한(20)만큼 줄 세우고 실행을 중단하면
 * 다음 실행 시도가 그 20개를 한꺼번에 받고 답장한다. 한 번에 22개 남짓이 대화에 쌓인다.
 */
async function seedTranscript(page: Page, org: Org, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    await post(page, org.api("/messages"), { body: "실행 유지 연습" });
    await expect
      .poll(async () => {
        const [latest] = (await (
          await page.request.get(org.api("/runs"))
        ).json()) as { status: string }[];
        return latest?.status;
      }, runs)
      .toBe("running");
    for (let i = 1; i <= 20; i++)
      await post(page, org.api("/messages"), {
        body: `기록 ${round + 1}-${i}`,
      });
    await post(page, org.api(`/agents/${org.leadId}/interrupt`));
    await settled(page, org);
  }
}

/** 스크롤 영역 위쪽에서 메시지까지의 거리. */
const offsetIn = async (scroller: Locator, message: Locator) => {
  const [outer, inner] = await Promise.all([
    scroller.boundingBox(),
    message.boundingBox(),
  ]);
  return inner!.y - outer!.y;
};

test("the Lead chat shows the latest 50 messages and loads older ones on scroll-up or with the button, keeping the view in place", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const org = await createOrganization(page, "긴 대화 E2E 조직");
  await seedTranscript(page, org, 5);

  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const scroller = page.getByTestId("transcript-scroller");
  const messages = scroller.locator("[data-message-id]");
  await expect(messages).toHaveCount(50);
  const older = page.getByRole("button", { name: "이전 메시지 보기" });
  await expect(older).toBeVisible();

  // 위로 올리면 더 오래된 쪽을 붙인다. 붙이는 동안에도 보던 맨 위 메시지는 같은 자리에 있다.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/messages?before=*", async (route) => {
    await held;
    await route.continue();
  });
  const top = messages.first();
  const topId = await top.getAttribute("data-message-id");
  await scroller.hover();
  await page.mouse.wheel(0, -100_000);
  await expect(page.getByRole("list", { name: "대화" })).toHaveAttribute(
    "aria-busy",
    "true"
  );
  const before = await offsetIn(
    scroller,
    scroller.locator(`[data-message-id="${topId}"]`)
  );
  release();
  await expect(messages).toHaveCount(100);
  await expect(page.getByRole("list", { name: "대화" })).not.toHaveAttribute(
    "aria-busy"
  );
  const after = await offsetIn(
    scroller,
    scroller.locator(`[data-message-id="${topId}"]`)
  );
  expect(Math.abs(after - before)).toBeLessThan(40);
  await page.unroute("**/messages?before=*");

  // 키보드로 `이전 메시지 보기`를 누르면 남은 쪽을 받고, 처음까지 오면 버튼이 사라진다.
  await older.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => messages.count(), runs).toBeGreaterThan(100);
  await expect(older).toHaveCount(0);
  await expect(scroller.getByText("기록 1-1", { exact: true })).toHaveCount(1);

  // 위를 보고 있을 때 새 메시지가 와도 따라 내려가지 않고, 불러 둔 메시지를 덜어 내지도 않는다.
  const toBottom = page.getByRole("button", { name: "맨 아래로" });
  await scroller.evaluate((el) => el.scrollTo(0, 0));
  await expect(toBottom).toBeVisible();
  const loaded = await messages.count();
  await post(page, org.api("/messages"), { body: "새 소식이 있나요?" });
  const asked = scroller.locator('[data-author="owner"]').last();
  await expect(asked).toContainText("새 소식이 있나요?", runs);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(200);
  expect(await messages.count()).toBeGreaterThan(loaded);

  // 맨 아래에서 64px보다 멀면 버튼이 있고 그 안이면 없다. 맨 아래로 돌아오면 가장 최근 창(100개 이하)만 남긴다.
  await scroller.evaluate((el) =>
    el.scrollTo(0, el.scrollHeight - el.clientHeight - 30)
  );
  await expect(toBottom).toHaveCount(0);
  await expect.poll(() => messages.count()).toBeLessThanOrEqual(100);
  await expect(older).toBeVisible();
  await expect(asked).toBeInViewport();

  // 조금 올라가도 버튼이 있고, 누르면 맨 아래로 내려가고 버튼이 사라진다.
  await scroller.evaluate((el) =>
    el.scrollTo(0, el.scrollHeight - el.clientHeight - 400)
  );
  await expect(toBottom).toBeVisible();
  await toBottom.hover();
  await expect(page.getByRole("tooltip")).toHaveText("맨 아래로");
  await toBottom.click();
  await expect(toBottom).toHaveCount(0);
  await expect(asked).toBeInViewport();
});

test("keeps only the latest window while following live messages at the bottom, and loads the trimmed ones again on scroll-up", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const org = await createOrganization(page, "따라가는 대화 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const scroller = page.getByTestId("transcript-scroller");
  const messages = scroller.locator("[data-message-id]");
  const older = page.getByRole("button", { name: "이전 메시지 보기" });
  await expect(messages.first()).toBeVisible();
  await expect(older).toHaveCount(0);

  // 화면을 맨 아래에 둔 채 100개 넘게 받는다. 받는 동안 따라 내려가고, 불러 둔 메시지는 100개를 넘지 않는다.
  await seedTranscript(page, org, 5);
  await expect(scroller.getByText("기록 5-20", { exact: true })).toHaveCount(
    1,
    runs
  );
  await expect.poll(() => messages.count()).toBeLessThanOrEqual(100);
  await expect(messages.last()).toBeInViewport();
  await expect(page.getByRole("button", { name: "맨 아래로" })).toHaveCount(0);
  await expect(scroller.getByText("기록 1-1", { exact: true })).toHaveCount(0);
  await expect(older).toBeVisible();

  // 위로 올리면 덜어 낸 쪽을 다시 받는다.
  const trimmed = await messages.count();
  await scroller.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => messages.count(), runs).toBeGreaterThan(trimmed);
  while (await older.count()) {
    await older.click();
    await expect(page.getByRole("list", { name: "대화" })).not.toHaveAttribute(
      "aria-busy"
    );
  }
  await expect(scroller.getByText("기록 1-1", { exact: true })).toHaveCount(1);
});

test("stays at the bottom while the queue above the composer and the composer itself grow", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const org = await createOrganization(page, "바닥 유지 E2E 조직");
  await seedTranscript(page, org, 1);
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const scroller = page.getByTestId("transcript-scroller");
  await expect(scroller.getByText("기록 1-20", { exact: true })).toBeVisible();
  /** 맨 아래에서 떨어진 거리. 따라가는 동안은 0이다. */
  const gap = () =>
    scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBeLessThanOrEqual(1);

  // 입력창 위 줄 세운 메시지 목록이 자라면 대화 영역이 줄어든다. 사용자가 스크롤하지 않았으니 맨 아래에 남는다.
  await post(page, org.api("/messages"), { body: "실행 유지 연습" });
  await expect(
    scroller.getByText("실행 유지 연습", { exact: true })
  ).toBeVisible(runs);
  for (let i = 1; i <= 5; i++)
    await post(page, org.api("/messages"), { body: `줄 ${i}` });
  await expect(page.getByText("줄 세운 메시지 5/20")).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(1);

  // 여러 줄을 입력해 입력창이 자라도 마찬가지다.
  await page
    .getByRole("textbox", { name: "Lead에게 보낼 메시지" })
    .fill(Array.from({ length: 8 }, (_, i) => `줄 ${i + 1}`).join("\n"));
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "맨 아래로" })).toHaveCount(0);

  await post(page, org.api(`/agents/${org.leadId}/interrupt`));
  await settled(page, org);
});
