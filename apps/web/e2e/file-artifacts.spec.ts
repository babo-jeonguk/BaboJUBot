import { expect, test, type Page } from "@playwright/test";

async function openArtifactsFixture(
  page: Page,
  extraArtifacts: { id: string; name: string }[] = []
) {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const agentId = "33333333-3333-4333-8333-333333333333";
  const runId = "44444444-4444-4444-8444-444444444444";
  const artifacts = [
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "보존 보고서",
      format: "markdown",
      content: "# 등록 시점 보고서\n\n변경 전 근거",
      file: {
        name: "한글로_작성한_아주_긴_실험결과_정리_최종_보고서_2026.md",
        path: "reports/보고서.md",
        mediaType: "text/markdown",
        size: 42,
      },
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      title: "실험 이미지",
      format: "binary",
      content: "",
      file: {
        name: "figure.png",
        path: "results/figure.png",
        mediaType: "image/png",
        size: 2048,
      },
    },
    ...extraArtifacts.map(({ id, name }) => ({
      id,
      title: name,
      format: "binary",
      content: "",
      file: {
        name,
        path: `results/${name}`,
        mediaType: "application/octet-stream",
        size: 1024,
      },
    })),
  ].map((a) => ({
    ...a,
    organizationId: orgId,
    taskId,
    createdByAgentId: agentId,
    createdByRunId: runId,
    createdAt: "2026-11-01T00:00:00.000Z",
  }));
  // Use an actual organization for the shell; only artifact responses are fixtures.
  const created = await page.request.post("/api/organizations", {
    data: { name: "파일 화면", goal: "파일 검증" },
  });
  const org = await created.json();
  const actual = artifacts.map((a) => ({ ...a, organizationId: org.id }));
  await page.route(`**/api/organizations/${org.id}/artifacts`, (route) =>
    route.fulfill({ json: actual.map(({ content: _content, ...a }) => a) })
  );
  await page.route(`**/api/organizations/${org.id}/artifacts/*`, (route) =>
    route.fulfill({
      json: actual.find((a) => route.request().url().endsWith(a.id)),
    })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/orgs/${org.id}/artifacts`);
  const row = page.getByRole("link", {
    name: new RegExp(actual[0]!.file.name),
  });
  return { org, actual, row };
}

// The HTTP integration tests cover registration and persistence; this browser fixture exercises both file displays and routing.
test("file artifact rows retain their suffix at 390px and open preserved text or file metadata", async ({
  page,
}) => {
  const { org, actual, row } = await openArtifactsFixture(page);
  await expect(row).toBeVisible();
  await expect(row).toContainText("42 B");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await row.focus();
  await expect(page.getByRole("tooltip")).toContainText(actual[0]!.file.name);
  await row.blur();
  await row.hover();
  await expect(page.getByRole("tooltip")).toContainText(actual[0]!.file.name);
  await page.screenshot({ path: "/tmp/issue-97-files-390.png" });
  await row.click();
  await expect(page.getByTestId("artifact-content")).toContainText(
    "등록 시점 보고서"
  );
  await page.goto(`/orgs/${org.id}/artifacts/${actual[1]!.id}`);
  await expect(page.getByLabel("파일 정보")).toContainText("image/png");
  await expect(page.getByLabel("파일 정보")).toContainText("2.0 KB");
  await expect(page.getByLabel("파일 정보")).toContainText(
    "results/figure.png"
  );
  await expect(page.getByTestId("artifact-content")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/issue-97-binary-390.png" });
});

test("a file name tooltip opens again on hover right after closing, even when its open animation was not observed", async ({
  page,
}) => {
  // Presence records the animation name from an animationstart listener on the content node.
  // Hide the event from it so the closed content keeps its animation and lingers, as on a slow CI runner.
  await page.addInitScript(() => {
    window.addEventListener(
      "animationstart",
      (event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.getAttribute("role") === "tooltip"
        ) {
          event.stopImmediatePropagation();
        }
      },
      true
    );
  });
  const { actual, row } = await openArtifactsFixture(page);
  const tooltip = page.getByRole("tooltip");
  await row.focus();
  await expect(tooltip).toContainText(actual[0]!.file.name);
  await expect(tooltip).toHaveAttribute("data-state", /(delayed|instant)-open/);
  await row.blur();
  await row.hover();
  await expect(tooltip).toContainText(actual[0]!.file.name);
  await expect(tooltip).toHaveAttribute("data-state", /(delayed|instant)-open/);
});

test("a keyboard-focused file name tooltip stays open while focusing scrolls the list, and closes on Escape or blur", async ({
  page,
}) => {
  const targetName =
    "아래쪽에서_키보드로_포커스하는_아주_긴_실험결과_파일_이름_2026.md";
  await openArtifactsFixture(page, [
    { id: "77777777-7777-4777-8777-777777777777", name: "채우기_파일_1.bin" },
    { id: "88888888-8888-4888-8888-888888888888", name: targetName },
    { id: "99999999-9999-4999-8999-999999999999", name: "채우기_파일_2.bin" },
  ]);
  // The helper sets a tall viewport; shrink it so the extra rows fall below the fold.
  await page.setViewportSize({ width: 390, height: 300 });
  const target = page.getByRole("link", { name: new RegExp(targetName) });
  const top = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    main.scrollTop = 0;
    return main.scrollTop;
  });
  await target.focus();
  await page.waitForFunction(
    (before) => document.querySelector("main")!.scrollTop !== before,
    top
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  );
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(targetName);
  await expect(tooltip).toHaveAttribute("data-state", /(delayed|instant)-open/);

  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);

  await target.blur();
  await target.focus();
  await expect(tooltip).toContainText(targetName);
  await target.blur();
  await expect(tooltip).toHaveCount(0);
});
