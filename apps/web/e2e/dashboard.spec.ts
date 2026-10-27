import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  const say = async (body: string) =>
    expect(
      (await page.request.post(api("/messages"), { data: { body } })).status()
    ).toBe(201);
  return { id: org.id, name, leadId, api, say };
}

test("the dashboard and home follow a running agent, metrics and the 14 days live, and the activity filters by agent", async ({
  page,
  context,
}) => {
  const org = await createOrganization(page, "대시보드 E2E 조직");
  const other = await createOrganization(page, "옆 대시보드 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
  const home = await context.newPage();
  await home.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(home, "/");

  const running = page.getByRole("region", { name: "실행 중인 에이전트" });
  await expect(running).toContainText("지금 실행 중인 에이전트가 없습니다");
  await expect(page.getByTestId("metric-success")).toContainText("—");
  // 14일 막대가 브라우저 시간대의 오늘까지 있다.
  const runChart = page.getByRole("figure", { name: "실행 시도" });
  await expect(runChart.locator("[data-date]")).toHaveCount(14);

  // 가짜 Lead는 `실행 유지 연습` 부탁을 받으면 취소될 때까지 실행 시도를 끝내지 않는다.
  await org.say("실행 유지 연습");
  const card = running.locator(`[data-agent-id="${org.leadId}"]`);
  await expect(card).toContainText("Research Lead", runs);
  await expect(card).toContainText("실행 중");
  await expect(running.getByTestId("running-agent-counts")).toHaveText(
    "실행 중 1"
  );
  await expect(page.getByTestId("metric-runs")).toContainText("실행 중 1");
  const today = runChart.locator("[data-date]").last();
  await expect(today).toHaveAttribute("aria-label", /실행 중 1/);
  // 막대는 keyboard focus로도 그날의 수를 보인다.
  await today.focus();
  await expect(runChart.getByRole("tooltip")).toContainText("(오늘)");
  await expect(
    page
      .getByRole("region", { name: "최근 활동" })
      .locator('[data-event-type="run.started"]')
  ).toHaveCount(1);

  // 홈은 조직 카드와 전체 수에 진행 중 실행 시도를 보인다. 전체 수는 서버의 실제 진행 중 수와 같다.
  const orgCard = (id: string) =>
    home.getByRole("main").locator(`a[href="/orgs/${id}"]`);
  const homeCard = orgCard(org.id);
  await expect(homeCard.getByTestId("organization-running")).toHaveText(
    "실행 중 1",
    runs
  );
  await expect(
    orgCard(other.id).getByTestId("organization-running")
  ).toHaveCount(0);
  const overview = (await (await page.request.get("/api/overview")).json()) as {
    runs: { running: number; cancelling: number };
  };
  await expect(home.getByTestId("running-run-count")).toHaveText(
    String(overview.runs.running - overview.runs.cancelling)
  );

  // 다른 조직의 대시보드에는 이 실행 시도가 없다.
  const otherTab = await context.newPage();
  await otherTab.goto(`/orgs/${other.id}/dashboard`);
  await expect(
    otherTab.getByRole("region", { name: "실행 중인 에이전트" })
  ).toContainText("지금 실행 중인 에이전트가 없습니다");
  await otherTab.close();

  // 실행 중 카드에서 그 에이전트의 활동으로 간다. 필터는 주소에 남고, 에이전트에 귀속되지 않은 조직 생성은 빠진다.
  await card.getByRole("link", { name: "활동 보기" }).click();
  await expect(page).toHaveURL(new RegExp(`/activity\\?agent=${org.leadId}$`));
  await expect(page.getByLabel("에이전트")).toHaveValue(org.leadId);
  const stream = page.getByRole("list", { name: "활동 stream" });
  await expect(stream.locator('[data-event-type="run.started"]')).toHaveCount(
    1
  );
  await expect(
    stream.locator('[data-event-type="organization.created"]')
  ).toHaveCount(0);
  await page.getByLabel("에이전트").selectOption("");
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/activity$`));
  await expect(
    stream.locator('[data-event-type="organization.created"]')
  ).toHaveCount(1);
  await page.goBack();
  await page.goto(`/orgs/${org.id}/dashboard`);

  // Lead를 일시정지하면 실행 시도가 취소되어 끝나고, 대시보드·홈의 실행 중이 새로고침 없이 사라진다.
  await expect(
    (
      await page.request.post(org.api(`/agents/${org.leadId}/pause`), {
        data: {},
      })
    ).status()
  ).toBe(200);
  await expect(running).toContainText(
    "지금 실행 중인 에이전트가 없습니다",
    runs
  );
  await expect(page.getByTestId("metric-runs")).toContainText("취소됨 1");
  await expect(homeCard.getByTestId("organization-running")).toHaveCount(
    0,
    runs
  );
  await page.request.post(org.api(`/agents/${org.leadId}/resume`), {
    data: {},
  });

  // 성공률은 완료 / (완료 + 실패)이며 취소는 세지 않는다. 취소만 있는 날은 0%가 아니라 —다.
  const rateChart = page.getByRole("figure", { name: "실행 성공률" });
  const rateToday = rateChart.locator("[data-date]").last();
  await expect(page.getByTestId("metric-success")).toContainText("—");
  await expect(rateToday).toHaveAttribute(
    "aria-label",
    /— \(완료·실패 없음, 취소 1 · 서버 재시작 0 제외\)/
  );
  await expect(rateToday).toContainText("—");
  // 실패 하나, 완료 하나가 차례로 반영된다. 0%인 날은 막대 자리를 남겨 —인 날과 구별한다.
  await org.say("실패 연습");
  await expect(page.getByTestId("metric-success")).toContainText("0%", runs);
  await expect(page.getByTestId("metric-success")).toContainText(
    "완료 0 · 실패 1"
  );
  await expect(rateToday).toHaveAttribute("aria-label", /0% \(완료 0 \/ 1,/);
  await expect(rateToday).not.toContainText("—");
  await org.say("안녕하세요");
  await expect(page.getByTestId("metric-success")).toContainText("50%", runs);
  await rateChart.getByText("숫자로 보기").click();
  await expect(rateChart.getByRole("table")).toContainText(
    "50% (완료 1 / 2, 취소 1 · 서버 재시작 0 제외)"
  );

  // 서버가 모르는 브라우저 시간대면 UTC로 잘라 보이고 그 사실을 밝힌다. 실행 환경의 시간대가 UTC여도 대체가 일어나게 브라우저 시간대를 정한다.
  const unknownZone = await context.newPage();
  await (
    await context.newCDPSession(unknownZone)
  ).send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Seoul" });
  await unknownZone.route(/\/dashboard\?timeZone=(?!UTC$)/, (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "invalid_time_zone" } }),
    })
  );
  await unknownZone.goto(`/orgs/${org.id}/dashboard`);
  await expect(
    unknownZone.getByRole("region", { name: "14일 차트" })
  ).toContainText("UTC 기준");
  await expect(unknownZone.getByTestId("metric-success")).toContainText("50%");
  await unknownZone.close();

  // 좁은 화면에서도 대시보드가 가로로 넘치지 않는다.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("metric-runs")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
