import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  /** 보낸 사용자 메시지가 실행 시도에 전달됐는가. */
  const delivered = async (body: string) => {
    const res = await page.request.get(api("/messages"));
    const messages = (await res.json()) as {
      body: string;
      deliveredToRunId: string | null;
    }[];
    return messages.find((m) => m.body === body)?.deliveredToRunId ?? null;
  };
  return { id: org.id, leadId, api, delivered };
}

test("the owner pauses the organization from the dashboard, sees it in another tab, and resumes it to deliver what waited", async ({
  page,
  context,
}) => {
  const org = await createOrganization(page, "일시정지 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(other, `/orgs/${org.id}/dashboard`);
  const controls = (p: Page) => p.getByRole("region", { name: "조직 제어" });

  await controls(page)
    .getByRole("button", { name: /일시정지/ })
    .click();
  for (const p of [page, other]) {
    await expect(
      controls(p).getByRole("button", { name: /재개/ })
    ).toBeVisible();
    await expect(p.getByTestId("org-stage")).toHaveAttribute(
      "title",
      "목표 설정에서 멈춤"
    );
  }

  // 일시정지 중 보낸 메시지는 남지만 Lead를 깨우지 않는다.
  await page.request.post(org.api("/messages"), {
    data: { body: "멈춘 동안 보낸 메시지" },
  });
  await other.goto(`/orgs/${org.id}/chat`);
  await expect(other.getByText("조직이 일시정지 중입니다")).toBeVisible();
  await expect(
    other.locator('[data-author="owner"]').getByText("다음 실행 시도 대기")
  ).toBeVisible();
  expect(await org.delivered("멈춘 동안 보낸 메시지")).toBeNull();

  await controls(page).getByRole("button", { name: /재개/ }).click();
  await expect(page.getByTestId("org-stage")).toHaveText("목표 설정");
  // 재개하면 기다리던 메시지가 실행 시도에 전달되고 다른 탭의 대화에도 보인다.
  await expect
    .poll(() => org.delivered("멈춘 동안 보낸 메시지"), runs)
    .not.toBeNull();
  await expect(
    other.locator('[data-author="owner"]').getByRole("link", {
      name: "✓ 전달됨",
    })
  ).toBeVisible(runs);
});

test("stopping asks once more and then leaves every control disabled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const org = await createOrganization(page, "중단 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
  const controls = page.getByRole("region", { name: "조직 제어" });

  await controls.getByRole("button", { name: /중단/ }).click();
  const confirm = controls.getByRole("group", { name: "조직 중단 확인" });
  await expect(confirm).toContainText("되돌릴 수 없습니다");
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(confirm).toHaveCount(0);

  await controls.getByRole("button", { name: /중단/ }).click();
  await confirm.getByRole("button", { name: "중단 확정" }).click();
  await expect(page.getByTestId("org-stage")).toHaveText("중단됨");
  await expect(
    controls.getByRole("button", { name: /일시정지/ })
  ).toBeDisabled();
  await expect(controls.getByRole("button", { name: /중단/ })).toBeDisabled();

  // 에이전트 상세의 일시정지도 보이지만 누를 수 없다.
  await page.goto(`/orgs/${org.id}/agents/${org.leadId}`);
  await expect(
    page.getByRole("button", { name: /에이전트 일시정지/ })
  ).toBeDisabled();
});

test("pausing one agent from its detail page holds its messages until it resumes", async ({
  page,
}) => {
  const org = await createOrganization(page, "에이전트 일시정지 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/agents/${org.leadId}`);
  const control = page.getByRole("region", { name: "에이전트 제어" });

  await control.getByRole("button", { name: /에이전트 일시정지/ }).click();
  await expect(
    control.getByRole("button", { name: /에이전트 재개/ })
  ).toBeVisible();
  await expect(page.getByText("일시정지", { exact: true })).toBeVisible();
  await page.request.post(org.api("/messages"), {
    data: { body: "Lead가 멈춘 동안 보낸 메시지" },
  });
  // 조직은 그대로 진행 중이다.
  const detail = await (await page.request.get(org.api(""))).json();
  expect(detail.stage).toBe("goal_setting");
  expect(await org.delivered("Lead가 멈춘 동안 보낸 메시지")).toBeNull();

  await control.getByRole("button", { name: /에이전트 재개/ }).click();
  await expect(
    control.getByRole("button", { name: /에이전트 일시정지/ })
  ).toBeVisible();
  await expect
    .poll(() => org.delivered("Lead가 멈춘 동안 보낸 메시지"), runs)
    .not.toBeNull();
});

test("the owner picks interrupt-and-deliver in the Lead chat, keeps the choice when sending fails, and sees it on the message", async ({
  page,
}) => {
  const org = await createOrganization(page, "중단하고 반영 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const interrupt = page.getByRole("radio", { name: "중단하고 반영" });
  const nextRun = page.getByRole("radio", { name: "다음 실행 시도에 반영" });
  await expect(nextRun).toBeChecked();

  // 보내지 못하면 입력과 전달 방식을 그대로 둔다.
  await page.route(`**/api/organizations/${org.id}/messages`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, body: "{}" })
      : route.continue()
  );
  await interrupt.check();
  await input.fill("방향을 바꿔 주세요");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByRole("alert")).toContainText("보내지 못했습니다");
  await expect(input).toHaveValue("방향을 바꿔 주세요");
  await expect(interrupt).toBeChecked();
  await page.unrouteAll({ behavior: "wait" });

  await page.getByRole("button", { name: "보내기" }).click();
  const owner = page.locator('[data-author="owner"]');
  await expect(owner.getByText("⤵ 중단하고 반영")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(nextRun).toBeChecked();
  await expect(owner.getByRole("link", { name: "✓ 전달됨" })).toBeVisible(runs);
  const events = (await (
    await page.request.get(org.api("/events"))
  ).json()) as {
    type: string;
  }[];
  expect(events.map((e) => e.type)).toContain("agent.interrupted");
});

test("the Lead chat falls back to delivering on the next run when another tab stops the organization", async ({
  page,
}) => {
  const org = await createOrganization(page, "다른 탭 중단 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const interrupt = page.getByRole("radio", { name: "중단하고 반영" });
  const nextRun = page.getByRole("radio", { name: "다음 실행 시도에 반영" });
  await interrupt.check();
  await input.fill("중단 직전에 쓴 메시지");

  // 다른 탭의 중단은 Event로 이 탭에 반영된다.
  expect(
    (await page.request.post(org.api("/stop"), { data: {} })).status()
  ).toBe(200);
  await expect(interrupt).toBeDisabled();
  await expect(nextRun).toBeChecked();
  await expect(input).toHaveValue("중단 직전에 쓴 메시지");

  await page.getByRole("button", { name: "보내기" }).click();
  const owner = page.locator('[data-author="owner"]');
  await expect(owner.getByText("중단 직전에 쓴 메시지")).toBeVisible();
  await expect(owner.getByText("⤵ 중단하고 반영")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
