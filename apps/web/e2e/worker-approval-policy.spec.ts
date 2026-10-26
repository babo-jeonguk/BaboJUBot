import { expect, test, type Page } from "@playwright/test";

/** 레일의 Inbox 버튼으로 Inbox 패널을 연다. 이미 열려 있으면 그대로 둔다(버튼은 여닫기). */
async function openInbox(page: Page) {
  const button = page
    .getByRole("navigation", { name: "연구 조직" })
    .getByRole("button", { name: /^Inbox/ });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
}

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

const runs = { timeout: 20_000 };

test("the owner turns on the worker approval policy in settings, sees it in another tab, and decides the Lead's worker requests from the Inbox", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const name = "작업자 정책 E2E 조직";
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  // 가짜 Lead가 목표를 기록하고 초기 연구 승인을 요청한다. 승인해 연구 진행에 들어선다.
  await page.request.post(api("/messages"), {
    data: { body: "목표: 오류 유형을 정리한다\n완료 기준: 유형 목록" },
  });
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/approvals"));
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    })
    .not.toBe("");
  await page.request.post(api(`/approvals/${approvalId}/decision`), {
    data: { decision: "approve" },
  });
  const workerCount = async () => {
    const res = await page.request.get(api(""));
    return ((await res.json()) as { agents: { role: string }[] }).agents.filter(
      (a) => a.role === "worker"
    ).length;
  };
  await expect.poll(workerCount, runs).toBe(2);

  // 두 탭에서 설정을 연다. 한쪽에서 체크하면 다른 쪽도 새로고침 없이 바뀐다.
  await openWithLiveEvents(page, `/orgs/${org.id}/settings`);
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(other, `/orgs/${org.id}/settings`);
  const policy = (p: Page) =>
    p
      .getByRole("region", { name: "승인 정책" })
      .getByRole("checkbox", { name: /작업자 추가/ });
  await expect(policy(page)).not.toBeChecked();
  await expect(policy(other)).not.toBeChecked();
  await expect(page.getByRole("region", { name: "승인 정책" })).toContainText(
    "초기 연구 승인과 최종 완료는 항상 사용자가 결정"
  );

  await policy(page).check();
  await expect(policy(page)).toBeChecked();
  await expect(policy(other)).toBeChecked();

  // 정책이 켜져 있으니 Lead의 작업자 추가는 승인 요청이 되고 작업자는 아직 없다.
  await page.goto(`/orgs/${org.id}/chat`);
  await page.getByLabel("Lead에게 보낼 메시지").fill("작업자 추가: researcher");
  await page.getByRole("button", { name: "보내기" }).click();
  const requested = page
    .getByRole("list", { name: "대화" })
    .locator('[data-author="agent"]')
    .filter({
      hasText: "작업자 추가 승인 정책이 켜져 있어 승인을 요청했습니다",
    });
  await expect(requested).toHaveCount(1, runs);
  expect(await workerCount()).toBe(2);

  // Inbox → 작업자 추가 요청의 Inbox 상세(요약). 수정 요청은 없고, 반려에는 사유가 필요하다.
  const openRequest = async () => {
    await openInbox(page);
    await page
      .getByRole("list", { name: "주의 필요" })
      .getByRole("link", { name: new RegExp(`작업자 추가 승인 요청.*${name}`) })
      .click();
    await expect(page).toHaveURL(
      /\/inbox\/[0-9a-f-]{36}\/approval\/[0-9a-f-]{36}$/
    );
  };
  await openRequest();
  const target = page.getByRole("region", { name: "추가할 작업자" });
  await expect(target).toContainText("연구원");
  await expect(target).toContainText("받을 사본");
  const decision = page.getByRole("region", { name: "결정" });
  await expect(decision.getByRole("button", { name: "수정 요청" })).toHaveCount(
    0
  );
  await expect(decision.getByRole("button", { name: "반려" })).toBeDisabled();
  await decision.getByLabel(/결정 사유/).fill("지금은 인원이 충분합니다");
  await decision.getByRole("button", { name: "반려" }).click();
  await expect(decision).toContainText("반려됨");
  await expect(decision).toContainText("지금은 인원이 충분합니다");
  await expect(decision).toContainText("작업자를 만들지 않았고");
  expect(await workerCount()).toBe(2);

  // 다시 부탁해 승인하면 작업자가 생긴다.
  await page.goto(`/orgs/${org.id}/chat`);
  await page.getByLabel("Lead에게 보낼 메시지").fill("작업자 추가: researcher");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(requested).toHaveCount(2, runs);
  // 이번에는 원래 화면에서 사본 내용을 보고 승인한다.
  await openRequest();
  await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  await expect(target).toContainText("AGENTS.md ← harness/roles/researcher");
  await decision.getByRole("button", { name: "승인" }).click();
  await expect(decision).toContainText("승인됨");
  await expect(decision).toContainText("작업자가 팀에 더해졌습니다");
  await expect.poll(workerCount, runs).toBe(3);

  // 다른 탭(390px)에서 끄면 첫 탭도 새로고침 없이 꺼진다.
  await page.goto(`/orgs/${org.id}/settings`);
  await expect(policy(page)).toBeChecked();
  await policy(other).uncheck();
  await expect(policy(other)).not.toBeChecked();
  await expect(policy(page)).not.toBeChecked();
});
