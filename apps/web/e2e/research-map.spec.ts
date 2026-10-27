import { expect, test, type Page } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";

/**
 * 연구 지도 화면을 연다. 지도 화면은 셸이 뜬 뒤 따로 불러오는 코드·조회를 거쳐 그려져, 새 context의 첫 표시는
 * 기기 부하에 따라 구독 성립 뒤에도 수 초가 걸린다(부하 평균 약 10에서 3.6~6.5초, CPU 2배 감속 4~11초).
 * 그려질 때까지를 화면 이동으로 보고 테스트 시간 안에서 기다리며, 그 뒤 검사는 기본 기대 시간을 쓴다.
 */
async function openMap(page: Page, path: string) {
  await openWithLiveEvents(page, path);
  const heading = page.getByRole("heading", { name: "연구 지도", level: 1 });
  // 조회 실패 안내가 뜨면 기다리지 않고 바로 실패한다.
  await heading.or(page.getByRole("alert")).first().waitFor();
  await expect(heading).toBeVisible();
}

/** 주소의 선택 노드(`?node=`)와 상세 패널의 노드가 서로 다른 가장 긴 구간(ms)을 매 프레임 잰다. 돌려받은 함수가 재기를 멈추고 값을 준다. */
async function watchSelectionLag(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      selectionLag: { max: number; on: boolean };
    };
    const lag = (w.selectionLag = { max: 0, on: true });
    let since: number | undefined;
    const tick = (t: number) => {
      const wanted = new URL(location.href).searchParams.get("node");
      const shown = document
        .querySelector('[data-testid="node-detail"]')
        ?.getAttribute("data-node-id");
      if (wanted && shown && wanted !== shown) {
        since ??= t;
        lag.max = Math.max(lag.max, t - since);
      } else since = undefined;
      if (lag.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as {
        selectionLag: { max: number; on: boolean };
      };
      w.selectionLag.on = false;
      return w.selectionLag.max;
    });
}

/** 승인을 받아 가짜 작업자들이 작업마다 연구 노드를 만든 조직. */
async function researchingOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name },
  });
  const org = (await created.json()) as { id: string };
  await page.request.post(`/api/organizations/${org.id}/messages`, {
    data: { body: "목표: 오류 유형을 정리한다\n완료 기준: 유형 목록" },
  });
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(
        `/api/organizations/${org.id}/approvals`
      );
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    })
    .not.toBe("");
  return { id: org.id, approvalId };
}

const mapEditCount = async (page: Page, orgId: string) =>
  (
    (await (
      await page.request.get(`/api/organizations/${orgId}/events`)
    ).json()) as { type: string }[]
  ).filter((e) => e.type === "research_map.edited").length;

