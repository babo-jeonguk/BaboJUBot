import { expect, test, type Page } from "@playwright/test";
import { isReadyFrame, openWithLiveEvents } from "./support/live-events.ts";

/**
 * 탭의 GET 조회를 서버 응답을 바로 받아(요청 시작 때의 상태로 고정) 늦게 돌려준다.
 * Event 간격보다 응답이 느려서, 진행 중 조회를 취소하고 다시 보내면 같은 주소의 요청이 겹친다.
 * 돌려주는 함수는 주소별 최대 동시 진행 수를 알려 준다.
 */
async function slowGets(page: Page, url: string) {
  const inFlight = new Map<string, number>();
  let maxInFlight = 0;
  await page.route(url, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const key = route.request().url();
    const now = (inFlight.get(key) ?? 0) + 1;
    inFlight.set(key, now);
    maxInFlight = Math.max(maxInFlight, now);
    try {
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ response });
    } catch {
      // 탭을 닫는 중에는 응답할 곳이 없다.
    } finally {
      inFlight.set(key, inFlight.get(key)! - 1);
    }
  });
  return () => maxInFlight;
}

/** 가짜 Lead가 목표를 기록하고 초기 연구 승인을 요청한 조직. */
async function awaitingApproval(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
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
  const approve = async () => {
    const decided = await page.request.post(
      api(`/approvals/${approvalId}/decision`),
      { data: { decision: "approve" } }
    );
    expect(decided.status()).toBe(200);
  };
  return { org, api, approve };
}

test("another tab follows the burst of Events from an initial approval while the organization responses are slow, keeping one request in flight and showing the team after the last Event", async ({
  page,
  context,
}) => {
  const { org, api, approve } = await awaitingApproval(
    page,
    "느린 실시간 E2E 조직"
  );
  const watcher = await context.newPage();
  const maxInFlight = await slowGets(watcher, `**${api("")}`);
  await openWithLiveEvents(watcher, `/orgs/${org.id}/agents`);
  const team = watcher.getByRole("region", { name: "조직도" });
  await expect(team.locator("[data-agent-node]")).toHaveCount(1);

  // 승인하면 작업자가 생기고 Lead가 깨어나 Event가 몰린다. 지켜보는 탭은 사용자 입력 없이 팀을 보여 준다.
  await approve();
  await expect(team).toContainText("작업자 2명", { timeout: 15_000 });
  expect(maxInFlight()).toBe(1);
});

test("another tab editing an agent's copy follows a save elsewhere while its copy responses are slow, keeping its draft and one request in flight", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "느린 사본 E2E 조직" },
  });
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const leadId = org.agents.find((a) => a.role === "lead")!.id;
  const api = `/api/organizations/${org.id}/agents/${leadId}/instructions`;
  const { copies } = (await (await page.request.get(api)).json()) as {
    copies: { id: string; path: string }[];
  };
  const role = copies.find((c) => c.path === "AGENTS.md")!;

  // 지켜보는 탭은 사본·revision 조회가 느리고, 편집 중인 draft가 있다.
  const watcher = await context.newPage();
  const maxInFlight = await slowGets(watcher, `**${api}**`);
  await openWithLiveEvents(
    watcher,
    `/orgs/${org.id}/agents/${leadId}/instructions`
  );
  const section = watcher.getByRole("region", { name: "Role·Soul·Skill 사본" });
  await section.getByRole("button", { name: "✎ 편집" }).click();
  const editor = section.getByRole("textbox", { name: "AGENTS.md 편집" });
  const draft = "# 지켜보는 탭의 편집\n\n저장하지 않았다.\n";
  await editor.fill(draft);

  // 다른 곳에서 저장하면 Lead가 깨어나 Event가 몰린다. 지켜보는 탭은 새 revision을 알리고 draft를 지킨다.
  const saved = await page.request.put(`${api}/${role.id}`, {
    data: { content: "# 다른 곳에서 저장\n", expectedRevision: 1 },
  });
  expect(saved.status()).toBe(200);
  await expect(section.getByRole("alert")).toContainText(
    "다른 곳에서 먼저 저장했습니다 (revision 2)",
    { timeout: 15_000 }
  );
  const revisions = section
    .getByRole("region", { name: "revision 목록" })
    .getByRole("button");
  await expect(revisions).toHaveCount(2);
  await expect(revisions.first()).toContainText("revision 2");
  await expect(editor).toHaveValue(draft);
  expect(maxInFlight()).toBe(1);
});

test("after the Event stream drops and reconnects, another tab shows what changed while it was cut off", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "재연결 E2E 조직" },
  });
  const org = (await created.json()) as { id: string };

  // 지켜보는 탭의 Event stream을 실제 서버에 잇되, 끊은 뒤 다시 잇는 시점을 테스트가 정한다.
  const watcher = await context.newPage();
  let reconnect = Promise.resolve();
  let release = () => {};
  let onReady = () => {};
  const nextReady = () => new Promise<void>((resolve) => (onReady = resolve));
  let connection: { close: () => Promise<void> } | undefined;
  await watcher.routeWebSocket(/\/api\/events/, async (ws) => {
    await reconnect;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (isReadyFrame(message)) onReady();
      ws.send(message);
    });
    connection = ws;
  });
  const first = nextReady();
  await watcher.goto(`/orgs/${org.id}/settings`);
  await first;
  const policy = watcher
    .getByRole("region", { name: "승인 정책" })
    .getByRole("checkbox", { name: /작업자 추가/ });
  await expect(policy).not.toBeChecked();

  // 끊긴 동안 승인 정책을 켠다. 이 변경은 Event 하나만 남기고 아무도 깨우지 않으므로, 그 Event를 놓치면 뒤따르는 Event도 없다.
  reconnect = new Promise<void>((resolve) => (release = resolve));
  await connection!.close();
  const changed = await page.request.put(
    `/api/organizations/${org.id}/approval-policy`,
    { data: { addWorker: true } }
  );
  expect(changed.status()).toBe(200);
  await expect(policy).not.toBeChecked();

  // 다시 이어지면 ready가 전체를 다시 불러와, 사용자 입력 없이 바뀐 정책이 보인다.
  const second = nextReady();
  release();
  await second;
  await expect(policy).toBeChecked();
});
