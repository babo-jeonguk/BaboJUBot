import { expect, test } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

test("keeps a draft edited while the previous message is being sent", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "초안 보존 조직" },
  });
  const org = (await created.json()) as { id: string };
  await page.goto(`/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/organizations/${org.id}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await input.fill("첫 메시지");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByRole("status")).toHaveText("전송 중…");
    await input.fill("다음 메시지 초안");
    release();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(input).toHaveValue("다음 메시지 초안");
    await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("talking to the Lead shows its reply, the run in activity and run detail, and the Lead's recent runs", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "대화 E2E 조직" },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as { id: string };

  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  await expect(page.getByTestId("lead-chat-empty")).toBeVisible();
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await input.fill("음성 인식 오류를 줄이는 것이 목표입니다");
  await page.getByRole("button", { name: "보내기" }).click();

  // Lead의 답장은 새로고침 없이 Event stream으로 나타난다.
  const conversation = page.getByRole("list", { name: "대화" });
  const reply = conversation.locator('[data-author="agent"]');
  await expect(reply).toContainText("음성 인식 오류를 줄이는 것이 목표입니다");
  await expect(input).toHaveValue("");
  const owner = conversation.locator('[data-author="owner"]');
  await expect(owner.getByRole("link", { name: /에 전달됨$/ })).toBeVisible();

  // 활동에서 실행 시도와 도구 호출 요약을 보고 실행 시도 상세로 간다.
  const sections = page.getByRole("navigation", { name: "조직 화면" });
  await sections.getByRole("link", { name: "활동" }).click();
  const stream = page.getByRole("list", { name: "활동 stream" });
  await expect(stream.getByText("Research Lead 실행 시도 완료")).toBeVisible();
  await expect(stream.getByText("조직 도구 send_message")).toBeVisible();
  await stream
    .getByRole("link", { name: /^실행 시도 / })
    .first()
    .click();

  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/);
  const runUrl = page.url();
  await expect(page.getByRole("region", { name: "깨우기 사유" })).toContainText(
    "음성 인식 오류를 줄이는 것이 목표입니다"
  );
  await expect(page.getByRole("region", { name: "활동" })).toContainText(
    "조직 도구 send_message"
  );
  await expect(page.getByTestId("run-stop-reason")).toHaveText("완료");
  await expect(page.getByRole("region", { name: "종료" })).toContainText(
    "답장 1개"
  );

  // 에이전트 상세에서 Lead의 상태와 최근 실행 시도를 보고 그 실행 시도로 간다.
  await sections.getByRole("link", { name: "에이전트" }).click();
  await page
    .getByRole("link", { name: /Research Lead/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: "Research Lead" })
  ).toBeVisible();
  await expect(page.getByText("대기", { exact: true })).toBeVisible();
  const recent = page.getByRole("region", { name: "최근 실행 시도" });
  await expect(recent.getByRole("link")).toHaveCount(1);
  await recent.getByRole("link").click();
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
