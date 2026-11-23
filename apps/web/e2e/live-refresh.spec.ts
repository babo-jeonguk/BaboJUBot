import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { firstApprovalId, goalInput, leadRun } from "./support/organization.ts";
import { isReadyFrame, pageLoad } from "./support/live-events.ts";
import { within } from "@babojubot/process/test-support";

/**
 * 탭이 `under`로 시작하는 주소에 보내는 GET을 지켜본다. 주소별 최대 동시 진행 수와 경로별 요청 수를 센다.
 * `hold(path)`는 그 경로의 다음 GET을 서버 응답을 받은 뒤(요청 시작 때의 상태로 고정) 붙잡고, 시험이 `release`를 부를 때 탭에 돌려준다.
 * 시험이 실패해도 `releaseAll`로 붙잡은 응답을 풀어 route callback이 닫힌 page를 기다리지 않게 한다.
 */
async function watchGets(page: Page, under: string) {
  const inFlight = new Map<string, number>();
  const started = new Map<string, number>();
  let maxInFlight = 0;
  let holding:
    { path: string; held: () => void; released: Promise<void> } | undefined;
  const releases: (() => void)[] = [];
  await page.route(
    (url) => url.pathname.startsWith(under),
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const url = new URL(route.request().url());
      const key = url.href;
      const now = (inFlight.get(key) ?? 0) + 1;
      inFlight.set(key, now);
      maxInFlight = Math.max(maxInFlight, now);
      started.set(url.pathname, (started.get(url.pathname) ?? 0) + 1);
      try {
        const response = await route.fetch();
        const hold = holding;
        if (hold && url.pathname === hold.path) {
          holding = undefined;
          hold.held();
          await hold.released;
        }
        await route.fulfill({ response });
      } catch {
        // 탭을 닫는 중에는 응답할 곳이 없다.
      } finally {
        inFlight.set(key, inFlight.get(key)! - 1);
      }
    }
  );
  return {
    maxInFlight: () => maxInFlight,
    started: (path: string) => started.get(path) ?? 0,
    hold(path: string) {
      let held!: () => void;
      const reached = new Promise<void>((resolve) => (held = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      releases.push(release);
      holding = { path, held, released };
      return {
        /** 그 GET을 붙잡을 때까지(상한 `leadRun`). */
        held: () =>
          within(
            reached,
            leadRun.timeout,
            `holding a GET ${path} did not happen`
          ),
        release,
      };
    },
    releaseAll: () => releases.forEach((release) => release()),
  };
}

/**
 * 탭의 Event stream을 실제 서버에 잇되, 서버가 보낸 frame을 탭에 넘기는 것을 시험이 멈췄다 다시 흘린다(멈춘 동안은 모아 둔다).
 * 후속 조회가 붙잡혔던 조회의 표시 때문에 시작됐는지 보려면 그동안 새 Event가 탭에 닿지 않아야 한다.
 * `routeWebSocket`으로 가로챈 page라 구독 준비는 `openWithLiveEvents` 대신 `ready` frame으로 본다.
 */
async function pausableEvents(page: Page) {
  let paused = false;
  const held: (string | Buffer)[] = [];
  let toPage: WebSocketRoute | undefined;
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => (onReady = resolve));
  await page.routeWebSocket(/\/api\/events/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (isReadyFrame(message)) onReady();
      if (paused) held.push(message);
      else ws.send(message);
    });
    toPage = ws;
  });
  return {
    /** 첫 구독 준비(상한 `pageLoad`). */
    ready: () =>
      within(ready, pageLoad.timeout, "the first ready frame did not happen"),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const message of held.splice(0)) toPage?.send(message);
    },
  };
}

/**
 * 탭이 진행 중인 조회 `queryKey`에 후속 신호를 받아 끝난 뒤 다시 불러오기로 표시할 때까지. 화면 코드의 관찰점
 * (문서 루트의 `data-live-refresh-queued`, `apps/web/src/live-events.ts`)을 본다. 후속 Event는 Lead의 실행이 낸다.
 */
const queuedAfterEvent = (page: Page, queryKey: readonly string[]) =>
  expect
    .poll(
      async () =>
        JSON.parse(
          await page.evaluate(
            () => document.documentElement.dataset.liveRefreshQueued ?? "[]"
          )
        ) as string[],
      leadRun
    )
    .toContain(JSON.stringify(queryKey));

