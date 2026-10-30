import { expect, test, type Page } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

// 승인 상세에서 작업자마다 프로바이더·모델을 바꿔 승인하고 결정 뒤 비교를 보는 흐름과 `GitHub에 올리기` 정책 스위치(#95).
// E2E 서버는 같은 가짜 adapter의 연결 둘(`fake` 가짜 프로바이더, `fake-2` 가짜 프로바이더 2)을 쓴다.

const runs = { timeout: 20_000 };

test("the owner changes one worker's model on the approval detail, reverts and changes it again, approves, and sees the Lead's proposal beside the decision", async ({
  page,
}) => {
  // 가짜 Lead는 프로바이더를 비워 제안하므로 요청 때의 작업자 기본값이 Lead 제안이 된다.
  await page.request.put("/api/providers/defaults", {
    data: {
      leadDefault: { provider: "fake", model: null },
      workerDefault: { provider: "fake", model: null },
    },
  });
  const created = await page.request.post("/api/organizations", {
    data: { name: "작업자 프로바이더 E2E 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/approvals"));
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    }, runs)
    .not.toBe("");

  await openWithLiveEvents(page, `/orgs/${org.id}/approvals/${approvalId}`);
  const decision = page.getByRole("region", { name: "결정" });
  const rows = decision.getByTestId("worker-choice");
  await expect(rows).toHaveCount(2);
  const second = rows.nth(1);
  const model = decision.getByLabel("연구원 2번 모델");
  await expect(decision.getByLabel("연구원 1번 프로바이더")).toHaveValue(
    "fake"
  );
  await expect(model).toHaveValue("");

  // 바꾼 줄에만 `변경` 배지와 되돌리기가 붙고, 되돌리면 Lead 제안으로 돌아간다.
  await model.selectOption({ label: "맥스" });
  await expect(second).toContainText("변경");
  await expect(rows.nth(0)).not.toContainText("변경");
  await decision.getByRole("button", { name: "연구원 2번 되돌리기" }).click();
  await expect(model).toHaveValue("");
  await expect(second).not.toContainText("변경");

  // 프로바이더를 바꾸면 모델은 기본 모델이 된다. 화면을 떠났다 돌아와도 바꾼 값은 초안으로 남는다.
  await model.selectOption({ label: "맥스" });
  await decision
    .getByLabel("연구원 2번 프로바이더")
    .selectOption({ label: "가짜 프로바이더 2" });
  await expect(model).toHaveValue("");
  await model.selectOption({ label: "미니" });
  await page.getByRole("link", { name: "설정" }).first().click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await expect(decision.getByLabel("연구원 2번 모델")).toHaveValue(
    "fake-2-mini"
  );
  await expect(second).toContainText("변경");
  // 첫 작업자는 프로바이더만 바꾼다. 모델은 두 쪽 모두 기본 모델이다.
  await decision
    .getByLabel("연구원 1번 프로바이더")
    .selectOption({ label: "가짜 프로바이더 2" });

  await decision.getByRole("button", { name: "승인" }).click();
  const decided = decision.getByTestId("decided-worker");
  await expect(decided).toHaveCount(2);
  await expect(decided.nth(0)).toContainText("연구원 1");
  await expect(decided.nth(1)).toContainText("연구원 2");
  const cells = decided.nth(1).locator("td");
  const lead = cells.nth(1);
  const chosen = cells.nth(2);
  await expect(lead).toContainText("가짜 프로바이더");
  await expect(lead).toContainText("기본 모델");
  await expect(chosen).toContainText("가짜 프로바이더 2");
  await expect(chosen).toContainText("미니");
  // 프로바이더를 바꿨으니 프로바이더와 모델 칸 모두 `변경`이다.
  await expect(chosen.locator("[data-changed]")).toHaveCount(2);
  await expect(chosen.locator("[data-changed]").first()).toContainText("변경");
  // 프로바이더만 바꾼 작업자는 프로바이더 칸에만 `변경`이 붙는다.
  const firstChanged = decided.nth(0).locator("[data-changed]");
  await expect(firstChanged).toHaveCount(1);
  await expect(firstChanged).toContainText("가짜 프로바이더 2");

  // 결정대로 작업자가 생겼다.
  const detail = (await (await page.request.get(api(""))).json()) as {
    agents: { role: string; name: string; provider: string; model: string }[];
  };
  expect(
    detail.agents
      .filter((a) => a.role === "worker")
      .map((a) => [a.name, a.provider, a.model])
  ).toEqual([
    ["연구원 1", "fake-2", null],
    ["연구원 2", "fake-2", "fake-2-mini"],
  ]);

  // 좁은 화면에서도 결정 뒤 비교가 보인다.
  await page.setViewportSize({ width: 390, height: 844 });
  await decided.nth(1).scrollIntoViewIfNeeded();
  await expect(decided.nth(1)).toBeInViewport();
});

test("the owner turns the GitHub publishing policy on and off in settings, and another tab follows", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "GitHub 정책 E2E 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  await openWithLiveEvents(page, `/orgs/${org.id}/settings`);
  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(other, `/orgs/${org.id}/settings`);
  const github = (p: Page) =>
    p
      .getByRole("region", { name: "승인 정책" })
      .getByRole("checkbox", { name: "GitHub에 올리기" });
  const addWorker = (p: Page) =>
    p
      .getByRole("region", { name: "승인 정책" })
      .getByRole("checkbox", { name: "작업자 추가" });
  await expect(github(page)).not.toBeChecked();
  await expect(github(other)).not.toBeChecked();

  await github(page).check();
  await expect(github(page)).toBeChecked();
  await expect(github(other)).toBeChecked();
  // 다른 항목은 그대로다.
  await expect(addWorker(page)).not.toBeChecked();
  await page.reload();
  await expect(github(page)).toBeChecked();

  await github(other).uncheck();
  await expect(github(other)).not.toBeChecked();
  await expect(github(page)).not.toBeChecked();

  // 바꿀 때마다 조직 활동에 남는다.
  await page.goto(`/orgs/${org.id}/activity`);
  const stream = page.getByRole("list", { name: "활동 stream" });
  for (const done of ["켰습니다", "껐습니다"])
    await expect(
      stream.getByText(`사용자가 승인 정책 “GitHub에 올리기”를 ${done}`)
    ).toBeVisible(runs);
});
