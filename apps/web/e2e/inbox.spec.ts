import { expect, test, type Locator } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 15_000 };
/** 행 앞 선택 단추의 체크박스 모양. 선택 중이 아니면 조직 아바타가 보이고 이 모양은 숨는다. */
const boxOf = (row: Locator) => row.getByRole("checkbox").getByText("✓");

test("the owner sorts failed runs and approval requests in the Inbox panel by attention, unread and archive, and another tab follows", async ({
  page,
  browser,
}) => {
  const name = "Inbox E2E 조직";
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const say = (body: string) =>
    page.request.post(`/api/organizations/${org.id}/messages`, {
      data: { body },
    });

  await openWithLiveEvents(page, `/orgs/${org.id}`);
  const card = page.getByRole("navigation", { name: "조직 화면" });
  // 조직을 만들면 가짜 Lead가 곧바로 초기 연구 승인을 요청해 주의 필요가 하나 생긴다.
  await expect(
    card.getByRole("button", { name: /이 조직의 Inbox 열기 · 주의 필요 1개/ })
  ).toBeVisible(runs);

  // 가짜 Lead에게 실패 연습을 부탁하면 실패한 실행 시도가 새로고침 없이 주의 필요로 뜬다.
  await say("실패 연습");
  const openForOrg = card.getByRole("button", {
    name: /이 조직의 Inbox 열기 · 주의 필요 2개/,
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
  await expect(failure).toContainText("읽지 않음");
  // 읽지 않은 항목에는 읽음 버튼이 따로 없다(열거나 체크해 읽는다).
  await expect(failure.getByRole("button", { name: /읽/ })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "주의 필요 2" })
  ).toBeVisible();

  // 초기 연구 승인 요청도 주의 필요다. 체크해 읽음으로 해도 결정이 남아 있어 주의 필요에서 빠지지 않는다.
  const request = attention
    .getByRole("listitem")
    .filter({ hasText: "초기 연구 승인 요청" });
  await expect(request).toBeVisible(runs);
  const selection = panel.getByRole("group", { name: "선택한 항목" });
  await expect(selection).toHaveCount(0);
  // 행 앞에는 체크박스 대신 조직 아바타가 있다. 아바타를 누르면 그 행이 체크되고,
  // 하나라도 체크돼 있는 동안 다른 행도 아바타 대신 체크박스를 보인다.
  await expect(boxOf(failure)).toBeHidden();
  await expect(boxOf(request)).toBeHidden();
  await request
    .getByRole("checkbox", { name: `초기 연구 승인 요청 · ${name} 선택` })
    .click();
  await expect(request.getByRole("checkbox")).toBeChecked();
  await expect(selection).toContainText("1개 선택");
  await expect(boxOf(failure)).toBeVisible();
  await expect(failure.getByRole("checkbox")).not.toBeChecked();
  // 마지막 체크를 풀면 다른 행은 아바타로 돌아온다. 키보드(Space)로도 체크한다.
  await request.getByRole("checkbox").click();
  await expect(selection).toHaveCount(0);
  await expect(boxOf(failure)).toBeHidden();
  await request.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await expect(request.getByRole("checkbox")).toBeChecked();
  await expect(selection).toContainText("1개 선택");
  await selection.getByRole("button", { name: "모두 읽음" }).click();
  await expect(selection).toHaveCount(0);
  // 승인 요청은 결정 여부가 주의를 정하므로 읽음을 되돌리는 버튼이 없고, 읽지 않음 표시만 사라진다.
  await expect(request).not.toContainText("읽지 않음");
  await expect(request.getByRole("button", { name: "읽지 않음" })).toHaveCount(
    0
  );
  await expect(request).toBeVisible();
  // 결정을 기다리는 항목은 보관할 수 없다(결정해야 한다). 실패는 보관할 수 있다.
  await expect(request.getByRole("button", { name: "보관" })).toHaveCount(0);
  await expect(failure.getByRole("button", { name: "보관" })).toBeVisible();
  // 필터는 주의 필요·전체·읽지 않음·보관됨이다.
  await expect(
    panel.getByRole("group", { name: "필터" }).getByRole("button")
  ).toHaveText([/^주의 필요/, /^전체/, /^읽지 않음/, /^보관됨/]);
  await expect(failure).toContainText("읽지 않음");

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
  await failure.getByRole("checkbox").check();
  await selection.getByRole("button", { name: "모두 읽음" }).click();
  await expect(failure).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "읽지 않음 0" })
  ).toBeVisible();
  await panel.getByRole("button", { name: /^전체 \d/ }).click();
  const all = panel.getByRole("list", { name: "전체" });
  const readFailure = all
    .getByRole("listitem")
    .filter({ hasText: "실행 시도 실패" });
  await expect(
    readFailure.getByRole("button", { name: "읽지 않음" })
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
  // Inbox 상세로 가도 1280px 이상에서는 패널이 그대로 붙어 있고, 연 항목이 표시된다.
  // 실패에는 결정이 없고 실패 사유와 실행 기록 링크가 있다.
  await archived.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`/inbox/${org.id}/run_failure/[0-9a-f-]{36}$`)
  );
  await expect(panel).toBeVisible();
  await expect(archived.getByRole("link")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(panel.getByRole("button", { name: "현재 조직" })).toBeEnabled();
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "실행 시도 실패"
  );
  await expect(main.getByRole("region", { name: "실패 사유" })).toContainText(
    "사용자가 부탁한 실패 연습입니다"
  );
  await expect(main.getByRole("region", { name: "결정" })).toHaveCount(0);
  // 상세의 정리 버튼은 패널과 같은 명령이다.
  await main.getByRole("button", { name: "보관 해제" }).click();
  await expect(panel.getByRole("button", { name: "보관됨 0" })).toBeVisible();
  await main.getByRole("link", { name: /실행 기록 보기/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/orgs/${org.id}/runs/[0-9a-f-]{36}$`)
  );

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
    data: { name, ...goalInput },
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
  // 이 조직에는 생성 뒤 가짜 Lead가 낸 초기 연구 승인 요청도 있다.
  const item = drawer
    .getByRole("list", { name: "주의 필요" })
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: "실행 시도 실패" });
  await expect(item).toBeVisible(runs);
  await item.getByRole("link").click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/inbox/${org.id}/run_failure/`));
  await expect(page.getByRole("region", { name: "실패 사유" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("the Inbox detail summarizes an item without marking it read, keeps a decided item's address, and reports missing items", async ({
  page,
}) => {
  const name = "Inbox 상세 조직";
  const created = await page.request.post("/api/organizations", {
    data: {
      name,
      goal: "Inbox 상세 확인",
      completionCriteria: "요약에서 결정한다",
    },
  });
  const org = (await created.json()) as { id: string };
  const say = (body: string) =>
    page.request.post(`/api/organizations/${org.id}/messages`, {
      data: { body },
    });
  await openWithLiveEvents(page, "/");
  await say("실패 연습");
  await page
    .getByRole("button", { name: /^Inbox · 주의 필요/ })
    .first()
    .click();
  const panel = page.getByRole("complementary", { name: "Inbox" });
  const attention = panel.getByRole("list", { name: "주의 필요" });
  const failure = attention
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: "실행 시도 실패" });
  const request = attention
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: "초기 연구 승인 요청" });
  await expect(request).toBeVisible(runs);

  // 실패 상세를 열면 읽음이 되어 주의 필요에서 빠진다.
  await failure.getByRole("link").click();
  const main = page.getByRole("main");
  await expect(main.getByRole("region", { name: "실패 사유" })).toBeVisible();
  await expect(failure).toHaveCount(0);
  // 상세에서 읽지 않음으로 되돌리면 주의 필요로 돌아오고, 열려 있는 동안 다시 읽음으로 바뀌지 않는다.
  await main.getByRole("button", { name: "읽지 않음" }).click();
  await expect(failure).toContainText("읽지 않음");
  const failureRead = async () =>
    (
      (await (await page.request.get("/api/inbox")).json()) as {
        kind: string;
        read: boolean;
        run?: { organizationId: string };
      }[]
    ).find((i) => i.kind === "run_failure" && i.run?.organizationId === org.id)
      ?.read;
  await page.waitForTimeout(1_000);
  expect(await failureRead()).toBe(false);
  await expect(main.getByRole("button", { name: "읽지 않음" })).toHaveCount(0);

  // 여러 항목을 체크하면 체크한 것만 한꺼번에 읽음이 된다.
  const selection = panel.getByRole("group", { name: "선택한 항목" });
  await failure.getByRole("checkbox").check();
  await request.getByRole("checkbox").check();
  await expect(selection).toContainText("2개 선택");
  await selection.getByRole("button", { name: "모두 읽음" }).click();
  await expect(failure).toHaveCount(0);
  // 승인 요청은 결정 여부가 주의를 정하므로 읽음을 되돌리는 버튼이 없고, 읽지 않음 표시만 사라진다.
  await expect(request).not.toContainText("읽지 않음");
  await expect(request.getByRole("button", { name: "읽지 않음" })).toHaveCount(
    0
  );
  expect(await failureRead()).toBe(true);

  // 다른 조직의 승인 요청도 기다린다. 한 요청에 쓰던 사유는 패널에서 다른 요청을 열면 따라가지 않는다.
  const otherName = "Inbox 상세 다른 조직";
  const other = (await (
    await page.request.post("/api/organizations", {
      data: {
        name: otherName,
        goal: "다른 조직 확인",
        completionCriteria: "사유가 섞이지 않는다",
      },
    })
  ).json()) as { id: string };
  const otherRequest = attention
    .getByRole("listitem")
    .filter({ hasText: otherName })
    .filter({ hasText: "초기 연구 승인 요청" });
  await expect(otherRequest).toBeVisible(runs);
  await request.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`/inbox/${org.id}/approval/[0-9a-f-]{36}$`)
  );
  const decidedUrl = page.url();
  const decision = main.getByRole("region", { name: "결정" });
  const note = decision.getByLabel(/결정 사유/);
  await note.fill("목표를 더 좁혀 주세요");
  await otherRequest.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`/inbox/${other.id}/approval/[0-9a-f-]{36}$`)
  );
  await expect(
    main.getByRole("region", { name: "연구 목표와 완료 기준" })
  ).toContainText("다른 조직 확인");
  await expect(note).toHaveValue("");
  await expect(decision.getByRole("button", { name: "반려" })).toBeDisabled();

  // 처음 요청으로 돌아가 요약에서 반려한다. 사유가 있어야 보낼 수 있다.
  await request.getByRole("link").click();
  await expect(page).toHaveURL(decidedUrl);
  await expect(
    main.getByRole("region", { name: "연구 목표와 완료 기준" })
  ).toContainText("Inbox 상세 확인");
  await expect(note).toHaveValue("");
  await expect(decision.getByRole("button", { name: "반려" })).toBeDisabled();
  await note.fill("목표를 더 좁혀 주세요");
  await decision.getByRole("button", { name: "반려" }).click();
  await expect(decision).toContainText("반려됨");
  await expect(decision).toContainText("목표를 더 좁혀 주세요");
  await expect(decision.getByRole("button")).toHaveCount(0);
  // 결정한 승인 요청은 주의 필요에서 빠지지만 전체에 결정 상태와 함께 남는다(Lead가 다시 낸 요청은 새 항목이다).
  const decidedLink = `a[href="${new URL(decidedUrl).pathname}"]`;
  await expect(attention.locator(decidedLink)).toHaveCount(0);
  await panel.getByRole("button", { name: /^전체 \d/ }).click();
  const decidedItem = panel
    .getByRole("list", { name: "전체" })
    .getByRole("listitem")
    .filter({ has: page.locator(decidedLink) });
  await expect(decidedItem).toContainText("반려됨");
  await expect(decidedItem).not.toContainText("주의 필요");
  // 결정한 항목은 상세에서 보관할 수 있고, 보관됨에서 다시 열면 결정 기록이 보인다.
  await main
    .getByRole("group", { name: "알림 정리" })
    .getByRole("button", { name: "보관" })
    .click();
  await expect(decidedItem).toHaveCount(0);
  await panel.getByRole("button", { name: /^보관됨 \d/ }).click();
  const archivedDecided = panel
    .getByRole("list", { name: "보관됨" })
    .getByRole("listitem")
    .filter({ has: page.locator(decidedLink) });
  await expect(archivedDecided).toContainText("반려됨");
  await archivedDecided.getByRole("link").click();
  await expect(page).toHaveURL(decidedUrl);
  await expect(main.getByRole("region", { name: "결정" })).toContainText(
    "반려됨"
  );

  // 결정한 항목의 주소를 다시 열어도 결정 기록이 보인다.
  await page.goto(decidedUrl);
  await expect(main.getByRole("region", { name: "결정" })).toContainText(
    "반려됨"
  );

  // 없는 항목, 다른 조직 주소의 항목, 실패하지 않은 실행 시도, 모르는 종류는 찾을 수 없다고 알린다.
  await page.goto(`/inbox/${org.id}/approval/${crypto.randomUUID()}`);
  await expect(page.getByText("찾을 수 없는 승인 요청")).toBeVisible();
  const approvalId = new URL(decidedUrl).pathname.split("/").pop();
  await page.goto(`/inbox/${other.id}/approval/${approvalId}`);
  await expect(page.getByText("찾을 수 없는 승인 요청")).toBeVisible();
  const orgRuns = (await (
    await page.request.get(`/api/organizations/${org.id}/runs`)
  ).json()) as { id: string; status: string }[];
  const completed = orgRuns.find((r) => r.status === "completed")!;
  await page.goto(`/inbox/${org.id}/run_failure/${completed.id}`);
  await expect(page.getByText("찾을 수 없는 실패한 실행 시도")).toBeVisible();
  await page.goto(`/inbox/${org.id}/unknown/${crypto.randomUUID()}`);
  await expect(page.getByText("찾을 수 없는 Inbox 항목")).toBeVisible();
});

