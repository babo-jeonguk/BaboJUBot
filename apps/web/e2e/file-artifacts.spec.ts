import { expect, test } from "@playwright/test";

// The HTTP integration tests cover registration and persistence; this browser fixture exercises both file displays and routing.
test("file artifact rows retain their suffix at 390px and open preserved text or file metadata", async ({
  page,
}) => {
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
