import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents, pageLoad } from "./support/live-events.ts";
import { inboxOrganizationLinks, runsSettled } from "./support/organization.ts";
import { expectNoHorizontalOverflow } from "./support/layout.ts";

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
  // 사용자가 목표와 완료 기준을 적어 조직을 만들면 가짜 Lead가 깨어나 곧바로 초기 연구 승인을 요청한다.
  const created = await page.request.post("/api/organizations", {
    data: {
      name,
      goal: "음성 인식 오류율을 절반으로 줄인다",
      completionCriteria: "WER 10% 이하",
    },
  });
  const org = (await created.json()) as { id: string };

  await openWithLiveEvents(page, `/orgs/${org.id}/chat`);
  await runsSettled(page.request, org.id);
  await expect(
    page.getByRole("list", { name: "대화" }).locator('[data-author="agent"]')
  ).toContainText("초기 연구 승인을 요청했습니다");

  // Inbox → Inbox 상세(요약) → 원래 화면의 승인 요청 상세.
  await openInbox(page);
  const inbox = page.getByRole("list", { name: "주의 필요" });
  await inboxOrganizationLinks(inbox, org.id, new RegExp(name)).click();
  await expect(page).toHaveURL(
    /\/inbox\/[0-9a-f-]{36}\/approval\/[0-9a-f-]{36}$/
  );
  await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  const firstUrl = page.url();
  await expect(
    page.getByRole("region", { name: "연구 목표와 완료 기준" })
  ).toContainText("WER 10% 이하");
  // 사용자가 정한 완료 기준은 Lead 제안이 아니다.
  await expect(
    page.getByRole("region", { name: "연구 목표와 완료 기준" })
  ).not.toContainText("Lead 제안");
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
  // 환경 점검 결과는 환경 명세 칸 안의 표로 보인다.
  await expect(
    page.getByRole("region", { name: "연구 환경 명세" }).getByRole("table")
  ).toContainText("확인 불가");
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
  // 앞서 결정한 첫 요청 항목이 아직 목록에 남아 있을 수 있어, 첫 요청과 다른 승인 요청의 항목을 고른다.
  const firstId = firstUrl.split("/").pop()!;
  await inboxOrganizationLinks(inbox, org.id, new RegExp(name))
    .and(inbox.locator(`a[href*="/approval/"]:not([href$="/${firstId}"])`))
    .click();
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
  await expectNoHorizontalOverflow(page);
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
  /** 작업자의 Role·Soul·Skill 사본 화면을 열고 그 사본의 ID 자리를 돌려준다. */
  const openCopies = async (worker: string) => {
    await page.goto(`/orgs/${org.id}/agents`);
    await team.getByRole("link", { name: new RegExp(worker) }).click();
    await page
      .getByRole("navigation", { name: "에이전트 상세 탭" })
      .getByRole("link", { name: "Role·Soul·Skill" })
      .click();
    const copies = page.getByRole("region", { name: "Role·Soul·Skill 사본" });
    await expect(copies.getByRole("tab")).toHaveText(
      [
        "Role · AGENTS.md",
        "Soul · SOUL.md",
        "Skill · skills/record-research-node/SKILL.md",
      ],
      pageLoad
    );
    await expect(
      copies.getByRole("tabpanel").getByRole("heading", { name: "Researcher" })
    ).toBeVisible();
    await copies.getByRole("tab", { name: "Soul · SOUL.md" }).click();
    await expect(
      copies.getByRole("tabpanel").getByRole("heading", { name: "Soul" })
    ).toBeVisible();
    // 편집을 시작하기 전에는 편집 입력이 없다.
    await expect(
      copies.locator("textarea, input, [contenteditable]")
    ).toHaveCount(0);
    const id = copies.getByTestId("copy-id");
    await expect(id).toHaveText(/\S/);
    return id;
  };
  // 첫 사본의 ID는 다른 작업자의 화면으로 옮기기 전에 한 번 읽어 둔다(사본마다 정해진 값).
  const first = (await (await openCopies("연구원 1")).textContent())!;
  await expect(await openCopies("연구원 2")).not.toHaveText(first);

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

test("an organization created with empty completion criteria gets the Lead's proposal, which the owner approves from the Inbox", async ({
  page,
}) => {
  const name = "기준 제안 E2E 조직";
  await openWithLiveEvents(page, "/");
  await page
    .getByRole("navigation", { name: "연구 조직" })
    .getByRole("button", { name: "새 연구 조직" })
    .click();
  const dialog = page.getByRole("dialog", { name: "새 연구 조직" });
  await dialog.getByLabel("조직 이름").fill(name);
  await dialog.getByLabel("연구 목표").fill("공개 자료로 오류 유형을 정리한다");
  await expect(dialog.getByLabel(/완료 기준/)).toHaveValue("");
  await dialog.getByRole("button", { name: "만들기" }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/chat$/);
  const orgId = new URL(page.url()).pathname.split("/")[2]!;
  await runsSettled(page.request, orgId);
  await expect(
    page.getByRole("list", { name: "대화" }).locator('[data-author="agent"]')
  ).toContainText("제가 제안한 완료 기준");

  // Inbox 상세의 요약에서 Lead가 제안한 완료 기준을 보고 승인한다.
  await openInbox(page);
  await inboxOrganizationLinks(
    page.getByRole("list", { name: "주의 필요" }),
    orgId,
    new RegExp(name)
  ).click();
  const criteria = page.getByTestId("proposal-completion-criteria");
  await expect(criteria).toContainText("Lead 제안");
  await expect(criteria).toContainText(
    "“공개 자료로 오류 유형을 정리한다”을 달성했음을 보여 주는 결과 요약과 근거 산출물이 있다"
  );
  const decision = page.getByRole("region", { name: "결정" });
  await decision.getByRole("button", { name: "승인" }).click();
  await expect(decision).toContainText("승인됨");

  // 원래 화면도 Lead 제안으로 표시하고, 승인한 제안이 조직의 완료 기준이 된다.
  await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
  await expect(page.getByTestId("proposal-completion-criteria")).toContainText(
    "Lead 제안"
  );
  await page.goto(`/orgs/${orgId}`);
  await expect(page.getByTestId("completion-criteria")).toContainText(
    "결과 요약과 근거 산출물이 있다"
  );
});
