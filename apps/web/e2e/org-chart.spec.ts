import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

/** 스크린샷을 남길 곳. 지정하면 조직도·꾸미기 창을 찍는다(사람이 보는 확인용이며 비교하지 않는다). */
const shots = process.env.E2E_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(300); // 고른 칸 테두리 전환이 끝난 뒤 찍는다.
  await page.screenshot({ path: `${shots}/${name}.png` });
};

type Org = { id: string; agents: { id: string; role: string; name: string }[] };

/** 초기 연구 승인까지 마쳐 작업자 두 명이 있는 조직. */
async function teamOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const { id } = (await created.json()) as Org;
  const api = (path: string) => `/api/organizations/${id}${path}`;
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
  const decided = await page.request.post(
    api(`/approvals/${approvalId}/decision`),
    { data: { decision: "approve" } }
  );
  expect(decided.status()).toBe(200);
  const org = (await (await page.request.get(api(""))).json()) as Org;
  expect(org.agents.filter((a) => a.role === "worker")).toHaveLength(2);
  return { ...org, api };
}

test("the owner sees the team as an org chart, renames a worker and customizes its face while another tab follows", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const org = await teamOrganization(page, "조직도 E2E 조직");
  const lead = org.agents.find((a) => a.role === "lead")!;
  const [worker, other] = org.agents.filter((a) => a.role === "worker");

  await openWithLiveEvents(page, `/orgs/${org.id}/agents`);
  const chart = page.getByRole("region", { name: "조직도" });
  await expect(chart).toContainText("작업자 2명");
  const node = (name: string | RegExp) =>
    chart.getByRole("link", {
      name: typeof name === "string" ? new RegExp(name) : name,
    });
  // Lead가 위, 작업자가 아래에 나란히 있고 Lead와 연결된다.
  const leadBox = (await node(lead.name).boundingBox())!;
  const workerBox = (await node(worker!.name).boundingBox())!;
  const otherBox = (await node(other!.name).boundingBox())!;
  expect(workerBox.y).toBeGreaterThan(leadBox.y + leadBox.height);
  expect(Math.abs(workerBox.y - otherBox.y)).toBeLessThan(2);
  await expect(chart.locator(".react-flow__edge")).toHaveCount(2);
  await expect(node(lead.name)).toContainText("Research Lead");
  await expect(node(worker!.name)).toContainText("작업자");
  await expect(
    chart.getByRole("button", { name: "한눈에 보기" })
  ).toBeVisible();
  // 포인터가 가까이 오면 얼굴이 따라보고, 멀어지면 가운데로 돌아온다.
  const leadFace = node(lead.name).locator("svg.face");
  await page.mouse.move(leadBox.x + leadBox.width + 40, leadBox.y);
  await expect(leadFace).toHaveAttribute("data-tracking", "");
  await page.mouse.move(1430, 890);
  await expect(leadFace).not.toHaveAttribute("data-tracking", "");
  await shot(page, "org-chart-1440");

  const watcher = await context.newPage();
  await openWithLiveEvents(watcher, `/orgs/${org.id}/agents`);
  const watched = watcher.getByRole("region", { name: "조직도" });
  await expect(watched).toContainText(worker!.name);

  // 카드를 누르면 상세가 열리고, 이름을 눌러 바꾼다. Esc는 취소, Enter는 저장이다.
  await node(worker!.name).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${worker!.id}$`));
  await page.getByRole("button", { name: worker!.name, exact: true }).click();
  const input = page.getByRole("textbox", { name: "에이전트 이름" });
  await input.fill("취소할 이름");
  await input.press("Escape");
  await expect(
    page.getByRole("heading", { name: worker!.name, exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: worker!.name, exact: true }).click();
  await input.fill("research lead");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "같은 이름의 에이전트가 이미 있습니다."
  );
  await input.fill("  통계 담당  ");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "통계 담당", exact: true })
  ).toBeVisible();
  await expect(watched.getByRole("link", { name: /통계 담당/ })).toBeVisible();
  await shot(page, "agent-detail-1440");

  // 얼굴 꾸미기: 고르는 대로 미리 보이고, 저장하면 다른 탭의 조직도도 바뀐다.
  await page.getByRole("button", { name: "얼굴 꾸미기" }).click();
  const dialog = page.getByRole("dialog", { name: "얼굴 꾸미기" });
  await dialog.getByRole("radio", { name: "라벤더색" }).check();
  await dialog.getByRole("radio", { name: "반짝이는 눈" }).check();
  await dialog.getByRole("radio", { name: "활짝 웃는 입" }).check();
  await dialog.getByRole("radio", { name: "안경" }).check();
  const preview = dialog.getByRole("img", { name: /얼굴 미리 보기/ });
  await expect(preview).toHaveAttribute("data-accessory", "glasses");
  await expect(preview).toHaveAttribute("data-color", "lilac");
  await shot(page, "face-customizer-1440");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toBeHidden();
  const saved = (await (
    await page.request.get(org.api(`/agents/${worker!.id}`))
  ).json()) as { appearance: unknown };
  expect(saved.appearance).toEqual({
    color: "lilac",
    eyes: "sparkle",
    mouth: "grin",
    accessory: "glasses",
  });
  await expect(
    watched
      .getByRole("link", { name: /통계 담당/ })
      .locator('svg[data-accessory="glasses"][data-color="lilac"]')
  ).toBeVisible();
  await watcher.close();

  // 취소하면 저장하지 않는다.
  await page.getByRole("button", { name: "얼굴 꾸미기" }).click();
  await dialog.getByRole("radio", { name: "새싹" }).check();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(
    page.getByRole("button", { name: "얼굴 꾸미기" }).locator("svg.face")
  ).toHaveAttribute("data-accessory", "glasses");

  // 활동에 이름 바꾸기가 남는다.
  await page.goto(`/orgs/${org.id}/activity`);
  await expect(page.getByRole("list", { name: "활동 stream" })).toContainText(
    `${worker!.name} → 통계 담당`
  );
});

test("the org chart stacks the team under the Lead at 390px without overflowing, and faces hold still with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const org = await teamOrganization(page, "좁은 조직도 E2E 조직");
  const lead = org.agents.find((a) => a.role === "lead")!;
  const workers = org.agents.filter((a) => a.role === "worker");

  await page.goto(`/orgs/${org.id}/agents`);
  const chart = page.getByRole("region", { name: "조직도" });
  const links = chart.getByRole("link");
  await expect(links).toHaveCount(3);
  const boxes = await Promise.all(
    [lead, ...workers].map(
      async (a) =>
        (await chart
          .getByRole("link", { name: new RegExp(a.name) })
          .boundingBox())!
    )
  );
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  // Lead 아래로 작업자가 들여 쌓인다.
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y + boxes[1]!.height);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(390);
  await expect(chart.locator(".face-eye").first()).toHaveCSS(
    "animation-name",
    "none"
  );
  await shot(page, "org-chart-390");

  await chart.getByRole("link", { name: new RegExp(workers[0]!.name) }).click();
  await page.getByRole("button", { name: "얼굴 꾸미기" }).click();
  const dialog = page.getByRole("dialog", { name: "얼굴 꾸미기" });
  await expect(dialog.getByRole("button", { name: "저장" })).toBeInViewport();
  await shot(page, "face-customizer-390");
});