/** 가짜 Lead가 목표를 기록하고 초기 연구 승인을 요청한 조직. */
async function awaitingApproval(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  const approvalId = await firstApprovalId(page.request, org.id);
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
  const gets = await watchGets(watcher, api(""));
  const events = await pausableEvents(watcher);
  try {
    await watcher.goto(`/orgs/${org.id}/agents`);
    await events.ready();
    const team = watcher.getByRole("region", { name: "조직도" });
    await expect(team.locator("[data-agent-node]")).toHaveCount(1);

    // 승인하면 작업자가 생기고 Lead가 깨어나 Event가 몰린다. 그 첫 Event가 부른 조직 조회(팀이 들어 있음)의 응답을 붙잡은 동안
    // 후속 Event가 탭에 닿게 하고, 풀어 준 뒤 탭이 마지막 Event 뒤의 조직을 다시 불러오는지 본다.
    const organizationPath = api("");
    const held = gets.hold(organizationPath);
    await approve();
    await held.held();
    await queuedAfterEvent(watcher, ["organizations", org.id]);
    // 새 Event를 멈춘 채 풀어 준다. 그래도 다시 불러오면 그것은 붙잡힌 동안 받은 Event의 표시 때문이다.
    events.pause();
    const before = gets.started(organizationPath);
    held.release();
    await expect
      .poll(() => gets.started(organizationPath), leadRun)
      .toBeGreaterThan(before);
    events.resume();
    await expect(team).toContainText("작업자 2명", leadRun);
    expect(gets.maxInFlight()).toBe(1);
  } finally {
    gets.releaseAll();
  }
});

test("another tab editing an agent's copy follows a save elsewhere while its copy responses are slow, keeping its draft and one request in flight", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "느린 사본 E2E 조직", ...goalInput },
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

  // 지켜보는 탭은 사본·revision을 보고 있고, 편집 중인 draft가 있다.
  const watcher = await context.newPage();
  const gets = await watchGets(watcher, api);
  const events = await pausableEvents(watcher);
  try {
    await watcher.goto(`/orgs/${org.id}/agents/${leadId}/instructions`);
    await events.ready();
    const section = watcher.getByRole("region", {
      name: "Role·Soul·Skill 사본",
    });
    await section.getByRole("button", { name: "✎ 편집" }).click();
    const editor = section.getByRole("textbox", { name: "AGENTS.md 편집" });
    const draft = "# 지켜보는 탭의 편집\n\n저장하지 않았다.\n";
    await editor.fill(draft);

    // 다른 곳에서 저장하면 Lead가 깨어나 Event가 몰린다. 첫 Event가 부른 사본 조회의 응답을 붙잡은 동안 후속 Event가 탭에
    // 닿게 하고, 풀어 준 뒤 탭이 다시 불러와 새 revision을 알리고 draft를 지키는지 본다.
    const held = gets.hold(api);
    const saved = await page.request.put(`${api}/${role.id}`, {
      data: { content: "# 다른 곳에서 저장\n", expectedRevision: 1 },
    });
    expect(saved.status()).toBe(200);
    await held.held();
    await queuedAfterEvent(watcher, [
      "organizations",
      org.id,
      "agents",
      leadId,
      "instructions",
    ]);
    events.pause();
    const before = gets.started(api);
    held.release();
    await expect.poll(() => gets.started(api), leadRun).toBeGreaterThan(before);
    events.resume();
    await expect(section.getByRole("alert")).toContainText(
      "다른 곳에서 먼저 저장했습니다 (revision 2)",
      leadRun
    );
    const revisions = section
      .getByRole("region", { name: "revision 목록" })
      .getByRole("button");
    await expect(revisions).toHaveCount(2);
    await expect(revisions.first()).toContainText("revision 2");
    await expect(editor).toHaveValue(draft);
    expect(gets.maxInFlight()).toBe(1);
  } finally {
    gets.releaseAll();
  }
});

test("after the Event stream drops and reconnects, another tab shows what changed while it was cut off", async ({
  page,
  context,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "재연결 E2E 조직", ...goalInput },
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
  try {
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
  } finally {
    release();
  }
});
