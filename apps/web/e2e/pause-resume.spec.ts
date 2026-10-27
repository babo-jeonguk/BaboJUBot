import { expect, test, type Page } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  // 생성으로 깨어난 가짜 Lead가 초기 연구 승인을 요청하고 실행 시도를 끝낼 때까지 기다린다.
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/runs"));
      const list = (await res.json()) as { status: string }[];
      return list.length > 0 && list.every((r) => r.status === "completed");
    }, runs)
    .toBe(true);
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
      "승인 대기에서 멈춤"
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
  await expect(page.getByTestId("org-stage")).toHaveText("승인 대기");
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
  const confirm = controls.getByRole("group", { name: "조직을 중단할까요?" });
  await expect(confirm).toContainText("되돌릴 수 없습니다");
  // 되돌릴 수 없는 명령이라 포커스는 취소에서 시작한다.
  await expect(confirm.getByRole("button", { name: "취소" })).toBeFocused();
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(confirm).toHaveCount(0);

  await controls.getByRole("button", { name: /중단/ }).click();
  await confirm.getByRole("button", { name: "중단", exact: true }).click();
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
  expect(detail.stage).toBe("awaiting_approval");
  expect(await org.delivered("Lead가 멈춘 동안 보낸 메시지")).toBeNull();

  await control.getByRole("button", { name: /에이전트 재개/ }).click();
  await expect(
    control.getByRole("button", { name: /에이전트 일시정지/ })
  ).toBeVisible();
  await expect
    .poll(() => org.delivered("Lead가 멈춘 동안 보낸 메시지"), runs)
    .not.toBeNull();
});

/** 가짜 Lead는 `실행 유지 연습` 부탁을 받으면 취소될 때까지 실행 시도를 끝내지 않는다. */
async function holdLead(page: Page, org: { api: (path: string) => string }) {
  const res = await page.request.post(org.api("/messages"), {
    data: { body: "실행 유지 연습" },
  });
  expect(res.status()).toBe(201);
}

const latestRun = async (page: Page, org: { api: (path: string) => string }) =>
  (
    (await (await page.request.get(org.api("/runs"))).json()) as {
      status: string;
      cancelReason: string | null;
    }[]
  )[0];

test("the Lead chat composer follows the Lead: send when idle, stop while running, interrupt-and-send or queue with text", async ({
  page,
}) => {
  const org = await createOrganization(page, "입력창 버튼 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const send = page.getByRole("button", { name: "보내기", exact: true });
  const stop = page.getByRole("button", { name: "실행 중단" });
  const interrupt = page.getByRole("button", { name: "중단하고 보내기" });
  const queue = page.getByRole("button", { name: "줄 세우기" });
  const owner = page.locator('[data-author="owner"]');

  // 쉬는 Lead에게는 보내기 하나다.
  await expect(send).toBeDisabled();
  await expect(stop).toHaveCount(0);
  await expect(queue).toHaveCount(0);

  // Lead가 실행 중이면 입력이 빌 때 실행 중단만 보이고, 누르면 메시지 없이 지금 실행 시도만 끝난다.
  await holdLead(page, org);
  await expect(stop).toBeVisible(runs);
  await expect(send).toHaveCount(0);
  await expect(owner.getByText("실행 유지 연습")).toHaveCount(1);
  const messagesBefore = await owner.count();
  await stop.click();
  await expect(send).toBeVisible(runs);
  await expect
    .poll(() => latestRun(page, org), runs)
    .toMatchObject({ status: "cancelled", cancelReason: "owner_interrupt" });
  await expect(owner).toHaveCount(messagesBefore);
  const events = (await (
    await page.request.get(org.api("/events"))
  ).json()) as { type: string; payload: { messageId?: string | null } }[];
  expect(
    events.filter((e) => e.type === "agent.interrupted").map((e) => e.payload)
  ).toMatchObject([{ messageId: null }]);
  // 일시정지가 아니므로 다음 부탁은 평소처럼 실행 시도를 시작한다.
  await holdLead(page, org);
  await expect(stop).toBeVisible(runs);

  // 입력이 있으면 중단하고 보내기와 줄 세우기다. Enter는 줄 세우기다.
  await input.fill("다음에 할 일 하나");
  await expect(interrupt).toBeVisible();
  await expect(queue).toBeVisible();
  await expect(stop).toHaveCount(0);
  await input.press("Enter");
  await expect(owner.getByText("다음에 할 일 하나")).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("다음에 할 일 둘");
  await queue.click();
  await expect(owner.getByText("다음에 할 일 둘")).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(owner.getByText("중단하고 보냄")).toHaveCount(0);
  expect(await latestRun(page, org)).toMatchObject({
    status: "running",
    cancelReason: null,
  });

  // 보내지 못하면 입력을 그대로 둔다.
  await page.route(`**/api/organizations/${org.id}/messages`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, body: "{}" })
      : route.continue()
  );
  await input.fill("방향을 바꿔 주세요");
  await interrupt.click();
  await expect(page.getByRole("alert")).toContainText("보내지 못했습니다");
  await expect(input).toHaveValue("방향을 바꿔 주세요");
  await page.unrouteAll({ behavior: "wait" });

  // 중단하고 보내면 지금 실행 시도가 끝나고, 줄 선 메시지와 함께 다음 실행 시도가 받는다.
  await interrupt.click();
  await expect(owner.getByText("중단하고 보냄")).toHaveCount(1);
  await expect(input).toHaveValue("");
  // 두 번째 실행 유지 부탁, 줄 선 메시지 둘, 중단하고 보낸 메시지가 더해져 모두 전달된다.
  await expect(owner.getByRole("link", { name: "✓ 전달됨" })).toHaveCount(
    messagesBefore + 4,
    runs
  );
  await expect(send).toBeVisible(runs);
});

test("the Lead chat falls back to plain sending when another tab stops the organization", async ({
  page,
}) => {
  const org = await createOrganization(page, "다른 탭 중단 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await holdLead(page, org);
  await input.fill("중단 직전에 쓴 메시지");
  await expect(
    page.getByRole("button", { name: "중단하고 보내기" })
  ).toBeVisible(runs);

  // 다른 탭의 중단은 Event로 이 탭에 반영된다. 끝난 조직에는 중단할 실행이 없다.
  expect(
    (await page.request.post(org.api("/stop"), { data: {} })).status()
  ).toBe(200);
  await expect(
    page.getByRole("button", { name: "중단하고 보내기" })
  ).toHaveCount(0);
  await expect(input).toHaveValue("중단 직전에 쓴 메시지");

  await page.getByRole("button", { name: "보내기", exact: true }).click();
  const owner = page.locator('[data-author="owner"]');
  await expect(owner.getByText("중단 직전에 쓴 메시지")).toBeVisible();
  await expect(owner.getByText("중단하고 보냄")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
