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
