import { expect, type Locator, type Page } from "@playwright/test";
import { withServerClock } from "./support/isolated-server.ts";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

// 날짜별 기대값은 실행하는 날의 벽시계가 아니라 서버 시계가 정한다. 이 테스트는 시각이 멈춘 자기 서버
// (support/isolated-server.ts의 `withServerClock`)에서 돌고, 기록 시각과 대시보드 기준 시각이 모두 그 시계다.
// 브라우저 시간대도 서버가 자르는 시간대와 같게 정한다. 날짜·오늘은 서버 응답(`days`)이 정하고 브라우저 시계는 쓰지 않으므로
// 브라우저 시계는 고정하지 않는다(apps/web/src/dashboard-query.test.ts).
const timeZone = "Asia/Seoul";
const dayBefore = "2026-03-09";
const day = "2026-03-10";
const nextDay = "2026-03-11";
const beforeMidnight = "2026-03-10T14:59:00.000Z"; // 서울 3/10 23:59:00
const afterMidnight = "2026-03-10T15:00:01.000Z"; // 서울 3/11 00:00:01, UTC로는 아직 3/10
const test = withServerClock(beforeMidnight);
test.use({ timezoneId: timeZone });

/** 날짜 막대. 마지막·끝에서 둘째 같은 위치가 아니라 그 날짜로 찾는다. */
const bar = (chart: Locator, date: string) =>
  chart.locator(`[data-date="${date}"]`);
/** 막대 이름의 날짜(`3/10`). */
const label = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
/** 실행 시도 막대의 이름: 시작한 날 기준 상태별 수. */
const started = (
  date: string,
  { completed = 0, failed = 0, cancelled = 0, running = 0 }
) =>
  `${label(date)}: 완료 ${completed}, 실패 ${failed}, 취소됨 ${cancelled}, 서버 재시작 0, 실행 중 ${running}`;
/** 성공률 막대·표의 값: 끝난 날 기준 완료 / (완료 + 실패). 취소·서버 재시작은 따로 보인다. */
const rate = (completed: number, total: number, cancelled = 0) =>
  total
    ? `${Math.round((completed / total) * 100)}% (완료 ${completed} / ${total}, 취소 ${cancelled} · 서버 재시작 0 제외)`
    : `— (완료·실패 없음, 취소 ${cancelled} · 서버 재시작 0 제외)`;

async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  // 생성으로 깨어난 가짜 Lead가 초기 연구 승인을 요청하고 실행 시도를 끝낼 때까지 기다린다.
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/runs"));
      const list = (await res.json()) as { status: string }[];
      return list.length > 0 && list.every((r) => r.status === "completed");
    }, runs)
    .toBe(true);
  const say = async (body: string) =>
    expect(
      (await page.request.post(api("/messages"), { data: { body } })).status()
    ).toBe(201);
  return { id: org.id, name, leadId, api, say };
}

