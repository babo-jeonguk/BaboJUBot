import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchZoomed } from "./support/browser-zoom.ts";
import { lowContrastTexts } from "./support/contrast.ts";
import { openWithLiveEvents } from "./support/live-events.ts";
import { goalInput } from "./support/organization.ts";

// 키보드·포커스·접근 이름과 상태·실패 복구·실제 대비(#152). 실제 화면 읽기 프로그램은 실행하지 않고 Chromium 접근성 트리로 확인한다.

const runs = { timeout: 30_000 };

type Org = {
  id: string;
  leadId: string;
  approvalId: string;
  api: (path: string) => string;
};

/** 조직을 만들고 가짜 Lead가 초기 연구 승인을 요청하고 실행 시도를 끝낼 때까지 기다린다. */
async function createOrganization(page: Page, name: string): Promise<Org> {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  const api = (path: string) => `/api/organizations/${org.id}${path}`;
  let approvalId = "";
  await expect
    .poll(async () => {
      const list = (await (await page.request.get(api("/runs"))).json()) as {
        status: string;
      }[];
      const approvals = (await (
        await page.request.get(api("/approvals"))
      ).json()) as { id: string }[];
      approvalId = approvals[0]?.id ?? "";
      return (
        approvalId !== "" &&
        list.length > 0 &&
        list.every((r) => r.status !== "running")
      );
    }, runs)
    .toBe(true);
  return {
    id: org.id,
    leadId: org.agents.find((a) => a.role === "lead")!.id,
    approvalId,
    api,
  };
}

/** 승인해 가짜 작업자들이 연구 노드 둘을 만든 조직. */
async function researchingOrganization(page: Page, name: string) {
  const org = await createOrganization(page, name);
  await page.request.post(org.api(`/approvals/${org.approvalId}/decision`), {
    data: { decision: "approve" },
  });
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(org.api("/research-map"))).json()) as {
            nodes: unknown[];
          }
        ).nodes.length,
      runs
    )
    .toBe(2);
  return org;
}

async function openMap(page: Page, path: string) {
  await openWithLiveEvents(page, path);
  await expect(
    page.getByRole("heading", { name: "연구 지도", level: 1 })
  ).toBeVisible({ timeout: 20_000 });
}

