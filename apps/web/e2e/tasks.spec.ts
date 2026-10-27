import { expect, test } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

test("the owner watches tasks appear and complete live, reads the self-report and artifact, and comments to wake the worker", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "작업 E2E 조직" },
  });
  const org = (await created.json()) as { id: string };
  // 가짜 Lead가 목표를 기록하고 초기 연구 승인을 요청한다.
  await page.request.post(`/api/organizations/${org.id}/messages`, {
    data: { body: "목표: 오류 유형을 정리한다\n완료 기준: 유형 목록" },
  });
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(
        `/api/organizations/${org.id}/approvals`
      );
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    })
    .not.toBe("");

  await openWithLiveEvents(page, `/orgs/${org.id}/tasks`);
  await expect(page.getByRole("main")).toContainText("아직 작업이 없습니다");

  // 승인하면 가짜 Lead가 작업자마다 작업을 맡기고, 작업자가 완료한다. 새로고침 없이 목록에 보인다.
  await page.request.post(
    `/api/organizations/${org.id}/approvals/${approvalId}/decision`,
    { data: { decision: "approve" } }
  );
  // Lead와 작업자 실행 시도가 차례로 끝나야 하므로 화면 갱신을 조금 더 기다린다.
  const runs = { timeout: 20_000 };
  const list = page.getByRole("list", { name: "작업 목록" });
  const rows = list.getByRole("link");
  await expect(rows).toHaveCount(2, runs);
  await expect(rows.nth(0)).toContainText("연구 문제 정리 1");
  await expect(rows.nth(0)).toContainText("담당 연구원 1");
  await expect(rows.nth(1)).toContainText("담당 연구원 2");
  await expect(rows.nth(0).getByTestId("task-status")).toHaveText("완료", runs);

  // 작업 상세: 자기 보고 요약, 산출물, 작업자가 만들어 연결한 연구 노드.
  await rows.nth(0).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskUrl = page.url();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "연구 문제 정리 1"
  );
  await expect(page.getByTestId("task-assignee")).toHaveText("연구원 1");
  const report = page.getByRole("region", { name: "자기 보고" });
  await expect(report).toContainText("검증된 결과가 아닙니다");
  await expect(report.getByTestId("task-report")).toContainText(
    "메모를 산출물로 남겼습니다"
  );
  await expect(
    page.getByRole("region", { name: "연결된 연구 노드" })
  ).toContainText("연구 문제 · 제안됨");

  // 댓글은 담당자를 깨우고, 작업자의 답 댓글이 새로고침 없이 thread에 붙는다. 작업은 완료 그대로다.
  const comments = page.getByRole("region", { name: "댓글" });
  await comments.getByLabel("작업 댓글").fill("근거를 보강해 주세요");
  await comments.getByRole("button", { name: "댓글 달기" }).click();
  const thread = comments.getByRole("list", { name: "댓글 thread" });
  await expect(thread.locator('[data-author="owner"]')).toContainText(
    "근거를 보강해 주세요"
  );
  await expect(thread.locator('[data-author="agent"]')).toContainText(
    "댓글을 받았습니다",
    runs
  );
  await expect(thread.locator('[data-author="owner"]')).toContainText(
    "에 전달됨"
  );
  await expect(comments.getByLabel("작업 댓글")).toHaveValue("");
  await expect(page.getByRole("main").getByTestId("task-status")).toHaveText(
    "완료"
  );

  // 저장을 확인하지 못한 댓글은 입력을 지우지 않는다.
  await page.route(`**/api/organizations/${org.id}/tasks/*/comments`, (route) =>
    route.fulfill({ status: 500, body: "{}" })
  );
  await comments.getByLabel("작업 댓글").fill("저장 안 될 댓글");
  await comments.getByRole("button", { name: "댓글 달기" }).click();
  await expect(comments.getByRole("alert")).toContainText(
    "확인하지 못했습니다"
  );
  await expect(comments.getByLabel("작업 댓글")).toHaveValue("저장 안 될 댓글");
  await page.unrouteAll({ behavior: "wait" });

  // 산출물 단건 보기와 원 작업 복귀.
  const artifacts = page.getByRole("region", { name: "산출물" });
  await artifacts.getByRole("link", { name: /연구 문제 정리 1 메모/ }).click();
  await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}$/);
  // Markdown 산출물은 기호가 아니라 제목·목록으로 보인다.
  const content = page.getByTestId("artifact-content");
  await expect(
    content.getByRole("heading", { name: "연구 문제 정리 1 메모" })
  ).toBeVisible();
  await expect(content.getByRole("listitem")).toHaveCount(2);
  await expect(content).not.toContainText("#");
  await expect(page.getByRole("main")).toContainText(
    "산출물이 있다고 결과가 확인된 것은 아닙니다"
  );
  await page.reload();
  await expect(page.getByTestId("artifact-content")).toContainText(
    "검증된 결과가 아닙니다"
  );
  await page
    .getByLabel("출처")
    .getByRole("link", { name: "연구 문제 정리 1" })
    .click();
  await expect(page).toHaveURL(taskUrl);

  // 좁은 화면에서도 댓글 입력에 닿는다.
  await page.setViewportSize({ width: 390, height: 844 });
  await comments.getByLabel("작업 댓글").scrollIntoViewIfNeeded();
  await expect(comments.getByLabel("작업 댓글")).toBeInViewport();
  await expect(
    comments.getByRole("button", { name: "댓글 달기" })
  ).toBeVisible();
});

test("shows a missing task or artifact as not found", async ({ page }) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "없는 작업 조직" },
  });
  const org = (await created.json()) as { id: string };
  await page.goto(`/orgs/${org.id}/tasks/${crypto.randomUUID()}`);
  await expect(page.getByText("찾을 수 없는 작업")).toBeVisible();
  await page.goto(`/orgs/${org.id}/artifacts/${crypto.randomUUID()}`);
  await expect(page.getByText("찾을 수 없는 산출물")).toBeVisible();
});
