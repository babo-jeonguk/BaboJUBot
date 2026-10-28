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
  // 아직 전달되지 않은 메시지는 대화가 아니라 입력창 위의 줄에 있다.
  await expect(other.getByTestId("queued-message")).toHaveText([
    "멈춘 동안 보낸 메시지",
  ]);
  expect(await org.delivered("멈춘 동안 보낸 메시지")).toBeNull();

  await controls(page).getByRole("button", { name: /재개/ }).click();
  await expect(page.getByTestId("org-stage")).toHaveText("승인 대기");
  // 재개하면 기다리던 메시지가 실행 시도에 전달되고 다른 탭에서도 줄에서 대화로 옮겨진다.
  await expect
    .poll(() => org.delivered("멈춘 동안 보낸 메시지"), runs)
    .not.toBeNull();
  await expect(
    other.locator('[data-author="owner"]').getByRole("link", {
      name: "✓ 전달됨",
    })
  ).toBeVisible(runs);
  await expect(other.getByTestId("queued-message")).toHaveCount(0);
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

  // 입력이 있으면 중단하고 보내기와 줄 세우기다. Enter는 줄 세우기다. 줄 세운 메시지는 대화가 아니라 입력창 위에 있다.
  const queued = page.getByTestId("queued-message");
  await input.fill("다음에 할 일 하나");
  await expect(interrupt).toBeVisible();
  await expect(queue).toBeVisible();
  await expect(stop).toHaveCount(0);
  await input.press("Enter");
  await expect(queued.getByText("다음에 할 일 하나")).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("다음에 할 일 둘");
  await queue.click();
  await expect(queued.getByText("다음에 할 일 둘")).toBeVisible();
  await expect(owner.getByText(/다음에 할 일/)).toHaveCount(0);
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

  // 중단하고 보내면 지금 실행 시도가 끝나고 다음 실행 시도는 그 메시지만 받는다. 줄 선 메시지 둘은 그다음 실행 시도가 함께 받는다.
  await interrupt.click();
  await expect(owner.getByText("중단하고 보냄")).toHaveCount(1);
  await expect(input).toHaveValue("");
  // 두 번째 실행 유지 부탁, 줄 선 메시지 둘, 중단하고 보낸 메시지가 더해져 모두 전달되고 줄은 빈다.
  await expect(owner.getByRole("link", { name: "✓ 전달됨" })).toHaveCount(
    messagesBefore + 4,
    runs
  );
  await expect(queued).toHaveCount(0);
  await expect(send).toBeVisible(runs);
  const order = await deliveryOrder(page, org);
  expect(order("방향을 바꿔 주세요")).toBeLessThan(order("다음에 할 일 하나"));
  expect(order("다음에 할 일 하나")).toBe(order("다음에 할 일 둘"));
});

/**
 * 메시지 본문 → 그 메시지를 받은 실행 시도의 순서(먼저 시작한 실행 시도가 작다).
 * 실행 시도 목록은 최근 것부터이므로 뒤집어 센다.
 */
async function deliveryOrder(
  page: Page,
  org: { api: (path: string) => string }
) {
  const messages = (await (
    await page.request.get(org.api("/messages"))
  ).json()) as { body: string; deliveredToRunId: string | null }[];
  const runIds = (
    (await (await page.request.get(org.api("/runs"))).json()) as {
      id: string;
    }[]
  )
    .map((r) => r.id)
    .reverse();
  return (body: string) => {
    const runId = messages.find((m) => m.body === body)?.deliveredToRunId;
    expect(runId, body).toBeTruthy();
    return runIds.indexOf(runId!);
  };
}