/** Tab을 눌러 대상에 닿을 때까지 간다. 닿지 못하면 실패한다. */
async function tabTo(page: Page, target: Locator, limit = 20) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab ${limit}번 안에 닿지 못했습니다`);
}

const expectReadable = async (page: Page) =>
  expect(await lowContrastTexts(page)).toEqual([]);

test("the Lead chat transcript is a named region reached by Tab and scrolled by PageUp/PageDown, and the narrow list button tells about unread conversations until read", async ({
  page,
}) => {
  const org = await createOrganization(page, "A11y chat");
  const long = Array.from(
    { length: 40 },
    (_, i) => `긴 대화 ${i + 1}번째 줄`
  ).join("\n\n");
  const start = async (body: string) => {
    const res = await page.request.post(org.api("/conversations"), {
      data: { body },
    });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { conversation: { id: string } }).conversation
      .id;
  };
  const longId = await start(long);
  const otherId = await start("읽지 않을 다른 대화");
  // 두 대화 모두 가짜 Lead의 답장이 와서 읽지 않음이다.
  await expect
    .poll(async () => {
      const list = (await (
        await page.request.get(org.api("/conversations"))
      ).json()) as { id: string; unread: boolean }[];
      return list
        .filter((c) => c.unread && [longId, otherId].includes(c.id))
        .map((c) => c.id)
        .sort();
    }, runs)
    .toEqual([longId, otherId].sort());

  await page.setViewportSize({ width: 390, height: 700 });
  await openWithLiveEvents(page, `/orgs/${org.id}/chat/${longId}`);
  const transcript = page.getByRole("region", { name: "대화 내용" });
  await expect(transcript.locator('[data-author="agent"]')).toContainText(
    "긴 대화 1번째 줄"
  );
  // 다른 대화의 읽지 않음은 점과 같이 목록 버튼 이름으로도 알린다.
  const listButton = page.getByRole("button", { name: /^대화 목록/ });
  await expect(listButton).toHaveAccessibleName(
    "대화 목록 (읽지 않은 대화 있음)"
  );
  await expect(listButton.getByTestId("unread-elsewhere")).toBeVisible();
  await expect(transcript.getByRole("list", { name: "대화" })).toBeVisible();

  // Tab으로 대화 영역에 들어가 PageUp·PageDown으로 스크롤한다. 위로 가면 `맨 아래로`가 보인다.
  await page.getByRole("link", { name: "새 대화" }).focus();
  await tabTo(page, transcript);
  const top = () => transcript.evaluate((el) => el.scrollTop);
  await expect.poll(top).toBeGreaterThan(0);
  const bottom = await top();
  await page.keyboard.press("PageUp");
  await expect.poll(top).toBeLessThan(bottom);
  await expect(page.getByRole("button", { name: "맨 아래로" })).toBeVisible();
  const up = await top();
  await page.keyboard.press("PageDown");
  await expect.poll(top).toBeGreaterThan(up);
  await expectReadable(page);

  // 펼친 목록의 읽지 않음 글은 그대로이고, 그 대화를 읽으면 버튼의 안내와 점이 함께 사라진다.
  await listButton.click();
  const sheet = page.getByRole("dialog", { name: "대화 목록" });
  const other = sheet.getByRole("link", { name: /읽지 않을 다른 대화/ });
  await expect(other).toContainText("읽지 않음");
  await other.click();
  await expect(
    page
      .getByRole("region", { name: "대화 내용" })
      .locator('[data-author="agent"]')
  ).toContainText("읽지 않을 다른 대화");
  // 조직을 만들 때의 기본 대화도 Lead의 첫 메시지로 읽지 않음이다. 남은 대화를 모두 읽는 동안 버튼은 안내를 유지한다.
  await expect(
    page.getByRole("button", { name: /^대화 목록/ })
  ).toHaveAccessibleName("대화 목록 (읽지 않은 대화 있음)");
  await page.getByRole("button", { name: /^대화 목록/ }).click();
  await page
    .getByRole("dialog", { name: "대화 목록" })
    .getByRole("link", { name: /기본 대화/ })
    .click();
  await expect(
    page.getByRole("region", { name: "대화 내용" }).locator("[data-author]")
  ).not.toHaveCount(0);
  await page.getByRole("button", { name: /^대화 목록/ }).click();
  await page
    .getByRole("dialog", { name: "대화 목록" })
    .getByRole("link", { name: /긴 대화 1번째 줄/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chat/${longId}$`));
  await expect(
    page.getByRole("button", { name: /^대화 목록/ })
  ).toHaveAccessibleName("대화 목록");
  await expect(page.getByTestId("unread-elsewhere")).toHaveCount(0);
});

test("the dashboard bars leave the Tab order and the number table gives every date, series and unit by keyboard", async ({
  page,
}) => {
  const org = await createOrganization(page, "A11y chart");
  await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
  const chart = page.getByRole("figure", { name: "실행 시도" });
  await expect(chart.locator("[data-date]")).toHaveCount(14);
  // 막대 56개(4개 차트 × 14일)는 Tab 순서에 없다.
  await expect(page.locator("[data-date]")).toHaveCount(56);
  await expect(page.locator("[data-date][tabindex]")).toHaveCount(0);
  // 포인터는 여전히 막대에서 그날의 수를 본다.
  await chart.locator("[data-date]").last().hover();
  await expect(chart.getByRole("tooltip")).toContainText("(오늘)");

  // `숫자로 보기`는 키보드로 열고, 넘치는 표 영역에도 Tab으로 들어간다.
  const summary = chart.getByText("숫자로 보기");
  await summary.focus();
  await page.keyboard.press("Enter");
  const values = chart.getByRole("region", { name: "실행 시도 날짜별 값" });
  await expect(values).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(values).toBeFocused();
  const table = values.getByRole("table");
  await expect(table).toContainText("단위: 회");
  await expect(table.getByRole("row")).toHaveCount(15);
  for (const name of [
    "날짜",
    "실행 중",
    "완료",
    "실패",
    "취소됨",
    "서버 재시작",
  ])
    await expect(
      table.getByRole("columnheader", { name, exact: true })
    ).toBeVisible();
  const rate = page.getByRole("figure", { name: "실행 성공률" });
  await rate.getByText("숫자로 보기").click();
  await expect(rate.getByRole("table")).toContainText("단위: %");
  await expectReadable(page);
});