test("when marking an opened item read fails, the Inbox detail says so and retries on request", async ({
  page,
}) => {
  const name = "Inbox 읽음 실패 조직";
  const org = (await (
    await page.request.post("/api/organizations", {
      data: { name, ...goalInput },
    })
  ).json()) as { id: string };
  await page.request.post(`/api/organizations/${org.id}/messages`, {
    data: { body: "실패 연습" },
  });
  await openWithLiveEvents(page, `/orgs/${org.id}`);
  await page
    .getByRole("navigation", { name: "조직 화면" })
    .getByRole("button", { name: /이 조직의 Inbox 열기/ })
    .click();
  const panel = page.getByRole("complementary", { name: "Inbox" });
  const failure = panel
    .getByRole("list", { name: "주의 필요" })
    .getByRole("listitem")
    .filter({ hasText: "실행 시도 실패" });
  await expect(failure).toBeVisible(runs);

  // 열 때 보내는 읽음 명령이 실패하면 오류를 알리고 읽지 않음으로 남는다.
  await page.route("**/api/organizations/*/inbox/run_failure/*", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, body: "{}" })
      : route.continue()
  );
  await failure.getByRole("link").click();
  const main = page.getByRole("main");
  const alert = main.getByRole("alert");
  await expect(alert).toContainText("읽음으로 표시하지 못했습니다");
  await expect(failure).toContainText("읽지 않음");

  // 다시 시도하면 읽음이 되어 주의 필요에서 빠진다.
  await page.unrouteAll({ behavior: "wait" });
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(failure).toHaveCount(0);
  await expect(alert).toHaveCount(0);
});