test("queued messages wait above the composer where the owner can edit one in place, pull one back, cancel one, or send one now", async ({
  page,
}) => {
  const org = await createOrganization(page, "줄 세운 메시지 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const list = page.getByRole("region", { name: /줄 세운 메시지/ });
  const queued = list.getByTestId("queued-message");
  const item = (body: string) => queued.filter({ hasText: body });
  const owner = page.locator('[data-author="owner"]');
  await holdLead(page, org);
  await expect(page.getByRole("button", { name: "실행 중단" })).toBeVisible(
    runs
  );

  for (const body of ["첫 번째 줄", "두 번째 줄", "세 번째 줄"]) {
    await input.fill(body);
    await input.press("Enter");
    // 보내기가 끝나야 입력창이 비고 다음 보내기를 받는다.
    await expect(input).toHaveValue("");
  }
  await expect(list.getByRole("heading")).toHaveText("줄 세운 메시지 3/20");
  await expect(queued).toHaveText(["첫 번째 줄", "두 번째 줄", "세 번째 줄"]);
  await expect(owner.getByText(/번째 줄/)).toHaveCount(0);

  // 항목 버튼은 마우스를 올리면 보이고, 이름이 tooltip으로 나온다.
  await item("세 번째 줄").hover();
  const edit = item("세 번째 줄").getByRole("button", { name: "고치기" });
  await expect(edit).toBeVisible();
  await edit.hover();
  await expect(page.getByRole("tooltip", { name: "고치기" })).toBeVisible();

  // 고치기는 그 항목을 그 자리에서 고치는 입력으로 바꾼다. Esc는 그대로 두고, 비우면 저장할 수 없다.
  await item("두 번째 줄").hover();
  await item("두 번째 줄").getByRole("button", { name: "고치기" }).click();
  const editor = list.getByLabel("줄 세운 메시지 고치기");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("두 번째 줄");
  await editor.fill("");
  await expect(list.getByRole("button", { name: "저장" })).toBeDisabled();
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(queued).toHaveText(["첫 번째 줄", "두 번째 줄", "세 번째 줄"]);
  await item("두 번째 줄").hover();
  await item("두 번째 줄").getByRole("button", { name: "고치기" }).click();
  await editor.fill("두 번째 줄 고침");
  await editor.press("Shift+Enter");
  await editor.pressSequentially("둘째 줄");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  // 고친 메시지는 줄 속 자리를 지킨다.
  await expect(queued).toHaveText([
    "첫 번째 줄",
    "두 번째 줄 고침\n둘째 줄",
    "세 번째 줄",
  ]);

  // 쓰던 글이 있으면 ↑는 줄을 건드리지 않는다. 빈 입력창의 ↑는 가장 최근 메시지를 입력창에 되돌린다.
  await input.fill("쓰던 글");
  await input.press("ArrowUp");
  await expect(queued).toHaveCount(3);
  await input.fill("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("세 번째 줄");
  await expect(queued).toHaveText(["첫 번째 줄", "두 번째 줄 고침\n둘째 줄"]);
  await input.press("Enter");
  await expect(input).toHaveValue("");

  // 취소는 거두기만 한다.
  await item("첫 번째 줄").hover();
  await item("첫 번째 줄").getByRole("button", { name: "취소" }).click();
  await expect(queued).toHaveText(["두 번째 줄 고침\n둘째 줄", "세 번째 줄"]);
  await input.fill("네 번째 줄");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(queued).toHaveText([
    "두 번째 줄 고침\n둘째 줄",
    "세 번째 줄",
    "네 번째 줄",
  ]);

  // 지금 보내기는 지금 실행 시도를 끊고 그 메시지만 다음 실행 시도에 보낸다. 남은 줄은 그다음 실행 시도가 받는다.
  await item("세 번째 줄").hover();
  await item("세 번째 줄").getByRole("button", { name: "지금 보내기" }).click();
  await expect(owner.filter({ hasText: "세 번째 줄" })).toContainText(
    "중단하고 보냄",
    runs
  );
  for (const body of ["두 번째 줄 고침", "네 번째 줄"])
    await expect(
      owner.filter({ hasText: body }).getByRole("link", { name: "✓ 전달됨" })
    ).toBeVisible(runs);
  await expect(list).toHaveCount(0);
  const order = await deliveryOrder(page, org);
  expect(order("세 번째 줄")).toBeLessThan(order("두 번째 줄 고침\n둘째 줄"));
  expect(order("두 번째 줄 고침\n둘째 줄")).toBe(order("네 번째 줄"));
  // 대화는 Lead가 받은 순서다. 먼저 보낸 줄도 지금 보낸 메시지 뒤에 온다.
  await expect(owner.getByTestId("message-body")).toHaveText([
    "실행 유지 연습",
    "세 번째 줄",
    /^두 번째 줄 고침\s*둘째 줄$/,
    "네 번째 줄",
  ]);
  // 거둔 메시지는 대화에 없다.
  await expect(owner.getByText("첫 번째 줄")).toHaveCount(0);
  const events = (await (
    await page.request.get(org.api("/events"))
  ).json()) as { type: string }[];
  expect(events.filter((e) => e.type === "message.edited")).toHaveLength(1);
  expect(events.filter((e) => e.type === "message.withdrawn")).toHaveLength(2);
  expect(events.filter((e) => e.type === "message.sent_now")).toHaveLength(1);
});

test("messages held by a paused organization wait in the queue, can be edited or withdrawn, and cannot be sent now", async ({
  page,
}) => {
  const org = await createOrganization(page, "일시정지 줄 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  expect(
    (await page.request.post(org.api("/pause"), { data: {} })).status()
  ).toBe(200);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const queued = page.getByTestId("queued-message");
  for (const body of ["멈춘 동안 하나", "멈춘 동안 둘"]) {
    await input.fill(body);
    await input.press("Enter");
    await expect(input).toHaveValue("");
  }
  await expect(queued).toHaveText(["멈춘 동안 하나", "멈춘 동안 둘"]);
  await expect(page.getByText("조직이 일시정지 중입니다")).toBeVisible();
  await queued.first().hover();
  await expect(page.getByRole("button", { name: "지금 보내기" })).toHaveCount(
    0
  );
  await queued.first().getByRole("button", { name: "취소" }).click();
  await expect(queued).toHaveText(["멈춘 동안 둘"]);

  // 일시정지 중에도 그 자리에서 고칠 수 있다. 저장하는 사이 실행 시도가 먼저 받으면 토스트로 알리고 대화로 옮긴다.
  await queued.first().hover();
  await queued.first().getByRole("button", { name: "고치기" }).click();
  const editor = page.getByLabel("줄 세운 메시지 고치기");
  await editor.fill("멈춘 동안 둘 고침");
  await page.route(`**/messages/*/edit`, async (route) => {
    expect(
      (await page.request.post(org.api("/resume"), { data: {} })).status()
    ).toBe(200);
    await expect.poll(() => org.delivered("멈춘 동안 둘"), runs).not.toBeNull();
    await route.continue();
  });
  await editor.press("Enter");
  await expect(page.getByText("이미 전달된 메시지입니다")).toBeVisible(runs);
  await expect(queued).toHaveCount(0, runs);
  await expect(
    page.locator('[data-author="owner"]').filter({ hasText: "멈춘 동안 둘" })
  ).toBeVisible();
  expect(await org.delivered("멈춘 동안 하나")).toBeNull();
  await page.unroute(`**/messages/*/edit`);
});

test("a full queue shows its count against the cap and disables sending until one is withdrawn", async ({
  page,
}) => {
  const org = await createOrganization(page, "가득 찬 줄 E2E 조직");
  expect(
    (await page.request.post(org.api("/pause"), { data: {} })).status()
  ).toBe(200);
  for (let i = 1; i <= 20; i++)
    expect(
      (
        await page.request.post(org.api("/messages"), {
          data: { body: `줄 ${i}` },
        })
      ).status()
    ).toBe(201);
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const list = page.getByRole("region", { name: /줄 세운 메시지/ });
  const queued = list.getByTestId("queued-message");
  await expect(list.getByRole("heading")).toHaveText("줄 세운 메시지 20/20");
  await expect(queued).toHaveCount(20);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await input.fill("하나 더");
  const send = page.getByRole("button", { name: "보내기", exact: true });
  await expect(send).toBeDisabled();
  await input.press("Enter");
  await expect(input).toHaveValue("하나 더");

  await queued.first().hover();
  await queued.first().getByRole("button", { name: "취소" }).click();
  await expect(list.getByRole("heading")).toHaveText("줄 세운 메시지 19/20");
  await send.click();
  await expect(input).toHaveValue("");
  await expect(queued.last()).toHaveText("하나 더");
});

test("the Lead chat stops taking messages when another tab stops the organization, but queued ones can still be cancelled", async ({
  page,
}) => {
  const org = await createOrganization(page, "다른 탭 중단 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  await holdLead(page, org);
  await input.fill("중단 전에 줄 세운 메시지");
  await expect(
    page.getByRole("button", { name: "중단하고 보내기" })
  ).toBeVisible(runs);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const queued = page.getByTestId("queued-message");
  await expect(queued).toHaveText(["중단 전에 줄 세운 메시지"]);

  // 다른 탭의 중단은 Event로 이 탭에 반영된다. 끝난 조직은 메시지를 받지 않으므로 입력창 대신 상태만 보인다.
  expect(
    (await page.request.post(org.api("/stop"), { data: {} })).status()
  ).toBe(200);
  await expect(page.getByTestId("composer-closed")).toHaveText("중단된 조직");
  await expect(input).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 대화" })).toBeDisabled();
  expect(
    (
      await page.request.post(org.api("/messages"), {
        data: { body: "끝난 뒤" },
      })
    ).status()
  ).toBe(409);

  // 줄 세운 메시지는 취소만 된다.
  await queued.hover();
  await expect(queued.getByRole("button", { name: "취소" })).toBeVisible();
  await expect(queued.getByRole("button", { name: "고치기" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "지금 보내기" })).toHaveCount(
    0
  );
  await queued.getByRole("button", { name: "취소" }).click();
  await expect(queued).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
