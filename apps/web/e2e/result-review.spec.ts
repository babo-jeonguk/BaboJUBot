import { expect, test } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

test("the owner reviews a submitted result from the Inbox, requests changes, and finally completes the research", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const name = "결과 검토 E2E 조직";
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
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
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/tasks"));
      return ((await res.json()) as { status: string }[]).filter(
        (t) => t.status === "completed"
      ).length;
    }, runs)
    .toBe(2);

  // Lead에게 결과 제출을 부탁하면 결과 제출이 새로고침 없이 Inbox에 뜬다.
  await openWithLiveEvents(page, "/inbox");
  await page.request.post(api("/messages"), {
    data: { body: "결과 제출 부탁해요" },
  });
  const item = page
    .getByRole("list", { name: "주의 필요" })
    .getByRole("link")
    .filter({ hasText: name });
  await expect(item).toContainText("결과 제출", runs);
  await item.click();
  await expect(page).toHaveURL(
    /\/inbox\/[0-9a-f-]{36}\/result_submission\/[0-9a-f-]{36}$/
  );
  await page.getByRole("link", { name: /원래 화면에서 자세히 보기/ }).click();
  await expect(page).toHaveURL(
    /\/orgs\/[0-9a-f-]{36}\/results\/[0-9a-f-]{36}$/
  );
  const firstUrl = page.url();

  // 결과 검토 화면: 제출 요약, 제출 때의 완료 기준, 근거 산출물.
  const main = page.getByRole("main");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("결과 제출");
  await expect(main).toContainText("검토 대기");
  await expect(page.getByTestId("result-summary")).toContainText(
    "연구 문제 정리 1"
  );
  await expect(page.getByRole("region", { name: "완료 기준" })).toContainText(
    "유형 목록"
  );
  const evidence = page.getByRole("region", { name: "근거 산출물 2개" });
  await expect(evidence.getByRole("link")).toHaveCount(2);
  await evidence.getByRole("link", { name: /연구 문제 정리 1 메모/ }).click();
  await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}$/);
  await expect(
    page
      .getByTestId("artifact-content")
      .getByRole("heading", { name: "연구 문제 정리 1 메모" })
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(firstUrl);

  // 수정 요청은 의견이 있어야 보낼 수 있고, 전송에 실패하면 의견을 그대로 둔다.
  const decision = page.getByRole("region", { name: "결정" });
  const requestChanges = decision.getByRole("button", { name: "수정 요청" });
  await expect(requestChanges).toBeDisabled();
  await decision.getByLabel(/의견/).fill("한계도 적어 주세요");
  await page.route("**/api/organizations/*/results/*/decision", (route) =>
    route.fulfill({ status: 500, body: "{}" })
  );
  await requestChanges.click();
  await expect(decision.getByRole("alert")).toContainText("보내지 못했습니다");
  await expect(decision.getByLabel(/의견/)).toHaveValue("한계도 적어 주세요");
  await page.unrouteAll({ behavior: "wait" });

  // 수정 요청: 결정 기록이 남고, Lead가 의견을 반영해 다시 제출한 결과가 새로고침 없이 이어진다.
  await requestChanges.click();
  await expect(decision).toContainText("수정 요청됨");
  await expect(decision).toContainText("의견: 한계도 적어 주세요");
  const next = main.getByRole("link", { name: "다시 제출된 결과 보기" });
  await expect(next).toBeVisible(runs);
  await next.click();
  await expect(page).not.toHaveURL(firstUrl);
  await expect(main).toContainText("검토 대기");
  await expect(page.getByTestId("result-summary")).toContainText(
    "반영한 수정 의견: 한계도 적어 주세요"
  );
  await expect(
    main.getByRole("link", { name: "직전 제출 보기" })
  ).toBeVisible();
  const secondUrl = page.url();

  // 다시 제출한 Lead 실행 시도의 상세에는 수정 요청 사유와 의견이 보인다.
  const leadRuns = (await (await page.request.get(api("/runs"))).json()) as {
    id: string;
  }[];
  await page.goto(`/orgs/${org.id}/runs/${leadRuns[0]!.id}`);
  await expect(main).toContainText("결과 수정 요청");
  await expect(main).toContainText("한계도 적어 주세요");
  await page.goto(secondUrl);

  // 좁은 화면에서도 결정 버튼에 닿는다.
  await page.setViewportSize({ width: 390, height: 844 });
  const complete = decision.getByRole("button", { name: "최종 완료" });
  await complete.scrollIntoViewIfNeeded();
  await expect(complete).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 800 });

  // 다른 탭에서 Inbox 상세(요약)로 최종 완료하면 이 화면도 새로고침 없이 결정 기록으로 바뀐다.
  const other = await browser.newPage();
  await other.goto(
    `/inbox/${org.id}/result_submission/${secondUrl.split("/").pop()}`
  );
  await expect(other.getByRole("region", { name: "결과 요약" })).toContainText(
    "반영한 수정 의견: 한계도 적어 주세요"
  );
  await expect(
    other.getByRole("region", { name: /근거 산출물 \d+개/ })
  ).toBeVisible();
  const otherDecision = other.getByRole("region", { name: "결정" });
  await otherDecision.getByRole("button", { name: "최종 완료" }).click();
  await otherDecision
    .getByRole("group", { name: "최종 완료할까요?" })
    .getByRole("button", { name: "최종 완료" })
    .click();
  await expect(otherDecision).toContainText("연구를 최종 완료했습니다");
  await expect(otherDecision).toBeFocused();
  await other.close();
  await expect(decision).toContainText("최종 완료", runs);
  await expect(decision.getByRole("button")).toHaveCount(0);
  await expect(main).toContainText("지금 조직 단계");
  await expect(main.getByText("최종 완료").first()).toBeVisible();

  // 최종 완료 뒤 메시지를 보내도 새 실행 시도가 시작되지 않는다.
  const runCount = async () =>
    ((await (await page.request.get(api("/runs"))).json()) as unknown[]).length;
  const before = await runCount();
  await page.request.post(api("/messages"), {
    data: { body: "완료 뒤 메시지" },
  });
  await page.waitForTimeout(1_000);
  expect(await runCount()).toBe(before);

  // 결과 검토 목록에는 두 제출과 각 결정이 남고, Inbox에서도 주의 필요에서만 빠져 전체에 결정 상태와 함께 남는다.
  await page.goto(`/orgs/${org.id}/review`);
  const list = page.getByRole("list", { name: "결과 제출" });
  await expect(list.getByRole("link")).toHaveCount(2);
  await expect(list.getByRole("link").nth(0)).toContainText("최종 완료");
  await expect(list.getByRole("link").nth(1)).toContainText("수정 요청됨");
  await page.goto("/inbox");
  const panel = page.getByRole("complementary", { name: "Inbox" });
  await expect(
    panel.getByRole("list", { name: "주의 필요" }).filter({ hasText: name })
  ).toHaveCount(0);
  await panel.getByRole("button", { name: /^전체 \d/ }).click();
  const kept = panel
    .getByRole("list", { name: "전체" })
    .getByRole("listitem")
    .filter({ hasText: name })
    .filter({ hasText: "결과 제출" });
  await expect(kept).toHaveCount(2);
  await expect(kept.filter({ hasText: "최종 완료" })).toHaveCount(1);
  await expect(kept.filter({ hasText: "수정 요청됨" })).toHaveCount(1);
});

test("shows a missing result submission as not found", async ({ page }) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "없는 결과 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  await page.goto(`/orgs/${org.id}/results/${crypto.randomUUID()}`);
  await expect(page.getByText("찾을 수 없는 결과 제출")).toBeVisible();
  await page.goto(`/orgs/${org.id}/review`);
  await expect(page.getByRole("main")).toContainText(
    "아직 제출된 결과가 없습니다"
  );
});