test("the dashboard and home follow a running agent, metrics and the 14 days live across midnight, and the activity filters by agent", async ({
  page,
  context,
  server,
}) => {
  const org = await createOrganization(page, "대시보드 E2E 조직");
  const other = await createOrganization(page, "옆 대시보드 E2E 조직");
  await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
  const home = await context.newPage();
  await home.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(home, "/");

  const running = page.getByRole("region", { name: "실행 중인 에이전트" });
  await expect(running).toContainText("지금 실행 중인 에이전트가 없습니다");
  // 생성으로 깨어난 Lead의 실행 시도 하나가 완료로 끝나 있다.
  await expect(page.getByTestId("metric-success")).toContainText("100%");
  await expect(page.getByTestId("metric-success")).toContainText(
    "완료 1 · 실패 0"
  );
  // 14일 막대는 서버가 브라우저 시간대로 자른 날짜 그대로다. 오늘은 서버 시계의 날(서울 3/10)이다.
  const runChart = page.getByRole("figure", { name: "실행 시도" });
  const rateChart = page.getByRole("figure", { name: "실행 성공률" });
  const serverDays = async () =>
    (
      (await (
        await page.request.get(
          org.api(`/dashboard?timeZone=${encodeURIComponent(timeZone)}`)
        )
      ).json()) as { timeZone: string; days: { date: string }[] }
    ).days.map((d) => d.date);
  const shownDays = (chart: Locator) =>
    chart
      .locator("[data-date]")
      .evaluateAll((bars) => bars.map((b) => b.getAttribute("data-date")));
  const daysBeforeMidnight = await serverDays();
  expect(daysBeforeMidnight).toHaveLength(14);
  expect(daysBeforeMidnight.at(-1)).toBe(day);
  expect(await shownDays(runChart)).toEqual(daysBeforeMidnight);
  expect(await shownDays(rateChart)).toEqual(daysBeforeMidnight);

  // 가짜 Lead는 `실행 유지 연습` 부탁을 받으면 취소될 때까지 실행 시도를 끝내지 않는다.
  await org.say("실행 유지 연습");
  const card = running.locator(`[data-agent-id="${org.leadId}"]`);
  await expect(card).toContainText("Research Lead", runs);
  await expect(card).toContainText("실행 중");
  await expect(running.getByTestId("running-agent-counts")).toHaveText(
    "실행 중 1"
  );
  await expect(page.getByTestId("metric-runs")).toContainText("실행 중 1");
  await expect(bar(runChart, day)).toHaveAttribute(
    "aria-label",
    started(day, { completed: 1, running: 1 })
  );
  // 막대는 hover로 그날의 수를 보인다. 키보드는 막대를 들르지 않고 `숫자로 보기` 표에서 같은 값을 읽는다(keyboard-a11y.spec.ts).
  await bar(runChart, day).hover();
  await expect(runChart.getByRole("tooltip")).toContainText(
    `${label(day)} (오늘)`
  );
  await expect(
    page
      .getByRole("region", { name: "최근 활동" })
      .locator('[data-event-type="run.started"]')
      .first()
  ).toBeVisible();

  // 홈은 조직의 방과 전체 수에 작업 중인 에이전트를 보인다. 전체 수는 서버의 실제 진행 중 수와 같다.
  const orgCard = (id: string) =>
    home.getByRole("main").locator(`section[data-org-id="${id}"]`);
  const homeCard = orgCard(org.id);
  await expect(homeCard.getByTestId("room-headcount")).toHaveText(
    /^작업 중 1/,
    runs
  );
  await expect(orgCard(other.id).getByTestId("room-headcount")).toHaveText(
    /^작업 중 0/
  );
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
  // 생성으로 깨어난 첫 실행 시도와 지금 실행 중인 실행 시도다.
  await expect(stream.locator('[data-event-type="run.started"]')).toHaveCount(
    2
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
  await expect(homeCard.getByTestId("room-headcount")).toHaveText(
    /^작업 중 0/,
    runs
  );
  await page.request.post(org.api(`/agents/${org.leadId}/resume`), {
    data: {},
  });

  // 성공률은 완료 / (완료 + 실패)이며 취소는 세지 않는다. 실행 시도가 없던 날은 0%가 아니라 —다.
  await expect(page.getByTestId("metric-success")).toContainText("100%");
  await expect(bar(rateChart, day)).toHaveAttribute(
    "aria-label",
    `${label(day)}: ${rate(1, 1, 1)}`
  );
  await expect(bar(rateChart, dayBefore)).toHaveAttribute(
    "aria-label",
    `${label(dayBefore)}: ${rate(0, 0)}`
  );

  // 자정이 지나 서울 3/11이 된 뒤 실패 하나, 완료 하나가 차례로 끝난다. 새 기록은 3/11에 들고, 3/10의 값은 그대로 남는다.
  // 14일이 하루 밀려 3/11이 오늘이 된다. 다른 날의 결과를 오늘에 합치면 3/11 막대가 틀린다.
  await server.setNow(afterMidnight);
  await org.say("실패 연습");
  await expect(page.getByTestId("metric-success")).toContainText("50%", runs);
  await expect(page.getByTestId("metric-success")).toContainText(
    "완료 1 · 실패 1"
  );
  const daysAfterMidnight = await serverDays();
  expect(daysAfterMidnight).toEqual([...daysBeforeMidnight.slice(1), nextDay]);
  expect(await shownDays(rateChart)).toEqual(daysAfterMidnight);
  await expect(bar(rateChart, nextDay)).toHaveAttribute(
    "aria-label",
    `${label(nextDay)}: ${rate(0, 1)}`
  );
  await org.say("안녕하세요");
  await expect(page.getByTestId("metric-success")).toContainText("67%", runs);
  await expect(page.getByTestId("metric-success")).toContainText(
    "완료 2 · 실패 1"
  );
  await expect(bar(rateChart, nextDay)).toHaveAttribute(
    "aria-label",
    `${label(nextDay)}: ${rate(1, 2)}`
  );
  await expect(bar(rateChart, day)).toHaveAttribute(
    "aria-label",
    `${label(day)}: ${rate(1, 1, 1)}`
  );
  await expect(bar(rateChart, dayBefore)).toHaveAttribute(
    "aria-label",
    `${label(dayBefore)}: ${rate(0, 0)}`
  );
  // 실행 시도 막대는 시작한 날 기준이다. 자정 전 시작한 둘(생성 깨우기 완료·취소)은 3/10, 자정 뒤 둘은 3/11이다.
  await expect(bar(runChart, day)).toHaveAttribute(
    "aria-label",
    started(day, { completed: 1, cancelled: 1 })
  );
  await expect(bar(runChart, nextDay)).toHaveAttribute(
    "aria-label",
    started(nextDay, { completed: 1, failed: 1 })
  );
  await bar(runChart, nextDay).hover();
  await expect(runChart.getByRole("tooltip")).toContainText(
    `${label(nextDay)} (오늘)`
  );
  // 숫자 표도 날짜마다 같은 값이다(최근 날짜부터).
  await rateChart.getByText("숫자로 보기").click();
  const rateRow = (date: string) =>
    rateChart.getByRole("row").filter({ hasText: date });
  await expect(rateChart.getByRole("row").nth(1)).toContainText(nextDay);
  await expect(rateRow(nextDay)).toContainText(rate(1, 2));
  await expect(rateRow(day)).toContainText(rate(1, 1, 1));
  await expect(rateRow(dayBefore)).toContainText(rate(0, 0));

  // 서버가 모르는 브라우저 시간대면 UTC로 잘라 보이고 그 사실을 밝힌다. UTC로는 서울 자정 전후의 기록이 모두 3/10이다.
  const unknownZone = await context.newPage();
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
  await expect(unknownZone.getByTestId("metric-success")).toContainText("67%");
  const utcRate = unknownZone.getByRole("figure", { name: "실행 성공률" });
  await expect(utcRate.locator("[data-date]").last()).toHaveAttribute(
    "data-date",
    day
  );
  await expect(bar(utcRate, day)).toHaveAttribute(
    "aria-label",
    `${label(day)}: ${rate(2, 3, 1)}`
  );
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
