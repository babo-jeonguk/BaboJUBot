import { expect, test } from "@playwright/test";
import {
  goalInput,
  leadComposer,
  messageAnswered,
  runsSettled,
  sendingMessage,
} from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";
import { withCleanup } from "@babojubot/runtime/test-cleanup";

test("keeps a draft edited while the previous message is being sent", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "초안 보존 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const input = page.getByLabel("Lead에게 보낼 메시지");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 보내기 응답과 함께 대화 목록·메시지 칸의 조회도 붙잡아 두 칸을 불러오는 중으로 둔다. 두 칸의 숨은
  // `불러오는 중…` 안내도 role="status"라 화면 전체에서 찾으면 전송 상태와 함께 잡힌다(#211).
  await page.route(
    (url) =>
      url.pathname === `/api/organizations/${org.id}/conversations` ||
      url.pathname === `/api/organizations/${org.id}/messages`,
    async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    }
  );
  await withCleanup(async (defer) => {
    defer(() => page.unrouteAll({ behavior: "wait" }));
    defer(() => release());

    await page.goto(`/orgs/${org.id}/chat`);
    // 대화 목록 칸과 메시지 칸이 둘 다 불러오는 중이다. 숨은 안내라 본문 영역 안에서 세고, 하나는 대화 목록의 것이다.
    await expect(
      page
        .getByRole("main")
        .getByRole("status")
        .filter({ hasText: "불러오는 중…" })
    ).toHaveCount(2);
    await expect(
      page.getByRole("navigation", { name: "대화 목록" }).getByRole("status")
    ).toHaveText("불러오는 중…");
    // 전송 상태는 입력창 영역 안에서 찾는다.
    const composer = leadComposer(page);
    const sending = composer
      .getByRole("status")
      .filter({ hasText: /^전송 중…$/ });
    await input.fill("첫 메시지");
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(sending).toBeVisible();
    await input.fill("다음 메시지 초안");
    release();
    await expect(sending).toHaveCount(0);
    await expect(input).toHaveValue("다음 메시지 초안");
    await expect(
      page.getByRole("button", { name: "보내기", exact: true })
    ).toBeEnabled();
  });
});

test("talking to the Lead shows its reply, the run in activity and run detail, and the Lead's recent runs", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "대화 E2E 조직", ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as { id: string };

  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  // 조직을 만들면 가짜 Lead가 깨어나 초기 연구 승인을 요청했다고 먼저 알린다.
  await runsSettled(page.request, org.id);
  const conversation = page.getByRole("list", { name: "대화" });
  await expect(conversation.locator('[data-author="agent"]')).toContainText(
    "초기 연구 승인을 요청했습니다"
  );
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await input.fill("데이터셋은 무엇을 쓸 계획인가요");
  const asked = await sendingMessage(page, () =>
    page.getByRole("button", { name: "보내기", exact: true }).click()
  );

  // Lead의 답장은 새로고침 없이 Event stream으로 나타난다.
  await messageAnswered(page.request, org.id, asked);
  const reply = conversation
    .locator('[data-author="agent"]')
    .filter({ hasText: "데이터셋은 무엇을 쓸 계획인가요" });
  await expect(reply).toBeVisible();
  await expect(input).toHaveValue("");
  const owner = conversation.locator('[data-author="owner"]');
  await expect(owner.getByRole("link", { name: "✓ 전달됨" })).toBeVisible();

  // 활동에서 실행 시도와 도구 호출 요약을 보고 실행 시도 상세로 간다.
  const sections = page.getByRole("navigation", { name: "조직 화면" });
  await sections.getByRole("link", { name: "활동" }).click();
  const stream = page.getByRole("list", { name: "활동 stream" });
  // 답장한 실행 시도(가장 최근)가 끝나기를 서버에서 확인하고, 그 실행 시도의 줄을 ID로 고른다. 실행 시도 완료·도구 호출
  // 문구는 생성으로 깨어난 앞선 실행 시도에도 있어 문구만으로는 이번 실행 시도를 가리지 못한다.
  let replyRunId = "";
  await expect
    .poll(
      async () => {
        const [latest] = (await (
          await page.request.get(`/api/organizations/${org.id}/runs`)
        ).json()) as { id: string; status: string }[];
        replyRunId = latest?.id ?? "";
        return latest?.status;
      },
      { timeout: 15_000 }
    )
    .toBe("completed");
  const replyEvents = stream.getByRole("listitem").filter({
    has: page.locator(`a[href="/orgs/${org.id}/runs/${replyRunId}"]`),
  });
  const replyCompleted = replyEvents.filter({
    hasText: "Research Lead 실행 시도 완료",
  });
  await expect(replyCompleted).toBeVisible();
  await expect(
    replyEvents.filter({ hasText: "조직 도구 send_message" })
  ).toBeVisible();
  await replyCompleted.getByRole("link", { name: /^실행 시도 / }).click();

  const runUrl = new RegExp(`/orgs/${org.id}/runs/${replyRunId}$`);
  await expect(page).toHaveURL(runUrl);
  await expect(page.getByRole("region", { name: "깨우기 사유" })).toContainText(
    "데이터셋은 무엇을 쓸 계획인가요"
  );
  await expect(page.getByRole("region", { name: "활동" })).toContainText(
    "조직 도구 send_message"
  );
  await expect(page.getByTestId("run-stop-reason")).toHaveText("완료");
  await expect(page.getByRole("region", { name: "종료" })).toContainText(
    "답장 1개"
  );

  // 에이전트 상세에서 Lead의 상태와 최근 실행 시도를 보고 그 실행 시도로 간다.
  const { agents } = (await (
    await page.request.get(`/api/organizations/${org.id}`)
  ).json()) as { agents: { id: string; role: string }[] };
  const leadId = agents.find((a) => a.role === "lead")!.id;
  await sections.getByRole("link", { name: "에이전트" }).click();
  await page
    .getByRole("region", { name: "조직도" })
    .getByRole("link", { name: /Research Lead/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/agents/${leadId}$`));
  await expect(
    page.getByRole("heading", { name: "Research Lead" })
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByText("대기", { exact: true })
  ).toBeVisible();
  // 최근 실행 시도는 이 대화의 것과 생성으로 깨어난 첫 실행 시도다.
  const recent = page.getByRole("region", { name: "최근 실행 시도" });
  await expect(recent.getByRole("link")).toHaveCount(2);
  await recent.getByRole("link").first().click();
  await expect(page).toHaveURL(runUrl);
  await expect(page.getByRole("navigation", { name: "위치" })).toContainText(
    "에이전트›Research Lead›실행 시도"
  );

  // 좁은 화면에서도 실행 시도 상세를 읽을 수 있다.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("run-stop-reason")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "깨우기 사유" })
  ).toBeInViewport({ ratio: 0.1 });
});

test("an empty Lead chat shows a neutral empty state", async ({ page }) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "빈 대화 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  // 가짜 Lead가 곧바로 답장하므로 대화 조회만 빈 목록으로 바꿔 빈 상태를 본다.
  await page.route(`**/api/organizations/${org.id}/messages`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: { messages: [], hasMore: false, before: null, after: null },
        })
      : route.continue()
  );
  await page.goto(`/orgs/${org.id}/chat`);
  const empty = page.getByTestId("lead-chat-empty");
  await expect(empty).toHaveText(/아직 대화가 없습니다/);
  await expect(empty).not.toContainText("목표");
});
