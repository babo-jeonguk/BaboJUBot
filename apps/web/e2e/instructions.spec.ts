import { expect, test, type Page } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

type Copy = { id: string; path: string; content: string; revision: number };

test("the owner edits an agent's Role copy, keeps the draft through a failure, a file switch and a conflict, and reads the old revision while another tab follows live", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "사본 편집 E2E 조직", ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const api = `/api/organizations/${org.id}/agents/${leadId}/instructions`;
  const copies = async () =>
    ((await (await page.request.get(api)).json()) as { copies: Copy[] }).copies;
  const original = (await copies()).find((c) => c.path === "AGENTS.md")!;

  await openWithLiveEvents(page, `/orgs/${org.id}/agents/${leadId}`);
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(
    other,
    `/orgs/${org.id}/agents/${leadId}/instructions`
  );

  // 개요에서 Role·Soul·Skill 탭으로. 주소가 탭을 정한다.
  await page
    .getByRole("navigation", { name: "에이전트 상세 탭" })
    .getByRole("link", { name: "Role·Soul·Skill" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/agents/${leadId}/instructions$`));
  const section = (p: Page) =>
    p.getByRole("region", { name: "Role·Soul·Skill 사본" });
  await expect(section(page)).toBeVisible();
  const revisions = (p: Page) =>
    section(p)
      .getByRole("region", { name: "revision 목록" })
      .getByRole("button");
  await expect(revisions(page)).toHaveCount(1);
  await expect(revisions(page).first()).toContainText("revision 1");
  await expect(revisions(page).first()).toContainText("복사로 생김");

  // 편집을 시작한다.
  await section(page).getByRole("button", { name: "✎ 편집" }).click();
  const editor = section(page).getByRole("textbox", { name: "AGENTS.md 편집" });
  await expect(editor).toHaveValue(original.content);
  const edited = "# 고친 Research Lead\n\n작업자에게 근거를 먼저 요구한다.\n";
  await editor.fill(edited);
  await expect(section(page)).toContainText("저장하지 않은 편집이 있습니다");

  // 저장하지 않은 편집이 있으면 다른 파일이나 화면으로 옮기기 전에 묻고, 계속 편집하면 그대로다.
  const ask = page.getByRole("dialog", {
    name: "편집한 내용을 버릴까요?",
  });
  await section(page).getByRole("tab", { name: "Soul · SOUL.md" }).click();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "계속 편집" }).click();
  await expect(editor).toHaveValue(edited);
  await page
    .getByRole("navigation", { name: "에이전트 상세 탭" })
    .getByRole("link", { name: "개요" })
    .click();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/instructions$/);
  await expect(editor).toHaveValue(edited);

  // 브라우저 뒤로 가기도 같은 확인을 거친다.
  await page.goBack();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/instructions$/);
  await expect(editor).toHaveValue(edited);

  // 새로고침·탭 닫기는 브라우저 확인 창을 띄우고, 머무르면 편집 내용이 그대로다.
  let unloadPrompt: string | undefined;
  page.once("dialog", (dialog) => {
    unloadPrompt = dialog.type();
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => unloadPrompt).toBe("beforeunload");
  expect(page.isClosed()).toBe(false);
  await expect(editor).toHaveValue(edited);

  // 저장이 실패하면 편집 내용은 그대로다.
  let failed = false;
  await page.route(`**${api}/*`, (route) => {
    if (failed || route.request().method() !== "PUT") return route.continue();
    failed = true;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":{"code":"internal"}}',
    });
  });
  const save = section(page).getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect(section(page).getByRole("alert")).toContainText(
    "저장하지 못했습니다"
  );
  await expect(editor).toHaveValue(edited);

  // 저장하면 revision 2가 생기고 다른 탭(390px)도 새로고침 없이 따라온다.
  await save.click();
  for (const p of [page, other]) {
    await expect(section(p).getByTestId("copy-revision")).toHaveText("2");
    await expect(section(p).getByRole("tabpanel")).toContainText(
      "작업자에게 근거를 먼저 요구한다."
    );
    await expect(revisions(p)).toHaveCount(2);
    await expect(revisions(p).first()).toContainText("revision 2");
    await expect(revisions(p).first()).toContainText("사용자");
  }
  await expect(editor).toHaveCount(0);

  // 예전 revision은 읽기 전용으로 본다.
  await revisions(other).filter({ hasText: "revision 1" }).click();
  const view = section(other).getByTestId("revision-view");
  await expect(view).toContainText("revision 1 · 읽기 전용");
  await expect(view).toContainText(
    "You are the Research Lead of one research organization"
  );
  await expect(
    section(other).locator("textarea, input, [contenteditable]")
  ).toHaveCount(0);
  await view.getByRole("button", { name: "지금 사본으로" }).click();
  await expect(section(other).getByTestId("revision-view")).toHaveCount(0);

  // 편집하는 동안 다른 곳에서 먼저 저장하면 충돌을 알리고 편집 내용을 지키며, 명시적으로 다시 저장할 수 있다.
  await section(page).getByRole("button", { name: "✎ 편집" }).click();
  const mine = edited + "\n충돌 중에도 남아야 하는 줄\n";
  await editor.fill(mine);
  const elsewhere = await page.request.put(`${api}/${original.id}`, {
    data: { content: "# 다른 탭이 먼저 저장\n", expectedRevision: 2 },
  });
  expect(elsewhere.status()).toBe(200);
  const conflict = section(page).getByRole("alert");
  await expect(conflict).toContainText(
    "다른 곳에서 먼저 저장했습니다 (revision 3)"
  );
  await expect(save).toBeDisabled();
  await expect(editor).toHaveValue(mine);
  // 편집 중에도 먼저 저장된 revision을 읽어 보고, 돌아오면 편집 내용이 그대로다.
  await revisions(page).filter({ hasText: "revision 3" }).click();
  const latest = section(page).getByTestId("revision-view");
  await expect(latest).toContainText("다른 탭이 먼저 저장");
  await latest.getByRole("button", { name: "편집으로 돌아가기" }).click();
  await expect(editor).toHaveValue(mine);
  await conflict
    .getByRole("button", { name: "revision 3 위에 이 편집 저장" })
    .click();
  await expect(section(page).getByTestId("copy-revision")).toHaveText("4");
  expect((await copies()).find((c) => c.id === original.id)).toMatchObject({
    content: mine,
    revision: 4,
  });

  // 뒤로 가기에서 편집을 버리면 이전 화면(개요)으로 가고 사본은 그대로다.
  await section(page).getByRole("button", { name: "✎ 편집" }).click();
  await editor.fill("버릴 편집");
  await page.goBack();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "버리기" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${leadId}$`));
  await expect(page.getByRole("region", { name: "Heartbeat" })).toBeVisible();
  expect((await copies()).find((c) => c.id === original.id)).toMatchObject({
    content: mine,
    revision: 4,
  });

  // 저장한 편집은 활동에 남는다.
  await page.goto(`/orgs/${org.id}/activity`);
  await expect(
    page.locator('[data-event-type="instruction_copy.edited"]')
  ).toHaveCount(3);
});