test("when the read-on-open reply is lost after the server marked the item read, the Inbox detail does not claim it failed", async ({
  page,
}) => {
  const name = "Inbox 읽음 응답 유실 조직";
  const org = (await (
    await page.request.post("/api/organizations", {
      data: { name, ...goalInput },
    })
  ).json()) as { id: string };
  await page.request.post(`/api/organizations/${org.id}/messages`, {
    data: { body: "실패 연습" },
  });
  await openWithLiveEvents(page, `/orgs/${org.id}`);
  await page
    .getByRole("navigation", { name: "조직 화면" })
    .getByRole("button", { name: /이 조직의 Inbox 열기/ })
    .click();
  const panel = page.getByRole("complementary", { name: "Inbox" });
  const failure = panel
    .getByRole("list", { name: "주의 필요" })
    .getByRole("listitem")
    .filter({ hasText: "실행 시도 실패" });
  await expect(failure).toBeVisible(runs);

  // 서버는 읽음을 저장했지만 응답이 오지 않는다.
  let lost = false;
  await page.route(
    "**/api/organizations/*/inbox/run_failure/*",
    async (route) => {
      if (route.request().method() !== "PUT" || lost) return route.continue();
      lost = true;
      await route.fetch();
      await route.abort("failed");
    }
  );
  await failure.getByRole("link").click();
  await expect.poll(() => lost).toBe(true);
  const main = page.getByRole("main");
  const organize = main.getByRole("group", { name: "알림 정리" });

  // 다시 불러온 Inbox가 읽음이면 실패 안내를 남기지 않는다.
  await expect(failure).toHaveCount(0);
  await expect(
    organize.getByRole("button", { name: "읽지 않음" })
  ).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);

  // 그 뒤 읽지 않음으로 되돌려도 지난 실패 안내가 다시 나타나지 않는다.
  // 주의 필요에는 생성 뒤 가짜 Lead가 낸 초기 연구 승인 요청과 되돌린 실패가 있다.
  await organize.getByRole("button", { name: "읽지 않음" }).click();
  await expect(
    panel.getByRole("list", { name: "주의 필요" }).getByRole("listitem")
  ).toHaveCount(2);
  await expect(main.getByRole("alert")).toHaveCount(0);
});

