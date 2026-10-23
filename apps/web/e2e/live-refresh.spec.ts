import { expect, test, type Page } from "@playwright/test";

/** 전체 조직 Event stream 구독이 성립할 때까지 기다린다. */
async function openWithLiveEvents(page: Page, path: string) {
  const ready = new Promise<void>((resolve) =>
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/api/events")) return;
      ws.on(
        "framereceived",
        (f) => String(f.payload).includes('"ready"') && resolve()
      );
    })
  );
  await page.goto(path);
  await ready;
}

test("another tab follows the burst of Events from an initial approval while the organization responses are slow, keeping one request in flight and showing the team after the last Event", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "느린 실시간 E2E 조직" },
  });
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  // 가짜 Lead가 목표를 기록하고 초기 연구 승인을 요청할 때까지.
  await page.request.post(api("/messages"), {
    data: { body: "목표: 오류 유형을 정리한다\n완료 기준: 유형 목록" },
  });
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(api("/approvals"));
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    })
    .not.toBe("");

  // 지켜보는 탭의 조직 조회는 서버 응답을 바로 받아(요청 시작 때의 상태로 고정) 늦게 돌려준다.
  // Event 간격보다 응답이 느려서, 진행 중 조회를 취소하고 다시 보내면 요청이 겹친다.
  const watcher = await context.newPage();
  let inFlight = 0;
  let maxInFlight = 0;
  await watcher.route(`**${api("")}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ response });
    } catch {
      // 탭을 닫는 중에는 응답할 곳이 없다.
    } finally {
      inFlight--;
    }
  });
  await openWithLiveEvents(watcher, `/orgs/${org.id}/agents`);
  const team = watcher.getByRole("region", { name: "작업자 팀" });
  await expect(team).toContainText("작업자 팀 0명");

  // 승인하면 작업자가 생기고 Lead가 깨어나 Event가 몰린다. 지켜보는 탭은 사용자 입력 없이 팀을 보여 준다.
  const decided = await page.request.post(
    api(`/approvals/${approvalId}/decision`),
    { data: { decision: "approve" } }
  );
  expect(decided.status()).toBe(200);
  await expect(team).toContainText("작업자 팀 2명", { timeout: 15_000 });
  expect(maxInFlight).toBe(1);
});
