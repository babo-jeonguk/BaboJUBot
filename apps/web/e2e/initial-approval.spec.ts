import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

/** 레일의 Inbox 버튼으로 Inbox 패널을 연다. 이미 열려 있으면 그대로 둔다(버튼은 여닫기). */
async function openInbox(page: Page) {
  const button = page
    .getByRole("navigation", { name: "연구 조직" })
    .getByRole("button", { name: /^Inbox/ });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
}

test("the owner reviews the initial research request from the Inbox, asks for changes, approves the resubmission and sees the team with their own copies", async ({
  page,
}) => {
  const name = "승인 E2E 조직";
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const org = (await created.json()) as { id: string };

  // Lead 대화에서 목표를 합의하면 가짜 Lead가 기록하고 초기 연구 승인을 요청한다.
  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  await page
    .getByLabel("Lead에게 보낼 메시지")
    .fill("목표: 음성 인식 오류율을 절반으로 줄인다\n완료 기준: WER 10% 이하");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(
    page.getByRole("list", { name: "대화" }).locator('[data-author="agent"]')
  ).toContainText("초기 연구 승인을 요청했습니다");

  // Inbox → Inbox 상세(요약) → 원래 화면의 승인 요청 상세.
  await openInbox(page);
  const inbox = page.getByRole("list", { name: "주의 필요" });
  await inbox.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page).toHaveURL(
    /\/inbox\/[0-9a-f-]{36}\/approval\/[0-9a-f-]{36}$/
  );
  await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  const firstUrl = page.url();
  await expect(
    page.getByRole("region", { name: "연구 목표와 완료 기준" })
  ).toContainText("WER 10% 이하");
  await expect(
    page.getByRole("region", { name: "초기 연구 계획" })
  ).toContainText("음성 인식 오류율을 절반으로 줄인다");
  await expect(page.getByRole("region", { name: "팀 구성" })).toContainText(
    "연구원"
  );
  await expect(page.getByRole("region", { name: "팀 구성" })).toContainText(
    "2명"
  );
  await expect(
    page.getByRole("region", { name: "연구 환경 명세" })
  ).toContainText("compute");
  await expect(
    page.getByRole("region", { name: "연구 흐름 템플릿" })
  ).toContainText("가설·아이디어");

  // 수정 요청은 사유가 있어야 보낼 수 있고, 보내면 결정 receipt가 남는다.
  const decision = page.getByRole("region", { name: "결정" });
  await expect(
    decision.getByRole("button", { name: "수정 요청" })
  ).toBeDisabled();
  await decision.getByLabel(/결정 사유/).fill("데이터셋을 먼저 정해 주세요");
  await decision.getByRole("button", { name: "수정 요청" }).click();
  await expect(decision).toContainText("수정 요청됨");
  await expect(decision).toContainText("데이터셋을 먼저 정해 주세요");
  await expect(decision.getByRole("button")).toHaveCount(0);

  // Lead가 사유를 받아 다시 제출한 새 요청이 Inbox에 새로고침 없이 나타난다.
  // 이번에는 Inbox 상세의 요약에서 결정한다. 계획은 앞부분만 보이고 줄였다는 안내가 있다.
  await openInbox(page);
  await inbox.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page).toHaveURL(
    /\/inbox\/[0-9a-f-]{36}\/approval\/[0-9a-f-]{36}$/
  );
  const summaryUrl = page.url();
  // 다시 제출된 요청은 새 승인 요청이다.
  expect(summaryUrl.split("/").pop()).not.toBe(firstUrl.split("/").pop());
  const main = page.getByRole("main");
  await expect(main).toContainText("다시 제출됨");
  await expect(
    page.getByRole("region", { name: "연구 목표와 완료 기준" })
  ).toContainText("WER 10% 이하");
  await expect(page.getByRole("region", { name: "팀 구성" })).toContainText(
    "연구원 2명"
  );
  const plan = page.getByRole("region", { name: "초기 연구 계획" });
  await expect(plan).toContainText("데이터셋을 먼저 정해 주세요");
  await expect(plan).toContainText("전문은 원래 화면에서");
  await expect(
    page.getByRole("region", { name: "연구 흐름 템플릿" })
  ).toBeVisible();

  // 좁은 화면에서도 요약의 결정 영역에 닿고, 결정하면 그 자리에 결정 기록이 남는다(다음 항목으로 가지 않는다).
  await page.setViewportSize({ width: 390, height: 844 });
  await decision.scrollIntoViewIfNeeded();
  await expect(decision.getByRole("button", { name: "승인" })).toBeInViewport();
  await decision.getByRole("button", { name: "승인" }).click();
  await expect(decision).toContainText("승인됨");
  await expect(decision).toBeFocused();
  await expect(page).toHaveURL(summaryUrl);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  // 원래 화면도 같은 결정 기록이다.
  await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  await expect(decision).toContainText("승인됨");
  await expect(
    page.getByRole("link", { name: "직전 요청 보기" })
  ).toBeVisible();

  // 승인으로 생긴 팀이 에이전트 화면에 보인다.
  await decision.getByRole("link", { name: "팀 보기" }).click();
  const team = page.getByRole("region", { name: "조직도" });
  await expect(team).toContainText("작업자 2명");
  const copyIdOf = async (worker: string) => {
    await page.goto(`/orgs/${org.id}/agents`);
    await team.getByRole("link", { name: new RegExp(worker) }).click();
    await page
      .getByRole("navigation", { name: "에이전트 상세 탭" })
      .getByRole("link", { name: "Role·Soul·Skill" })
      .click();
    const copies = page.getByRole("region", { name: "Role·Soul·Skill 사본" });
    await expect(copies.getByRole("tab")).toHaveText([
      "Role · AGENTS.md",
      "Soul · SOUL.md",
      "Skill · skills/record-research-node/SKILL.md",
    ]);
    await expect(copies.getByRole("tabpanel")).toContainText("# 연구원");
    await copies.getByRole("tab", { name: "Soul · SOUL.md" }).click();
    await expect(copies.getByRole("tabpanel")).toContainText("# Soul");
    // 편집을 시작하기 전에는 편집 입력이 없다.
    await expect(
      copies.locator("textarea, input, [contenteditable]")
    ).toHaveCount(0);
    return copies.getByTestId("copy-id").textContent();
  };
  const first = await copyIdOf("연구원 1");
  const second = await copyIdOf("연구원 2");
  expect(first).toBeTruthy();
  expect(first).not.toBe(second);

  // 조직 대시보드에 단계와 목표·완료 기준이 보인다.
  await page.goto(`/orgs/${org.id}`);
  await expect(page.getByTestId("goal")).toHaveText(
    "음성 인식 오류율을 절반으로 줄인다"
  );
  await expect(page.getByTestId("completion-criteria")).toHaveText(
    "WER 10% 이하"
  );
  await expect(
    page.getByRole("main").getByText("연구 진행", { exact: true })
  ).toBeVisible();
});