test("deciding from the Inbox detail after another surface decided first shows the recorded decision", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "Inbox 상세 경합 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const pending = async () =>
    (
      (await (await page.request.get("/api/inbox")).json()) as {
        kind: string;
        approval?: { id: string; organizationId: string };
      }[]
    ).find((i) => i.approval?.organizationId === org.id)?.approval?.id;
  await expect.poll(pending, runs).toBeTruthy();
  const approvalId = (await pending())!;

  // 이 탭은 Event stream을 받지 않아, 다른 곳의 결정을 모른 채 결정 폼을 보고 있다.
  await page.routeWebSocket(/\/api\/events/, () => {});
  await page.goto(`/inbox/${org.id}/approval/${approvalId}`);
  const decision = page.getByRole("region", { name: "결정" });
  await expect(decision.getByRole("button", { name: "승인" })).toBeEnabled();
  const approved = await page.request.post(
    `/api/organizations/${org.id}/approvals/${approvalId}/decision`,
    { data: { decision: "approve" } }
  );
  expect(approved.ok()).toBe(true);

  // 이 화면의 반려는 409로 거절되고, 최신 상태를 다시 불러와 먼저 온 승인을 결정 기록으로 보인다.
  await decision.getByLabel(/결정 사유/).fill("늦게 보낸 반려");
  await decision.getByRole("button", { name: "반려" }).click();
  await expect(decision).toContainText("승인됨");
  await expect(decision).not.toContainText("늦게 보낸 반려");
  await expect(decision.getByRole("button")).toHaveCount(0);
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
    "프로바이더",
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