test("research map nodes move focus to the detail heading and back, the pickers work by keyboard, and the map and org chart have text alternatives", async ({
  page,
}) => {
  const org = await researchingOrganization(page, "A11y map");
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMap(page, `/orgs/${org.id}/map`);
  const map = page.getByRole("application", { name: "연구 지도 그래프" });
  await expect(map).toHaveAccessibleDescription(
    /Enter나 Space로 노드를 고르면/
  );
  const node = (title: string) =>
    page.locator(".react-flow__node").filter({ hasText: title });
  const first = node("연구 문제 정리 1");
  const second = node("연구 문제 정리 2");
  await expect(first).toHaveAccessibleDescription(/Escape로 선택을 풉니다/);
  const panel = page.getByRole("complementary", { name: "노드 상세" });
  const heading = panel.getByTestId("node-heading");

  // Enter로 고르면 상세 제목으로 가고, 고른 노드는 aria-current다. 닫으면 그 노드로 돌아오고 다시 옮기지 않는다.
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(heading).toBeFocused();
  await expect(heading).toContainText("연구 문제 정리 1");
  await expect(first).toHaveAttribute("aria-current", "true");
  await expect(second).not.toHaveAttribute("aria-current", /.*/);
  await panel.getByRole("button", { name: "상세 닫기" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await expect(first).toBeFocused();
  await expect(first).not.toHaveAttribute("aria-current", /.*/);

  // Escape는 선택을 풀고 포커스는 노드에 남는다. 이미 고른 노드의 Enter는 다시 제목으로 간다.
  await page.keyboard.press("Enter");
  await expect(heading).toBeFocused();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(heading).toBeFocused();
  await first.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/node=/);
  await expect(first).toBeFocused();

  // 포인터로 골라도 제목으로 간다.
  await second.click();
  await expect(heading).toBeFocused();
  await expect(heading).toContainText("연구 문제 정리 2");

  // 노드 종류는 native radio: Tab 정지 하나, 화살표로 옮기며 고른다.
  await panel.getByRole("button", { name: "＋ 하위 노드" }).click();
  const kinds = panel.getByRole("group", { name: "종류" });
  const checked = kinds.getByRole("radio", { checked: true });
  await expect(checked).toHaveAccessibleName("가설·아이디어");
  await checked.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    kinds.getByRole("radio", { name: "가설·아이디어" })
  ).not.toBeChecked();
  const moved = kinds.getByRole("radio", { checked: true });
  await expect(moved).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByLabel("새 노드 제목")).toBeFocused();
  await panel.getByRole("button", { name: "닫기", exact: true }).click();

  // 주 부모 검색 결과: listbox 하나가 Tab 정지이고 화살표·Home·End로 옮기면 바로 골라진다.
  await panel.getByRole("button", { name: "주 부모 변경" }).click();
  const search = panel.getByLabel("새 주 부모 검색");
  const options = panel.getByRole("listbox", { name: "찾은 노드" });
  await expect(options.getByRole("option")).toHaveCount(2);
  await expect(
    options.getByRole("option", { name: "주 부모 없음 (최상위로)" })
  ).toHaveAttribute("aria-selected", "true");
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(options).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const parentOption = options.getByRole("option", {
    name: /연구 문제 정리 1/,
  });
  await expect(parentOption).toHaveAttribute("aria-selected", "true");
  await expect(options).toHaveAttribute(
    "aria-activedescendant",
    (await parentOption.getAttribute("id"))!
  );
  await page.keyboard.press("Home");
  await expect(
    options.getByRole("option", { name: "주 부모 없음 (최상위로)" })
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(parentOption).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: /주 부모를 .*변경/ })
  ).toBeFocused();
  await search.fill("없는 노드 이름");
  await expect(
    panel.getByRole("status").filter({ hasText: "일치하는 노드 없음" })
  ).toBeVisible();
  await panel.getByRole("button", { name: "닫기", exact: true }).click();

  // 보조 연결: 결과가 없으면 목록은 Tab 정지가 아니다. 키보드로 대상과 연결 종류를 골라 추가한다.
  await panel.getByRole("button", { name: "보조 연결" }).click();
  const target = panel.getByLabel("연결할 노드 검색");
  await target.fill("없는 노드 이름");
  await expect(options.getByRole("option")).toHaveCount(0);
  await expect(options).toHaveAttribute("tabindex", "-1");
  await target.fill("");
  await target.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    options.getByRole("option", { name: /연구 문제 정리 1/ })
  ).toHaveAttribute("aria-selected", "true");
  const linkKinds = panel.getByRole("group", { name: "연결 종류" });
  const firstKind = linkKinds.getByRole("radio", { checked: true });
  const firstKindName = await firstKind.getAttribute("value");
  await firstKind.focus();
  await page.keyboard.press("ArrowRight");
  const chosenKind = linkKinds.getByRole("radio", { checked: true });
  await expect(chosenKind).toBeFocused();
  expect(await chosenKind.getAttribute("value")).not.toBe(firstKindName);
  const kindLabel = (await chosenKind.evaluate(
    (el) => el.parentElement!.textContent
  ))!.trim();
  await panel.getByRole("button", { name: "보조 연결 추가" }).click();
  await expect(panel.getByRole("group", { name: "연결 종류" })).toBeHidden();

  // 폐기: 토스트와 패널이 패널의 `폐기 취소`를 글로 알리고, 포커스는 같은 버튼(이제 폐기 취소)에 남는다.
  await panel.getByRole("button", { name: "폐기", exact: true }).focus();
  await page.keyboard.press("Enter");
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText(
    "노드 상세의 ‘폐기 취소’로도 되돌릴 수 있습니다"
  );
  const restore = panel.getByRole("button", { name: /폐기 취소/ });
  await expect(restore).toBeFocused();
  await expect(restore).toHaveAccessibleDescription(
    /언제든 되돌릴 수 있습니다/
  );
  await expect(panel.getByTestId("node-status")).toHaveText("폐기");
  await expectReadable(page);

  // 글로 보기: 모든 노드의 종류·상태·주 부모와 방향·종류가 있는 보조 연결. 폐기한 노드도 상태로 보인다.
  const text = page.getByTestId("map-text-view");
  await text.getByText(/노드·연결을 글로 보기/).focus();
  await page.keyboard.press("Enter");
  const rows = text.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "연구 문제 정리 2" })).toContainText(
    "폐기"
  );
  await expect(rows.filter({ hasText: "연구 문제 정리 1" })).toContainText(
    "없음 (최상위)"
  );
  await expect(text.getByRole("listitem")).toHaveText(
    `“연구 문제 정리 2” → “연구 문제 정리 1”: ${kindLabel}`
  );
  await expectReadable(page);
  // 표의 노드 이름은 지도에서 고른 것과 같이 상세를 연다.
  await text.getByRole("button", { name: "연구 문제 정리 1" }).click();
  await expect(heading).toBeFocused();
  await expect(heading).toContainText("연구 문제 정리 1");

  // 패널에서 폐기를 되돌린다(시간이 지난 토스트를 놓쳐도 같은 버튼이 남는다).
  await text.getByRole("button", { name: "연구 문제 정리 2" }).click();
  await panel.getByRole("button", { name: /폐기 취소/ }).click();
  await expect(panel.getByTestId("node-status")).not.toHaveText("폐기");

  // 고른 노드가 지도에서 사라지면(다른 곳의 조회 결과) 패널이 닫히고 포커스는 지도의 `한눈에 보기`로 간다.
  await heading.focus();
  const gone = new URL(page.url()).searchParams.get("node")!;
  await page.route(`**${org.api("/research-map")}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      nodes: { id: string }[];
      links: { sourceNodeId: string; targetNodeId: string }[];
    };
    body.nodes = body.nodes.filter((n) => n.id !== gone);
    body.links = body.links.filter(
      (l) => l.sourceNodeId !== gone && l.targetNodeId !== gone
    );
    await route.fulfill({ response, json: body });
  });
  await page.request.post(org.api("/research-nodes"), {
    data: { kind: "problem", title: "새로 생긴 최상위 노드" },
  });
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "한눈에 보기" })).toBeFocused();
  await page.unrouteAll({ behavior: "wait" });

  // 조직도: 다른 이름과 실제로 되는 조작만 적은 안내, 같은 구성원의 글 목록.
  await openWithLiveEvents(page, `/orgs/${org.id}/agents`);
  const chart = page.getByRole("application", {
    name: "에이전트 조직도 그래프",
  });
  await expect(chart).toHaveAccessibleDescription(
    /Tab으로 옮겨 다니고 Enter로 엽니다/
  );
  await expect(chart).not.toHaveAccessibleDescription(/화살표|Escape|Space/);
  const members = page.getByTestId("org-chart-text");
  await members.getByText(/구성원 목록으로 보기/).click();
  await expect(members).toContainText("Research Lead 1명 · 작업자 2명");
  const workers = members.getByRole("list", { name: /아래 작업자/ });
  await expect(workers.getByRole("link")).toHaveCount(2);
  await expect(chart.locator("[data-agent-node]")).toHaveCount(3);
  await expectReadable(page);
  const firstWorker = workers.getByRole("link").first();
  const workerName = (await firstWorker.textContent())!;
  await firstWorker.click();
  await expect(page.getByRole("button", { name: workerName })).toBeVisible();
});

test("field errors are linked to their field and focused on submit, while server, network and decided errors stay form-level", async ({
  page,
}) => {
  const org = await createOrganization(page, "A11y forms");

  // 승인: 사용자가 바꾼 작업자 칸만 서버가 다시 확인한다. Lead 제안 그대로인 칸(여기서는 서버에 없는 연결)은 막지 않는다.
  await page.route(
    `**${org.api(`/approvals/${org.approvalId}`)}`,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        proposal: { team: { choice?: unknown }[] };
      };
      body.proposal.team[0]!.choice = {
        provider: "gone-provider",
        model: null,
      };
      await route.fulfill({ response, json: body });
    }
  );
  await openWithLiveEvents(page, `/orgs/${org.id}/approvals/${org.approvalId}`);
  const decision = page.getByRole("region", { name: "결정" });
  const field = (i: number, part: "provider" | "model") =>
    decision.locator(`#worker-choice-${org.approvalId}-${i}-${part}`);
  const approve = decision.getByRole("button", { name: "승인", exact: true });
  await field(1, "provider").selectOption({ label: "가짜 프로바이더 2" });
  await field(1, "model").selectOption({ label: "미니" });
  // 고른 뒤 서버의 모델 목록이 바뀌어 서버가 그 모델을 거부한다. 목록을 다시 받아 그 칸의 오류로 알리고 그 칸으로 간다.
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      providers: { id: string; models: { id: string }[] }[];
    };
    const second = body.providers.find((p) => p.id === "fake-2")!;
    second.models = second.models.filter((m) => m.id !== "fake-2-mini");
    await route.fulfill({ response, json: body });
  });
  let decisions = 0;
  const replies = [
    { status: 422, json: { error: { code: "unknown_model" } } },
    { status: 500, json: { error: { code: "internal" } } },
    { status: 409, json: { error: { code: "already_decided" } } },
  ];
  await page.route(
    `**${org.api(`/approvals/${org.approvalId}/decision`)}`,
    (route) => route.fulfill(replies[decisions++]!)
  );
  await approve.click();
  await expect(field(1, "model")).toBeFocused();
  await expect(field(1, "model")).toHaveAttribute("aria-invalid", "true");
  await expect(field(1, "model")).toHaveAccessibleDescription(
    /이 연결의 목록에 없는 모델입니다/
  );
  await expect(decision.getByRole("alert")).toContainText(
    "서버가 고른 프로바이더나 모델을 받지 않았습니다"
  );
  // Lead 제안 그대로인 칸은 서버에 없는 연결이어도 잘못됐다고 하지 않는다.
  await expect(field(0, "provider")).not.toHaveAttribute("aria-invalid", /.*/);
  await expectReadable(page);
  // 고치지 않고 다시 승인하면 보내지 않고 그 칸으로 간다. 고치면 오류와 연결이 사라진다.
  await field(0, "provider").focus();
  await approve.click();
  await expect(field(1, "model")).toBeFocused();
  expect(decisions).toBe(1);
  await field(1, "model").selectOption({ label: "기본 모델" });
  await expect(field(1, "model")).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(field(1, "model")).toHaveAccessibleDescription("");
  // 통신·서버 오류와 이미 결정됨은 폼 아래 안내이고 어느 칸도 잘못됐다고 하지 않는다.
  await approve.click();
  await expect(decision.getByRole("alert")).toHaveText(
    "보내지 못했습니다. 다시 시도하세요."
  );
  await expect(decision.locator('[aria-invalid="true"]')).toHaveCount(0);
  await approve.click();
  await expect(decision.getByRole("alert")).toContainText(
    "이미 결정된 요청입니다"
  );
  await expect(decision.locator('[aria-invalid="true"]')).toHaveCount(0);
  expect(decisions).toBe(3);
  await page.unrouteAll({ behavior: "wait" });

  // 에이전트 이름: 같은 이름은 이름 칸의 오류, 저장 실패는 칸과 잇지 않는 안내다.
  await page.request.post(org.api(`/approvals/${org.approvalId}/decision`), {
    data: { decision: "approve" },
  });
  let agents: { id: string; role: string; name: string }[] = [];
  await expect
    .poll(async () => {
      const detail = (await (await page.request.get(org.api(""))).json()) as {
        agents: typeof agents;
      };
      agents = detail.agents;
      return agents.length;
    }, runs)
    .toBe(3);
  const worker = agents.find((a) => a.role === "worker")!;
  const lead = agents.find((a) => a.role === "lead")!;
  await openWithLiveEvents(page, `/orgs/${org.id}/agents/${worker.id}`);
  await page.getByRole("button", { name: worker.name }).click();
  const name = page.getByLabel("에이전트 이름");
  await name.fill(lead.name);
  await name.press("Enter");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription(
    /같은 이름의 에이전트가 이미 있습니다/
  );
  await expect(name).toBeFocused();
  await expectReadable(page);
  await name.press("End");
  await name.press("2");
  await expect(name).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(name).toHaveAccessibleDescription("");
  await page.route(`**${org.api(`/agents/${worker.id}`)}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { error: { code: "internal" } } })
      : route.fallback()
  );
  await name.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "이름을 바꾸지 못했습니다. 다시 시도하세요."
  );
  await expect(name).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(name).toHaveAccessibleDescription("");
  await name.press("Escape");
  await page.unrouteAll({ behavior: "wait" });

  // 전역 설정: 서버에 없는 Lead 기본 연결은 저장할 때 그 칸으로 간다. 보내지 않는다.
  let saves = 0;
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { leadDefault: unknown };
    body.leadDefault = { provider: "gone-provider", model: null };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/providers/defaults", (route) => {
    saves++;
    return route.fulfill({
      status: 500,
      json: { error: { code: "internal" } },
    });
  });
  await openWithLiveEvents(page, "/settings");
  const defaults = page.getByRole("form", { name: "기본 프로바이더" });
  await defaults.getByRole("button", { name: "압축 기준 늘리기" }).click();
  await defaults.getByRole("button", { name: "저장" }).click();
  const leadProvider = defaults.locator("#lead-default-provider");
  await expect(leadProvider).toBeFocused();
  await expect(leadProvider).toHaveAttribute("aria-invalid", "true");
  await expect(leadProvider).toHaveAccessibleDescription(
    /이 서버에 없는 연결입니다/
  );
  expect(saves).toBe(0);
  await expectReadable(page);
  await leadProvider.selectOption("fake");
  await expect(leadProvider).not.toHaveAttribute("aria-invalid", /.*/);
  await defaults.getByRole("button", { name: "저장" }).click();
  await expect(defaults.getByRole("alert")).toHaveText(
    "저장하지 못했습니다. 다시 시도하세요."
  );
  expect(saves).toBe(1);
  await expect(defaults.locator('[aria-invalid="true"]')).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
});

test("instant switches tell which setting saved, never on load or failure, and a new save does not read as the old success", async ({
  page,
}) => {
  const org = await createOrganization(page, "A11y switches");
  await openWithLiveEvents(page, `/orgs/${org.id}/settings`);
  const policy = page.getByRole("checkbox", { name: /작업자 추가/ });
  const label = (await policy.evaluate(
    (el) => (el as HTMLInputElement).labels![0]!.textContent
  ))!.trim();
  // 처음 연 화면에는 저장 결과가 없다.
  await expect(policy).toHaveAccessibleDescription("");
  const before = await policy.isChecked();
  await policy.focus();
  await page.keyboard.press("Space");
  await expect(policy).toHaveAccessibleDescription(`${label} 저장됨`);
  expect(await policy.isChecked()).toBe(!before);
  await expect(policy).toBeFocused();
  // 실패하면 성공을 알리지 않고, 오류와 함께 저장된 값으로 돌아간다.
  await page.route(`**${org.api("/approval-policy")}`, (route) =>
    route.fulfill({ status: 500, json: { error: { code: "internal" } } })
  );
  await policy.click();
  await expect(page.getByRole("alert")).toHaveText(
    `${label} 설정을 저장하지 못했습니다. 다시 시도하세요.`
  );
  await expect(policy).toHaveAccessibleDescription("");
  expect(await policy.isChecked()).toBe(!before);
  await page.unrouteAll({ behavior: "wait" });
  await policy.click();
  await expect(policy).toHaveAccessibleDescription(`${label} 저장됨`);
  expect(await policy.isChecked()).toBe(before);
  await expectReadable(page);

  // 전역 격리 실행: 두 번째 저장 동안은 `저장하는 중…`이고, 끝나야 다시 `저장됨`이다. 켠 것은 되돌린다.
  await openWithLiveEvents(page, "/settings");
  const isolation = page.getByRole("switch", { name: "격리 실행" });
  await expect(isolation).toHaveAccessibleDescription("");
  const was = await isolation.isChecked();
  await isolation.click();
  await expect(isolation).toHaveAccessibleDescription("격리 실행 저장됨");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/providers/isolation", async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await isolation.click();
    await expect(isolation).toHaveAccessibleDescription(
      "격리 실행 저장하는 중…"
    );
    release();
    await expect(isolation).toHaveAccessibleDescription("격리 실행 저장됨");
    expect(await isolation.isChecked()).toBe(was);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a policy switch's saving or saved state stays with its organization when history jumps to another organization's settings", async ({
  page,
}) => {
  const a = await createOrganization(page, "A11y switch owner");
  const b = await createOrganization(page, "A11y switch other");
  const policy = page.getByRole("checkbox", { name: /작업자 추가/ });
  // B 설정을 먼저 열어 캐시에 두고, 화면 안 이동으로 A 설정에 간다. 기록: B 설정 → A 대시보드 → A 설정.
  await openWithLiveEvents(page, `/orgs/${b.id}/settings`);
  await expect(policy).not.toBeChecked();
  await page.getByRole("link", { name: /^A11y switch owner · / }).click();
  await page
    .getByRole("navigation", { name: "조직 화면" })
    .getByRole("link", { name: "설정", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${a.id}/settings$`));
  // 뒤로 가기 목록에서 B 설정을 바로 고르는 이동(history.go(-2))은 A 설정에서 B 설정으로 곧장 바뀐다.
  const jumpToOther = async () => {
    await page.evaluate(() => history.go(-2));
    await expect(page).toHaveURL(new RegExp(`/orgs/${b.id}/settings$`));
  };
  const backToOwner = async () => {
    await page.evaluate(() => history.go(2));
    await expect(page).toHaveURL(new RegExp(`/orgs/${a.id}/settings$`));
  };

  // A의 저장이 끝나기 전에 B로 가면 B 스위치는 잠기지 않고 B의 저장된 값·빈 상태를 보인다. A가 끝나도 그대로다.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${a.api("/approval-policy")}`, async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await policy.click();
    await expect(policy).toHaveAccessibleDescription(/저장하는 중…$/);
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(a.api("/approval-policy")) && r.ok()
    );
    await jumpToOther();
    await expect(policy).not.toBeChecked();
    await expect(policy).not.toHaveAttribute("aria-disabled");
    await expect(policy).toHaveAccessibleDescription("");
    release();
    await saved;
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(policy).not.toBeChecked();
  await expect(policy).toHaveAccessibleDescription("");

  // A에서 저장을 마친 `저장됨`도 B에 따라오지 않는다.
  await backToOwner();
  await expect(policy).toBeChecked();
  await policy.click();
  await expect(policy).toHaveAccessibleDescription(/저장됨$/);
  await jumpToOther();
  await expect(policy).not.toBeChecked();
  await expect(policy).toHaveAccessibleDescription("");
});

