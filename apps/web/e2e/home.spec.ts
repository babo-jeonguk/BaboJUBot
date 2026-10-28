import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

const runs = { timeout: 20_000 };

type Agent = { id: string; name: string; role: string };

/**
 * API로 조직을 만든다. 다른 spec이 남긴 조직이 있으므로 화면 확인은 이 조직들의 방으로 좁힌다.
 * 조직을 만들면 가짜 Lead가 깨어나 곧바로 초기 연구 승인을 요청한다. 그 요청과 실행 시도의 끝을 기다린다.
 */
async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, goal: `${name} 목표`, completionCriteria: "근거 메모" },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${id}${path}`;
  const get = async <T>(path: string) =>
    (await (await page.request.get(api(path))).json()) as T;
  const idle = () =>
    expect
      .poll(
        async () => (await get<unknown[]>("/runs?status=running")).length,
        runs
      )
      .toBe(0);
  const say = async (body: string) =>
    expect(
      (await page.request.post(api("/messages"), { data: { body } })).status()
    ).toBe(201);
  let approvalId = "";
  await expect
    .poll(async () => {
      approvalId = (await get<{ id: string }[]>("/approvals"))[0]?.id ?? "";
      return approvalId;
    }, runs)
    .not.toBe("");
  await idle();
  return {
    id,
    name,
    api,
    get,
    idle,
    say,
    agents: async () => (await get<{ agents: Agent[] }>("")).agents,
    /** 초기 연구 승인. 가짜 Lead가 작업자마다 작업을 맡기고 작업자들이 끝낼 때까지 기다린다. */
    async approve() {
      expect(
        (
          await page.request.post(api(`/approvals/${approvalId}/decision`), {
            data: { decision: "approve" },
          })
        ).ok()
      ).toBe(true);
      await expect
        .poll(async () => (await get<unknown[]>("/tasks")).length, runs)
        .toBeGreaterThan(0);
      await idle();
    },
    /** 가짜 Lead에게 작업자 추가를 부탁하고 새 작업자가 생겨 Lead의 실행 시도가 끝날 때까지 기다린다(붙잡은 실행은 그대로). */
    async addWorker() {
      const before = (await this.agents()).length;
      const busy = (await get<unknown[]>("/runs?status=running")).length;
      await say("작업자 추가");
      await expect
        .poll(async () => (await this.agents()).length, runs)
        .toBe(before + 1);
      await expect
        .poll(
          async () => (await get<unknown[]>("/runs?status=running")).length,
          runs
        )
        .toBe(busy);
    },
  };
}
type Org = Awaited<ReturnType<typeof createOrganization>>;

test("the home is a lobby of rooms in creation order: attention shows in place, resting agents sit in the lounge, a working agent tells its task on hover, and big teams take the full width", async ({
  page,
}) => {
  const first = await createOrganization(page, "홈 E2E 먼저 만든 방");
  await first.approve();
  const second = await createOrganization(page, "홈 E2E 다음 방");
  await second.approve();
  // 나중에 만든 조직이 사용자 결정을 기다린다.
  const later = await createOrganization(page, "홈 E2E 승인 기다리는 방");
  const closed = await createOrganization(page, "홈 E2E 중단한 방");
  expect(
    (await page.request.post(closed.api("/stop"), { data: {} })).ok()
  ).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithLiveEvents(page, "/");
  const main = page.getByRole("main");
  const room = (org: Org) => main.locator(`section[data-org-id="${org.id}"]`);
  const order = async () => {
    const ids = await main
      .locator("section[data-org-id]")
      .evaluateAll((s) => s.map((e) => e.getAttribute("data-org-id")));
    return [first, second, later].map((o) => ids.indexOf(o.id));
  };

  // 만든 순서로 놓이고, 결정을 기다리는 방은 제자리에서 Lead의 물음표와 주의 표시로 알린다.
  await expect(room(later)).toBeVisible();
  const [a, b, c] = await order();
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(b!);
  expect(b).toBeLessThan(c!);
  await expect(room(later).getByTestId("decision-bubble")).toHaveText(
    "?계획 승인"
  );
  await expect(room(later).getByTestId("organization-attention")).toHaveText(
    "주의 1"
  );
  await expect(room(later)).toContainText("승인 대기");
  await expect(room(later)).toContainText(`${later.name} 목표`);
  await expect(
    room(later).getByRole("link", { name: /계획 승인 기다림$/ })
  ).toBeVisible();
  await expect(room(first).getByTestId("decision-bubble")).toHaveCount(0);
  await expect(room(first).getByTestId("organization-attention")).toHaveCount(
    0
  );
  await expect(
    room(first).getByTestId("organization-last-activity")
  ).toHaveText(/방금|분 전/);

  // 작업을 끝낸 작업자들은 라운지 소파에서 쉬고, 책상에는 이름표만 남는다.
  const workers = (await first.agents()).filter((w) => w.role === "worker");
  const lounge = room(first).getByRole("group", { name: "라운지" });
  for (const w of workers)
    await expect(
      lounge.getByRole("link", { name: `${w.name} · 쉬는 중` })
    ).toBeVisible(runs);
  await expect(room(first).getByTestId("room-headcount")).toHaveText(
    new RegExp(`^작업 중 0\\s*/ ${workers.length + 1}명$`)
  );

  // 작업 댓글로 실행을 붙잡은 작업자는 책상으로 돌아와 일하고, 마우스를 올리면 맡은 작업을 말한다.
  const [task] =
    await first.get<{ id: string; title: string; assigneeAgentId: string }[]>(
      "/tasks"
    );
  const worker = workers.find((w) => w.id === task!.assigneeAgentId)!;
  expect(
    (
      await page.request.post(first.api(`/tasks/${task!.id}/comments`), {
        data: { body: "실행 유지 연습" },
      })
    ).status()
  ).toBe(201);
  const seat = room(first).getByRole("link", {
    name: `${worker.name} · 작업 중`,
  });
  await expect(seat).toBeVisible(runs);
  await expect(
    lounge.getByRole("link", { name: `${worker.name} · 쉬는 중` })
  ).toHaveCount(0);
  await expect(room(first).getByTestId("room-headcount")).toHaveText(
    /^작업 중 1/
  );
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await seat.hover();
  await expect(page.getByRole("tooltip")).toHaveText(task!.title);
  // keyboard focus로도 말한다.
  await main.getByTestId("organization-count").hover();
  await expect(page.getByRole("tooltip", { name: task!.title })).toHaveCount(0);
  await seat.focus();
  await expect(page.getByRole("tooltip")).toHaveText(task!.title);
  await seat.blur();

  // 먼저 만든 방이 주의를 받아도(실패) 방 순서는 그대로다.
  await second.say("실패 연습");
  await expect(room(second).getByTestId("organization-attention")).toHaveText(
    "주의 1",
    runs
  );
  await expect(
    room(second).getByRole("link", { name: /· 마지막 실행 실패$/ })
  ).toBeVisible();
  expect(await order()).toEqual([a, b, c]);

  // 여섯 명(Lead 포함)까지는 반 폭에 한 줄로 앉고, 일곱 명이 되면 한 줄 전체를 쓴다.
  for (let n = workers.length + 1; n < 6; n++) await first.addWorker();
  const grid = main.locator(".room-grid").first();
  const widthOf = async () => {
    const [box, all] = await Promise.all([
      room(first).boundingBox(),
      grid.boundingBox(),
    ]);
    return box!.width / all!.width;
  };
  await expect(room(first).getByTestId("room-headcount")).toHaveText(
    / 6명$/,
    runs
  );
  expect(await widthOf()).toBeLessThan(0.55);
  const tops = await room(first)
    .locator(".room-desks .seat")
    .evaluateAll((seats) =>
      seats.map((s) => Math.round(s.getBoundingClientRect().top))
    );
  expect(tops).toHaveLength(5);
  expect(new Set(tops).size).toBe(1);
  await first.addWorker();
  await expect(room(first).getByTestId("room-headcount")).toHaveText(
    / 7명$/,
    runs
  );
  await expect.poll(widthOf).toBeGreaterThan(0.95);
  // 넓어져도 방 순서는 그대로다.
  expect(await order()).toEqual([a, b, c]);

  // 끝난 조직은 아래에 접혀 있다. 펼치면 불 꺼진 작은 방으로 보인다.
  const closedToggle = main.locator("summary", { hasText: "끝난 조직" });
  await expect(room(closed)).toBeHidden();
  await expect(
    closedToggle.getByTestId("closed-organization-count")
  ).toHaveText(/^[1-9]\d*$/);
  await closedToggle.click();
  await expect(room(closed)).toBeVisible();
  await expect(room(closed)).toContainText("중단됨");
  await expect(room(closed)).toHaveAttribute("data-mode", "closed");

  // 주의 필요 수는 Inbox를 연다.
  await main.getByRole("button", { name: /^주의 필요 \d+개/ }).click();
  const inbox = page.getByRole("complementary", { name: "Inbox" });
  await expect(inbox).toBeVisible();

  // 390px에서도 가로로 넘치지 않는다(붙어 있던 Inbox는 닫힌다).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(room(later)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 방 머리는 조직 화면으로, 캐릭터는 그 에이전트 화면으로 간다.
  await room(first)
    .getByRole("link", { name: /홈 E2E 먼저 만든 방/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${first.id}$`));
  await page.goBack();
  await room(first)
    .getByRole("link", { name: `${worker.name} · 작업 중` })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/orgs/${first.id}/agents/${worker.id}$`)
  );

  // 붙잡은 실행 시도를 정리한다.
  await page.request.post(first.api("/stop"), { data: {} });
  await page.request.post(second.api("/stop"), { data: {} });
});