test("the owner sees the primary tree with faint secondary links, edits the map in the detail panel live, and each edit wakes the Lead", async ({
  page,
  context,
}) => {
  const org = await researchingOrganization(page, "지도 E2E 조직");
  await openMap(page, `/orgs/${org.id}/map`);
  await expect(page.getByRole("main")).toContainText(
    "아직 연구 지도가 없습니다"
  );

  // 승인하면 가짜 작업자가 작업마다 연구 노드를 만들어 작업을 잇는다. 새로고침 없이 지도에 나타난다.
  await page.request.post(
    `/api/organizations/${org.id}/approvals/${org.approvalId}/decision`,
    { data: { decision: "approve" } }
  );
  const runs = { timeout: 20_000 };
  const cards = page.getByTestId("map-node");
  await expect(cards).toHaveCount(2, runs);
  const first = cards.filter({ hasText: "연구 문제 정리 1" });
  await expect(first).toContainText("연구 문제");
  await expect(first).toContainText("작업 1", runs);

  // 노드를 고르면 상세 패널: 종류·상태·연결 작업과 산출물.
  await first.click();
  await expect(page).toHaveURL(/[?&]node=[0-9a-f-]{36}/);
  const panel = page.getByRole("complementary", { name: "노드 상세" });
  await expect(panel.getByTestId("node-status")).toHaveText("제안됨");
  const linked = panel.getByRole("region", { name: "연결 작업" });
  await expect(
    linked.getByRole("link", { name: /연구 문제 정리 1/ })
  ).toHaveCount(2, runs);

  // 다른 탭에서도 같은 지도가 새로고침 없이 갱신된다.
  const other = await context.newPage();
  await openMap(other, `/orgs/${org.id}/map`);
  await expect(other.getByTestId("map-node")).toHaveCount(2);

  // 하위 노드 추가: 종류 기본값은 부모 다음 단계다.
  await panel.getByRole("button", { name: "＋ 하위 노드" }).click();
  await expect(
    panel.getByRole("radio", { name: "가설·아이디어" })
  ).toHaveAttribute("aria-checked", "true");
  await panel.getByLabel("새 노드 제목").fill("잡음 구간이 오류의 원인이다");
  // 추가한 노드가 선택되면 주소와 같은 때에 패널도 그 노드로 바뀐다. 편집 Event 재조회가 몰리는 느린 기기에서도
  // 이전 노드를 보이며 입력을 받지 않는다(CPU 4배 감속에서 라우터 transition 사용 시 0.8~1.5초, 끈 뒤 0초).
  // 패널이 새 노드를 보인 뒤에 편집한다. 그 전에 편집하면 부모 노드가 바뀐다.
  const lag = await watchSelectionLag(page);
  const cpu = await context.newCDPSession(page);
  await cpu.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await panel.getByRole("button", { name: "노드 추가" }).click();
  await expect(cards).toHaveCount(3);
  await expect(panel.getByLabel("제목", { exact: true })).toHaveValue(
    "잡음 구간이 오류의 원인이다",
    runs
  );
  await cpu.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  expect(await lag()).toBeLessThan(300);
  await expect(other.getByTestId("map-node")).toHaveCount(3);
  await expect(panel.getByTestId("node-status")).toHaveText("제안됨");
  await expect(panel).toContainText("연구 문제 정리 1");
  // 주 연결은 노드 아래 정적 레이어에 있고, 고른 노드의 경로는 그 위에 같은 경로로 진하게 겹쳐 그린다.
  const childId = new URL(page.url()).searchParams.get("node")!;
  const curve = async (selector: string) =>
    ((await page.locator(selector).getAttribute("d")) ?? "")
      .match(/-?[\d.]+/g)!
      .map(Number);
  const strong = await curve(
    `.react-flow__edge[data-id="primary:${childId}"] path.react-flow__edge-path`
  );
  const faint = await curve(`svg.rm-layer path[data-id="primary:${childId}"]`);
  expect(faint).toHaveLength(strong.length);
  faint.forEach((v, i) => expect(v).toBeCloseTo(strong[i]!, 0));

  // 제목·상태 수정. 편집 기록에 편집자가 남는다.
  await panel
    .getByLabel("제목", { exact: true })
    .fill("잡음 구간이 오류의 절반을 만든다");
  await panel.getByRole("button", { name: "제목 저장" }).click();
  await expect(
    cards.filter({ hasText: "잡음 구간이 오류의 절반을 만든다" })
  ).toHaveCount(1);
  await panel
    .getByLabel("상태", { exact: true })
    .selectOption({ label: "진행 중" });
  await expect(panel.getByTestId("node-status")).toHaveText("진행 중");
  const history = panel.getByRole("region", { name: "편집 기록" });
  await expect(history.locator('[data-editor="owner"]')).toHaveCount(3);
  await expect(history).toContainText("상태 제안됨 → 진행 중");

  // 주 부모 변경: 다른 문제 아래로.
  await panel.getByRole("button", { name: "주 부모 변경" }).click();
  await panel.getByLabel("새 주 부모 검색").fill("정리 2");
  await panel.getByRole("option", { name: /연구 문제 정리 2/ }).click();
  await panel
    .getByRole("button", { name: /주 부모를 .*연구 문제 정리 2/ })
    .click();
  await expect(panel).toContainText("주 부모");
  await expect(history).toContainText(
    "주 부모: “연구 문제 정리 1” → “연구 문제 정리 2”"
  );

  // 보조 연결 추가: 원래 문제를 뒷받침한다. 주 배치는 바뀌지 않는다.
  const before = await first.boundingBox();
  await panel.getByRole("button", { name: "보조 연결" }).click();
  await panel.getByLabel("연결할 노드 검색").fill("정리 1");
  await panel.getByRole("option", { name: /연구 문제 정리 1/ }).click();
  await panel.getByRole("radio", { name: "뒷받침" }).click();
  await panel.getByRole("button", { name: "보조 연결 추가" }).click();
  await expect(panel.locator("[data-link-id]")).toHaveCount(1);
  await expect(panel.locator("[data-link-id]")).toContainText("─뒷받침→");
  expect(await first.boundingBox()).toEqual(before);

  // 거부·실패한 편집은 지도를 바꾸지 않고 이유를 보이며 입력을 지우지 않는다.
  await page.route(
    `**/api/organizations/${org.id}/research-nodes/*`,
    (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "node_discarded" } }),
          })
        : route.fallback()
  );
  await panel.getByLabel("제목", { exact: true }).fill("저장되지 않을 제목");
  await panel.getByRole("button", { name: "제목 저장" }).click();
  await expect(panel.getByRole("alert")).toContainText("폐기된 노드는");
  await expect(panel.getByLabel("제목", { exact: true })).toHaveValue(
    "저장되지 않을 제목"
  );
  await page.unrouteAll({ behavior: "wait" });

  // 하위·보조 연결·작업이 있는 노드를 폐기해도 기록은 남고, 폐기 취소로 이전 상태로 돌아간다.
  await first.click();
  // 선택이 바뀌어 패널이 첫 노드를 보일 때까지 기다린다. 그 전에 누르면 이전 노드를 폐기하려 한다.
  await expect(page).toHaveURL(
    new RegExp(`[?&]node=${await first.getAttribute("data-node-id")}`)
  );
  await expect(panel.getByLabel("제목", { exact: true })).toHaveValue(
    "연구 문제 정리 1"
  );
  await panel.getByRole("button", { name: "폐기…" }).click();
  const confirm = panel.getByRole("group", { name: "폐기 확인" });
  await expect(confirm).toContainText("보조 연결 1개, 연결 작업 1개");
  await confirm.getByRole("button", { name: "폐기", exact: true }).click();
  await expect(first).toHaveAttribute("data-status", "discarded");
  await expect(panel.getByTestId("node-status")).toHaveText("폐기");
  await expect(
    linked.getByRole("link", { name: /연구 문제 정리 1/ })
  ).toHaveCount(2);
  await panel.getByRole("button", { name: /폐기 취소/ }).click();
  await expect(first).toHaveAttribute("data-status", "proposed");

  // 사용자 편집은 Lead를 깨우고, 가짜 Lead는 받은 편집을 Lead 대화에 짚는다.
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/organizations/${org.id}/messages`)
          ).json()) as { body: string }[]
        ).some((m) => m.body.includes("사용자의 연구 지도 편집")),
      runs
    )
    .toBe(true);

  // 노드 끌기는 보기 상태다. 편집 기록도 Lead 깨우기도 만들지 않는다.
  const edits = await mapEditCount(page, org.id);
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height + 80, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: /자동 정렬로 되돌리기/ })
  ).toBeVisible();
  expect(await mapEditCount(page, org.id)).toBe(edits);

  // 작업 상세에서 연결된 연구 노드로 이동한다.
  await linked.getByRole("link", { name: /연구 문제 정리 1 →/ }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await page
    .getByRole("region", { name: "연결된 연구 노드" })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/\/map\?node=[0-9a-f-]{36}$/);
  await expect(panel).toContainText("연구 문제 정리 1");

  // 좁은 화면에서는 상세 패널이 지도 아래에 쌓인다.
  await page.setViewportSize({ width: 390, height: 844 });
  const canvas = await page.getByTestId("map-canvas").boundingBox();
  const aside = await panel.boundingBox();
  expect(aside!.y).toBeGreaterThanOrEqual(canvas!.y + canvas!.height - 1);
  await panel
    .getByRole("button", { name: "＋ 하위 노드" })
    .scrollIntoViewIfNeeded();
  await expect(
    panel.getByRole("button", { name: "＋ 하위 노드" })
  ).toBeInViewport();
});

test("parallel secondary links between the same two nodes are drawn apart and listed by link ID", async ({
  page,
}) => {
  const org = await researchingOrganization(page, "병렬 보조 연결 조직");
  await page.request.post(
    `/api/organizations/${org.id}/approvals/${org.approvalId}/decision`,
    { data: { decision: "approve" } }
  );
  let nodes: { id: string; title: string }[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/organizations/${org.id}/research-map`
        );
        nodes = ((await res.json()) as { nodes: typeof nodes }).nodes;
        return nodes.length;
      },
      { timeout: 20_000 }
    )
    .toBe(2);
  const [from, to] = nodes;

  // 같은 방향의 두 노드 사이: 종류가 다른 연결 2개와 같은 종류의 연결 2개.
  for (const kind of ["supports", "refutes", "relates", "relates"]) {
    const res = await page.request.post(
      `/api/organizations/${org.id}/research-links`,
      { data: { sourceNodeId: from!.id, targetNodeId: to!.id, kind } }
    );
    expect(res.status()).toBe(201);
  }
  const links = (
    (await (
      await page.request.get(`/api/organizations/${org.id}/research-map`)
    ).json()) as { links: { id: string }[] }
  ).links;
  expect(links).toHaveLength(4);

  // 새 context의 첫 지도 표시를 한 번의 기대 시간에 넣지 않는다. 지도가 그려진 뒤 연결을 검사한다.
  await openMap(page, `/orgs/${org.id}/map?node=${from!.id}`);
  const paths = links.map((l) =>
    page.locator(
      `.react-flow__edge[data-id="${l.id}"] path.react-flow__edge-path`
    )
  );
  for (const p of paths) await expect(p).toHaveCount(1);
  const shapes = await Promise.all(paths.map((p) => p.getAttribute("d")));
  expect(new Set(shapes).size).toBe(4);

  // 연한 보조 연결은 노드 아래 정적 레이어에 있고, 강조한 연결은 그 위에 같은 경로로 겹쳐 그린다.
  const sameCurves = async () => {
    for (const l of links) {
      const curve = async (selector: string) =>
        ((await page.locator(selector).getAttribute("d")) ?? "")
          .match(/-?[\d.]+/g)!
          .map(Number);
      const faint = await curve(`svg.rm-links path[data-id="${l.id}"]`);
      const strong = await curve(
        `.react-flow__edge[data-id="${l.id}"] path.react-flow__edge-path`
      );
      expect(faint).toHaveLength(strong.length);
      faint.forEach((v, i) => expect(v).toBeCloseTo(strong[i]!, 0));
    }
  };
  await sameCurves();

  // 선택한 노드에 닿은 연결의 종류 이름도 서로 겹치지 않는다.
  const labelsApart = async () => {
    const boxes = await page
      .locator(".react-flow__edge-textwrapper")
      .evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect)
      );
    expect(boxes).toHaveLength(4);
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1))
        expect(
          a.bottom <= b.top ||
            b.bottom <= a.top ||
            a.right <= b.left ||
            b.right <= a.left
        ).toBe(true);
  };
  await labelsApart();

  // 상세 패널은 관계마다 한 행씩 보인다. 같은 종류의 두 연결도 따로 보인다.
  const panel = page.getByRole("complementary", { name: "노드 상세" });
  const rows = panel.locator("[data-link-id]");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "─관련→" })).toHaveCount(2);
  for (const l of links)
    await expect(panel.locator(`[data-link-id="${l.id}"]`)).toHaveCount(1);
});
