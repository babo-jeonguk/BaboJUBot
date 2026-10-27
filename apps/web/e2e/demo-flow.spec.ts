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

// README의 손 조작 순서와 같은 판 1 데모 시나리오를 대시보드에서 처음부터 끝까지 누른다.
// 주요 사용자 행동은 모두 화면으로 하고, 조회 API는 쓰지 않는다.
test("the demo scenario walks one organization from creation through the Lead chat, initial approval, worker results, pause and resume, a worker approval and the result review to final completion", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const name = "데모 흐름 E2E 조직";
  const rail = page.getByRole("navigation", { name: "연구 조직" });
  const stageLink = (stage: string) =>
    rail.getByRole("link", { name: `${name} · ${stage}` });
  const leadSaid = (text: string) =>
    page
      .getByRole("list", { name: "대화" })
      .locator('[data-author="agent"]')
      .filter({ hasText: text });
  const attention = page.getByRole("list", { name: "주의 필요" });
  const workerTeam = page.getByRole("region", { name: "작업자 팀" });
  const decision = page.getByRole("region", { name: "결정" });
  const controls = page.getByRole("region", { name: "조직 제어" });
  const main = page.getByRole("main");
  // 승인 결과를 다른 탭의 작업 목록이 새로고침 없이 따라오는지 본다. 작업 결과를 확인하면 닫는다.
  const watcher = await context.newPage();
  let orgId = "";
  const orgPath = (path: string) => `/orgs/${orgId}${path}`;
  const send = async (body: string) => {
    await page.getByLabel("Lead에게 보낼 메시지").fill(body);
    await page.getByRole("button", { name: "보내기" }).click();
  };

  await test.step("조직을 만들고 Lead 대화로 목표와 완료 기준을 보낸다", async () => {
    await openWithLiveEvents(page, "/");
    await rail.getByRole("button", { name: "새 연구 조직" }).click();
    const dialog = page.getByRole("dialog", { name: "새 연구 조직" });
    await dialog.getByLabel("조직 이름").fill(name);
    await dialog.getByRole("button", { name: "만들고 Lead 대화로" }).click();
    await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/chat$/);
    orgId = new URL(page.url()).pathname.split("/")[2]!;
    await expect(stageLink("목표 설정")).toBeVisible();

    await send(
      "목표: 공개 자료로 오류 유형을 정리한다\n완료 기준: 유형 목록과 근거 메모"
    );
    await expect(leadSaid("초기 연구 승인을 요청했습니다")).toHaveCount(
      1,
      runs
    );
    await expect(stageLink("승인 대기")).toBeVisible();
  });

  await test.step("초기 연구 승인 전에는 작업자와 작업이 없다", async () => {
    await openWithLiveEvents(page, orgPath("/agents"));
    await expect(workerTeam).toContainText("작업자 팀 0명");
    await expect(workerTeam).toContainText("아직 작업자가 없습니다");
    await openWithLiveEvents(watcher, orgPath("/tasks"));
    await expect(watcher.getByRole("main")).toContainText(
      "아직 작업이 없습니다"
    );
  });

  await test.step("Inbox에서 초기 연구 계획·팀·연구 환경을 보고 승인한다", async () => {
    await openInbox(page);
    await attention.getByRole("link", { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(
      /\/inbox\/[0-9a-f-]{36}\/approval\/[0-9a-f-]{36}$/
    );
    await expect(
      page.getByRole("region", { name: "연구 목표와 완료 기준" })
    ).toContainText("유형 목록과 근거 메모");
    await expect(page.getByRole("region", { name: "팀 구성" })).toContainText(
      "연구원 2명"
    );
    // Inbox 상세는 계획·명세의 앞 네 줄만 보이므로 그 안의 줄로 확인한다.
    await expect(
      page.getByRole("region", { name: "초기 연구 계획" })
    ).toContainText("공개 자료로 오류 유형을 정리한다");
    await expect(
      page.getByRole("region", { name: "연구 환경 명세" })
    ).toContainText("compute: 로컬 CPU");
    await decision.getByRole("button", { name: "승인" }).click();
    await expect(decision).toContainText("승인됨");
    await expect(stageLink("연구 진행")).toBeVisible();
  });

  await test.step("작업자가 끝낸 작업의 자기 보고·산출물·연결된 연구 노드를 확인한다", async () => {
    const rows = watcher
      .getByRole("list", { name: "작업 목록" })
      .getByRole("link");
    await expect(rows).toHaveCount(2, runs);
    for (const row of [rows.nth(0), rows.nth(1)])
      await expect(row.getByTestId("task-status")).toHaveText("완료", runs);
    await watcher.close();

    await page.goto(orgPath("/tasks"));
    await page
      .getByRole("list", { name: "작업 목록" })
      .getByRole("link", { name: /연구 문제 정리 1/ })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "연구 문제 정리 1"
    );
    const report = page.getByRole("region", { name: "자기 보고" });
    await expect(report).toContainText("검증된 결과가 아닙니다");
    await expect(report.getByTestId("task-report")).toContainText(
      "메모를 산출물로 남겼습니다"
    );

    await page
      .getByRole("region", { name: "산출물" })
      .getByRole("link", { name: /연구 문제 정리 1 메모/ })
      .click();
    await expect(page.getByTestId("artifact-content")).toContainText(
      "# 연구 문제 정리 1 메모"
    );
    await expect(main).toContainText(
      "산출물이 있다고 결과가 확인된 것은 아닙니다"
    );
    await page.goBack();

    const node = page.getByRole("region", { name: "연결된 연구 노드" });
    await expect(node).toContainText("연구 문제 · 제안됨");
    await node.getByRole("link").click();
    await expect(page).toHaveURL(/\/map\?node=[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("complementary", { name: "노드 상세" })
    ).toContainText("연구 문제 정리 1");
    // 작업과 산출물이 있어도 연구는 끝나지 않았다.
    await expect(stageLink("연구 진행")).toBeVisible();
  });

  await test.step("Lead의 heartbeat를 켜서 다음 시각을 보고 끈다", async () => {
    await page.goto(orgPath("/agents"));
    await page
      .getByRole("region", { name: "Research Lead" })
      .getByRole("link")
      .click();
    const heartbeat = page.getByRole("region", { name: "Heartbeat" });
    const toggle = heartbeat.getByRole("checkbox", { name: "heartbeat 켜기" });
    const save = heartbeat.getByRole("button", { name: "저장" });
    await toggle.check();
    await save.click();
    await expect(heartbeat.getByRole("status")).toContainText("다음 heartbeat");
    await toggle.uncheck();
    await save.click();
    await expect(heartbeat.getByRole("status")).toHaveText("꺼져 있습니다.");
  });

  await test.step("조직 설정에서 작업자 추가 승인 정책을 켠다", async () => {
    await page.goto(orgPath("/settings"));
    const policy = page
      .getByRole("region", { name: "승인 정책" })
      .getByRole("checkbox", { name: /작업자 추가/ });
    await expect(policy).not.toBeChecked();
    await policy.check();
    await expect(page.getByText("저장하는 중…")).toHaveCount(0);
    // 다시 불러와도 켜져 있으면 서버에 저장된 값이다.
    await page.reload();
    await expect(policy).toBeChecked();
  });

  await test.step("조직을 일시정지하고 작업자 추가를 부탁하면 메시지가 재개를 기다린다", async () => {
    await openWithLiveEvents(page, orgPath("/dashboard"));
    await controls.getByRole("button", { name: /조직 일시정지/ }).click();
    await expect(page.getByTestId("control-help")).toContainText(
      "연구 진행에서 멈춰 있습니다"
    );
    await expect(stageLink("일시정지")).toBeVisible();

    await page.goto(orgPath("/chat"));
    await expect(page.getByText("조직이 일시정지 중입니다")).toBeVisible();
    await send("작업자 추가: researcher");
    await expect(
      page
        .locator('[data-author="owner"]')
        .filter({ hasText: "작업자 추가: researcher" })
        .getByText("다음 실행 시도 대기")
    ).toBeVisible();
    await page.goto(orgPath("/agents"));
    await expect(workerTeam).toContainText("작업자 팀 2명");
  });

  await test.step("재개하면 Lead가 부탁을 받아 작업자 추가 승인을 요청하고, 팀은 승인 전까지 그대로다", async () => {
    await openWithLiveEvents(page, orgPath("/dashboard"));
    await controls.getByRole("button", { name: /조직 재개/ }).click();
    await expect(stageLink("연구 진행")).toBeVisible();

    await page.goto(orgPath("/chat"));
    await expect(
      leadSaid("작업자 추가 승인 정책이 켜져 있어 승인을 요청했습니다")
    ).toHaveCount(1, runs);
    await page.goto(orgPath("/agents"));
    await expect(workerTeam).toContainText("작업자 팀 2명");
  });

  await test.step("Inbox에서 작업자 추가를 승인하면 팀이 한 명 늘고 연구 단계는 그대로다", async () => {
    await openInbox(page);
    await attention
      .getByRole("link", { name: new RegExp(`작업자 추가 승인 요청.*${name}`) })
      .click();
    await expect(
      page.getByRole("region", { name: "추가할 작업자" })
    ).toContainText("연구원");
    await decision.getByRole("button", { name: "승인" }).click();
    await expect(decision).toContainText("작업자가 팀에 더해졌습니다");

    await page.goto(orgPath("/agents"));
    await expect(workerTeam).toContainText("작업자 팀 3명");
    await expect(stageLink("연구 진행")).toBeVisible();
  });

  await test.step("Lead에게 결과 제출을 부탁하고 결과 검토에서 요약·완료 기준·근거를 본다", async () => {
    await openWithLiveEvents(page, orgPath("/chat"));
    await send("결과 제출 부탁해요");
    await expect(leadSaid("근거 산출물 2개와 함께 제출했습니다")).toHaveCount(
      1,
      runs
    );
    await expect(stageLink("결과 검토 중")).toBeVisible();

    await openInbox(page);
    const item = attention.getByRole("link").filter({ hasText: name });
    await expect(item).toContainText("결과 제출");
    await item.click();
    await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
    await expect(page).toHaveURL(
      /\/orgs\/[0-9a-f-]{36}\/results\/[0-9a-f-]{36}$/
    );
    await expect(main).toContainText("검토 대기");
    await expect(page.getByTestId("result-summary")).toContainText(
      "연구 문제 정리 1"
    );
    await expect(page.getByRole("region", { name: "완료 기준" })).toContainText(
      "유형 목록과 근거 메모"
    );
    await expect(
      page.getByRole("region", { name: "근거 산출물 2개" }).getByRole("link")
    ).toHaveCount(2);
  });

  await test.step("사용자가 최종 완료를 확정한다", async () => {
    await decision.getByRole("button", { name: "최종 완료" }).click();
    await decision.getByRole("button", { name: "최종 완료 확정" }).click();
    await expect(decision).toContainText("새 실행 시도가 시작되지 않습니다");
    await expect(decision.getByRole("button")).toHaveCount(0);
    await expect(stageLink("최종 완료")).toBeVisible();

    // 이 조직의 Inbox에는 더 결정할 것이 없다.
    await openInbox(page);
    const panel = page.getByRole("complementary", { name: "Inbox" });
    await panel.getByRole("button", { name: "현재 조직" }).click();
    await expect(panel).toContainText("주의가 필요한 항목이 없습니다.");
  });
});