test("a clipped Inbox excerpt says so and links to the original screen, where the long text is whole", async ({
  page,
}) => {
  const org = await createOrganization(page, "A11y excerpt");
  const plan = [
    "# 긴 계획",
    ...Array.from({ length: 30 }, (_, i) => `- 계획 단계 ${i + 1}`),
    "마지막 계획 줄",
  ].join("\n");
  await page.route(
    `**${org.api(`/approvals/${org.approvalId}`)}`,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        proposal: { plan: string; environment: string };
      };
      body.proposal.plan = plan;
      body.proposal.environment = "짧은 명세";
      await route.fulfill({ response, json: body });
    }
  );
  await openWithLiveEvents(page, `/inbox/${org.id}/approval/${org.approvalId}`);
  const excerpt = page.getByRole("region", { name: "초기 연구 계획" });
  await expect(excerpt).toContainText("앞부분만 보입니다.");
  const more = excerpt.getByRole("link", {
    name: "초기 연구 계획 전체를 원래 화면에서 보기 →",
  });
  // 잘리지 않은 발췌에는 안내가 없다. 펼치기 버튼은 두지 않는다.
  await expect(
    page.getByRole("region", { name: "연구 환경 명세" })
  ).not.toContainText("앞부분만 보입니다");
  await expect(excerpt.getByRole("button")).toHaveCount(0);
  await expectReadable(page);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/orgs/${org.id}/approvals/${org.approvalId}$`)
  );
  const last = page.getByText("마지막 계획 줄");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test("reduced motion stops spin and pulse loops while normal motion keeps them, and loading still reads as status", async ({
  page,
}) => {
  const org = await createOrganization(page, "A11y motion");
  const probe = async () => {
    await openWithLiveEvents(page, `/orgs/${org.id}/dashboard`);
    await expect(page.getByRole("figure", { name: "실행 시도" })).toBeVisible();
    return page.evaluate(() =>
      ["animate-spin", "animate-pulse"].map((name) => {
        const el = document.createElement("span");
        el.className = name;
        document.body.append(el);
        const { animationName, animationIterationCount } = getComputedStyle(el);
        el.remove();
        return `${animationName} ${animationIterationCount}`;
      })
    );
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await probe()).toEqual(["spin 1", "pulse 1"]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await probe()).toEqual(["spin infinite", "pulse infinite"]);
  // 불러오는 중 자리 표시도 글로 읽힌다.
  await page.route(`**${org.api("/dashboard*")}`, () => undefined);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/orgs/${org.id}/dashboard`);
    await expect(
      page.getByRole("status").filter({ hasText: "불러오는 중…" }).first()
    ).toBeAttached();
  } finally {
    // 붙잡은 요청은 끝내지 않고 버린다.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

/** 주요 화면이 옆으로 넘치지 않고 핵심 조작이 화면에 닿는지 본다. */
async function expectMainScreensFit(page: Page, org: Org, at: string) {
  for (const [path, ready] of [
    [
      `/orgs/${org.id}/map`,
      page.getByRole("application", { name: "연구 지도 그래프" }),
    ],
    [`/orgs/${org.id}/chat`, page.getByRole("region", { name: "대화 내용" })],
    [
      `/orgs/${org.id}/dashboard`,
      page.getByRole("figure", { name: "실행 시도" }),
    ],
    [
      `/orgs/${org.id}/settings`,
      page.getByRole("checkbox", { name: /작업자 추가/ }),
    ],
  ] as const) {
    await openWithLiveEvents(page, path);
    await expect(ready, `${path} @${at}`).toBeVisible({ timeout: 20_000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      `${path} @${at}`
    ).toBe(true);
    await ready.scrollIntoViewIfNeeded();
    await expect(ready).toBeInViewport();
  }
}

test("at 390, 768 and 1280 px the main screens do not scroll sideways and keep their controls reachable", async ({
  page,
}) => {
  const org = await researchingOrganization(page, "A11y widths");
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expectMainScreensFit(page, org, `${width}px`);
  }
});

test("at 200% browser zoom of a 1280 px window the main screens do not scroll sideways and keep their controls reachable", async ({
  page,
  baseURL,
}, testInfo) => {
  const org = await researchingOrganization(page, "A11y zoom");
  const zoomed = await launchZoomed({
    baseURL: baseURL!,
    profileDir: testInfo.outputPath("zoomed-profile"),
    zoom: 2,
    window: { width: 1280, height: 800 },
  });
  try {
    const view = zoomed.pages()[0] ?? (await zoomed.newPage());
    await view.goto("/");
    // 창 폭 1280px의 200% 확대: CSS 폭은 절반, 화소 비율은 2다.
    expect(
      await view.evaluate(() => [window.innerWidth, window.devicePixelRatio])
    ).toEqual([640, 2]);
    await expectMainScreensFit(view, org, "200%");
  } finally {
    await zoomed.close();
  }
});
