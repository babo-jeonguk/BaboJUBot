import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
import { goalInput } from "./support/organization.ts";

// 넓힌 프로바이더 계약(#96)의 화면. E2E 서버의 `fake`는 끼워 넣기를 하고 준비됨이며, `fake-2`는 끼워 넣기를 못 하고
// 제품 로그인이 없어 준비안됨이다(playwright.config.ts `BABOJUBOT_FAKE_PROVIDER_SETTINGS`).

const runs = { timeout: 20_000 };

async function createOrganization(page: Page, name: string, provider: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput, lead: { provider, model: null } },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as { id: string };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  const runList = async () =>
    (await (await page.request.get(api("/runs"))).json()) as {
      id: string;
      status: string;
    }[];
  await expect
    .poll(async () => {
      const list = await runList();
      return list.length > 0 && list.every((r) => r.status === "completed");
    }, runs)
    .toBe(true);
  return { id: org.id, api, runList };
}

/**
 * 가짜 Lead를 실행 중으로 붙잡는다. `실행 유지 연습`은 취소될 때까지, `끼워 넣기 연습`은 끼워 넣은 말을 받아 반영해 답할 때까지
 * 실행 시도를 끝내지 않는다.
 */
async function holdLead(
  page: Page,
  org: { api: (path: string) => string },
  body = "실행 유지 연습"
) {
  expect(
    (await page.request.post(org.api("/messages"), { data: { body } })).status()
  ).toBe(201);
}

const stop = async (page: Page, org: { api: (path: string) => string }) =>
  expect((await page.request.post(org.api("/stop"))).status()).toBe(200);

test("the global settings show each connection's readiness with a recheck, and a login command only for a missing product login", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithLiveEvents(page, "/settings");
  const providers = page.getByRole("region", { name: "프로바이더" });
  const row = (name: string) =>
    providers.getByRole("listitem", { name, exact: true });

  const fake = row("가짜 프로바이더");
  await expect(fake.getByTestId("readiness-badge")).toHaveText("✓준비됨", runs);
  await expect(fake.getByTestId("readiness-reason")).toHaveCount(0);
  await expect(
    fake.getByRole("button", { name: "가짜 프로바이더 다시 확인" })
  ).toBeVisible();
  await expect(
    fake.getByRole("button", { name: /로그인 명령 복사/ })
  ).toHaveCount(0);

  const fake2 = row("가짜 프로바이더 2");
  await expect(fake2.getByTestId("readiness-badge")).toHaveText("!준비안됨");
  await expect(fake2.getByTestId("readiness-reason")).toHaveText(
    "제품 로그인 없음"
  );
  const copy = fake2.getByRole("button", {
    name: "가짜 프로바이더 2 로그인 명령 복사",
  });
  await expect(copy).toBeVisible();

  // 다시 확인하는 동안 배지 자리는 spinner이고, 끝나면 같은 결과가 다시 보인다.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/providers/fake-2/readiness", async (route) => {
    await held;
    await route.continue();
  });
  await fake2
    .getByRole("button", { name: "가짜 프로바이더 2 다시 확인" })
    .click();
  await expect(
    fake2.getByRole("status", { name: "가짜 프로바이더 2 준비 상태 확인 중" })
  ).toBeVisible();
  release();
  await expect(fake2.getByTestId("readiness-badge")).toHaveText("!준비안됨");

  // 준비안됨 연결도 고르기 목록에 남고, 고르면 칸 옆에 그 배지가 보인다.
  const lead = providers.getByRole("combobox", {
    name: "Lead 기본 프로바이더",
    exact: true,
  });
  await lead.selectOption({ label: "가짜 프로바이더 2" });
  await expect(
    lead.locator("xpath=..").getByTestId("readiness-badge")
  ).toHaveText("!준비안됨");
});

test("the composer draws steer only for a Lead run whose provider can steer, and a steered message joins the transcript", async ({
  page,
}) => {
  const steerless = await createOrganization(
    page,
    "끼워 넣기 없는 조직",
    "fake-2"
  );
  await holdLead(page, steerless);
  await openWithLiveEvents(page, `/orgs/${steerless.id}/chat`);
  const input = page.getByLabel("Lead에게 보낼 메시지");
  const interrupt = page.getByRole("button", { name: "중단하고 보내기" });
  const queue = page.getByRole("button", { name: "줄 세우기" });
  const steer = page.getByRole("button", { name: "실행 중 끼워 넣기" });
  await expect(page.getByRole("button", { name: "실행 중단" })).toBeVisible(
    runs
  );
  await input.fill("방향 하나");
  await expect(interrupt).toBeVisible();
  await expect(queue).toBeVisible();
  await expect(steer).toHaveCount(0);
  await stop(page, steerless);

  const steering = await createOrganization(page, "끼워 넣기 조직", "fake");
  await holdLead(page, steering, "끼워 넣기 연습");
  await openWithLiveEvents(page, `/orgs/${steering.id}/chat`);
  await expect(page.getByRole("button", { name: "실행 중단" })).toBeVisible(
    runs
  );
  await input.fill("이 방향으로 가 주세요");
  await expect(steer).toBeVisible();
  await steer.hover();
  await expect(page.getByRole("tooltip")).toHaveText("실행 중 끼워 넣기");
  await steer.click();
  await expect(input).toHaveValue("");
  await expect(
    page.locator('[data-author="owner"]').getByText("이 방향으로 가 주세요")
  ).toBeVisible();
  await expect(page.getByTestId("queued-message")).toHaveCount(0);
  // 그 실행 시도가 끼워 넣은 말을 반영해 답하고 끝난다.
  await expect(
    page
      .locator('[data-author="agent"]')
      .getByText(/실행 중에 받은 말을 반영했습니다: “이 방향으로 가 주세요”/)
  ).toBeVisible(runs);
  await expect(
    page.getByRole("button", { name: "보내기", exact: true })
  ).toBeVisible(runs);
});

test("the run detail shows each usage figure with units, unreported ones apart, and the cost as an estimate", async ({
  page,
}) => {
  const org = await createOrganization(page, "사용량 조직", "fake");
  const [run] = await org.runList();
  await openWithLiveEvents(page, `/orgs/${org.id}/runs/${run!.id}`);
  const usage = page.getByRole("region", { name: "사용량" });
  await expect(usage.getByTestId("usage-입력")).toHaveText("1,234 토큰");
  await expect(usage.getByTestId("usage-출력")).toHaveText("56 토큰");
  await expect(usage.getByTestId("usage-캐시 읽기")).toHaveText("0 토큰");
  await expect(usage.getByTestId("usage-캐시 쓰기")).toHaveText("보고 안 됨");
  await expect(usage.getByTestId("usage-비용")).toHaveText("$0.0012추정");
});
