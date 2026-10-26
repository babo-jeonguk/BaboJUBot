import { expect, test, type Page } from "@playwright/test";

// 연구 지도 성능 측정(#51 통과 기준 조합). 기본 검사에서는 건너뛰고 `MAP_PERF=1 pnpm test:e2e research-map-perf`로 실행한다(노드 수는 MAP_PERF_SIZES=50,200).
// Playwright 설정은 화면을 프로덕션 빌드(vite preview)로 띄운다. 헤드리스 Chromium 소프트웨어 렌더링 값이라 실제 GPU
// 프레임이 아니며, 변경 전후·조합끼리 비교하는 용도다.
test.skip(!process.env.MAP_PERF, "MAP_PERF=1일 때만 측정한다");
// 실패 대비 trace 기록은 동작마다 화면을 남겨 측정값을 낮춘다.
test.use({ trace: "off" });

const sizes = process.env.MAP_PERF_SIZES?.split(",").map(Number) ?? [
  50, 200, 500,
];
const linkRatios = [0, 0.2, 1];
const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const kinds = ["problem", "hypothesis", "method", "experiment", "result"];
const linkKinds = ["supports", "refutes", "relates"];

/** 고정 seed 난수. 조합마다 같은 지도를 만든다. */
function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

async function researchingOrganization(page: Page, name: string) {
  const org = (await (
    await page.request.post("/api/organizations", { data: { name } })
  ).json()) as { id: string };
  await page.request.post(`/api/organizations/${org.id}/messages`, {
    data: { body: "목표: 성능 측정\n완료 기준: 측정값" },
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
  await page.request.post(
    `/api/organizations/${org.id}/approvals/${approvalId}/decision`,
    { data: { decision: "approve" } }
  );
  return org.id;
}

/** 주 연결 forest: 노드마다 앞선 노드(깊이 4 미만) 하나를 주 부모로 고르거나 root가 된다. */
async function seedNodes(page: Page, orgId: string, count: number) {
  const rand = random(count);
  const nodes: { id: string; depth: number }[] = [];
  for (let i = 0; i < count; i++) {
    const parents = nodes.filter((n) => n.depth < 4);
    const parent =
      i < 3 || rand() < 0.05
        ? undefined
        : parents[Math.floor(rand() * parents.length)];
    const depth = parent ? parent.depth + 1 : 0;
    const res = await page.request.post(
      `/api/organizations/${orgId}/research-nodes`,
      {
        data: {
          kind: kinds[depth],
          title: `측정 노드 ${i} — 긴 한국어 제목으로 줄바꿈과 말줄임을 확인한다`,
          parentNodeId: parent?.id,
        },
      }
    );
    expect(res.status()).toBe(201);
    nodes.push({ id: ((await res.json()) as { id: string }).id, depth });
  }
  return nodes;
}

async function seedLinks(
  page: Page,
  orgId: string,
  nodes: { id: string }[],
  count: number,
  seed: number
) {
  const rand = random(seed);
  const pick = () => nodes[Math.floor(rand() * nodes.length)]!.id;
  for (let i = 0; i < count; i++) {
    const source = pick();
    let target = pick();
    while (target === source) target = pick();
    const res = await page.request.post(
      `/api/organizations/${orgId}/research-links`,
      {
        data: {
          sourceNodeId: source,
          targetNodeId: target,
          kind: linkKinds[i % linkKinds.length],
        },
      }
    );
    expect(res.status()).toBe(201);
  }
}

type Row = {
  nodes: number;
  links: number;
  viewport: string;
  openMs: number;
  panFps: number;
  zoomFps: number;
  dragFps: number;
  selectMs: number;
  reselectMs: number;
  findMs: number;
  editMs: number;
};

/** fn 동안 그려진 animation frame의 초당 수. */
async function fps(page: Page, fn: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { frames_: number; stop_: boolean };
    w.frames_ = 0;
    w.stop_ = false;
    const tick = () => {
      w.frames_++;
      if (!w.stop_) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await fn();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { frames_: number; stop_: boolean };
    w.stop_ = true;
    return w.frames_;
  });
  return Math.round((frames * 1000) / (Date.now() - t0));
}

/** 지도 화면 안에 다 보이는 카드의 노드 ID와 가운데 좌표. */
const cardsInView = (page: Page) =>
  page.evaluate(() => {
    const c = document
      .querySelector('[data-testid="map-canvas"]')!
      .getBoundingClientRect();
    return [
      ...document.querySelectorAll<HTMLElement>('[data-testid="map-node"]'),
    ]
      .map((e) => ({ id: e.dataset.nodeId!, r: e.getBoundingClientRect() }))
      .filter(
        ({ r }) =>
          r.top > c.top + 4 &&
          r.bottom < c.bottom - 4 &&
          r.left > c.left + 4 &&
          r.right < c.right - 4
      )
      .map(({ id, r }) => ({
        id,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      }));
  });

/** 화면 안 카드 n개. 모자라면 화면 맞춤을 누른다. */
async function cards(page: Page, n: number) {
  let found = await cardsInView(page);
  if (found.length < n) {
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(500);
    found = await cardsInView(page);
  }
  if (found.length < n) throw new Error(`화면 안 카드가 ${n}개보다 적다`);
  return found;
}

/** 노드를 눌러 상세 패널 머리에 그 노드가 보이고 다음 프레임이 그려질 때까지. */
const selectMs = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const t = performance.now();
    document
      .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
      .click();
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      if (
        document.querySelector(`[data-testid="node-detail"] [title="${id}"]`)
      ) {
        await new Promise((r) => requestAnimationFrame(r));
        return Math.round(performance.now() - t);
      }
    }
  }, id);

/**
 * 지도를 열어 첫 카드가 보일 때까지, 화면 끌기·휠 확대 축소·노드 끌기(하위 함께) fps, 노드 선택(패널 열기)과 다른 노드 선택
 * 지연, 보조 연결 대상 찾기, 제목 편집이 카드에 반영되기까지를 잰다.
 */
async function measure(
  page: Page,
  orgId: string,
  target: { id: string },
  far: { id: string }
): Promise<Omit<Row, "nodes" | "links" | "viewport">> {
  const opened = Date.now();
  await page.goto(`/orgs/${orgId}/map`, { waitUntil: "commit" });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="map-node"]'),
    null,
    { polling: "raf", timeout: 30_000 }
  );
  const openMs = Date.now() - opened;
  await page.waitForTimeout(800);

  // 화면 끌기: 빈 pane 한 점을 잡고 끈다.
  const canvas = (await page.getByTestId("map-canvas").boundingBox())!;
  const start = await page.evaluate((box) => {
    for (let y = box.y + 20; y < box.y + box.height - 60; y += 15)
      for (let x = box.x + 60; x < box.x + box.width - 20; x += 15)
        if (
          document
            .elementFromPoint(x, y)
            ?.classList.contains("react-flow__pane")
        )
          return { x, y };
    return null;
  }, canvas);
  if (!start) throw new Error("빈 pane을 찾지 못했다");
  const panFps = await fps(page, async () => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++)
      await page.mouse.move(
        start.x + Math.sin((i / 60) * Math.PI * 2) * 120,
        start.y + i
      );
    await page.mouse.up();
  });

  // 휠 확대 뒤 축소.
  const zoomFps = await fps(page, async () => {
    await page.mouse.move(
      canvas.x + canvas.width / 2,
      canvas.y + canvas.height / 2
    );
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, i < 15 ? -60 : 60);
  });
  await page.waitForTimeout(800);

  // 노드 끌기: 화면 안 카드 하나를 하위 노드와 함께 끈다(보기 상태).
  const [grab] = await cards(page, 1);
  const dragFps = await fps(page, async () => {
    await page.mouse.move(grab!.x, grab!.y);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++)
      await page.mouse.move(grab!.x + i * 2, grab!.y + Math.sin(i / 10) * 40);
    await page.mouse.up();
  });
  await page.getByRole("button", { name: /자동 정렬로 되돌리기/ }).click();
  await page.waitForTimeout(500);

  // 노드 선택(상세 패널이 열린다)과, 패널이 열린 채 다른 노드 선택.
  const [first] = await cards(page, 1);
  const select = await selectMs(page, first!.id);
  await page.waitForTimeout(300);
  const second = (await cards(page, 2)).find((c) => c.id !== first!.id)!;
  const reselect = await selectMs(page, second.id);

  // 찾기: 보조 연결 대상 목록에서 마지막에 만든 노드를 ID로 찾는다.
  const panel = page.getByRole("complementary", { name: "노드 상세" });
  await panel.getByRole("button", { name: "보조 연결" }).click();
  const findStart = Date.now();
  await panel.getByLabel("연결할 노드 검색 (ID·제목)").fill(far.id.slice(0, 8));
  await expect(
    panel.getByRole("option", { name: new RegExp(far.id.slice(0, 8)) })
  ).toBeVisible();
  const findMs = Date.now() - findStart;

  // 편집: 고른 노드의 제목을 바꿔 카드에 반영될 때까지.
  // 보이는 노드만 그리는 지도도 같은 순서로 잴 수 있게 먼저 그 노드로 이동한다.
  await page.goto(`/orgs/${orgId}/map?node=${target.id}`);
  await panel.getByRole("button", { name: "지도에서 이 노드로 이동" }).click();
  const title = `편집 ${Date.now()}`;
  await panel.getByLabel("제목", { exact: true }).fill(title);
  const editStart = Date.now();
  await panel.getByRole("button", { name: "제목 저장" }).click();
  await expect(
    page.locator(`[data-testid="map-node"][data-node-id="${target.id}"]`)
  ).toContainText(title);
  const editMs = Date.now() - editStart;
  return {
    openMs,
    panFps,
    zoomFps,
    dragFps,
    selectMs: select,
    reselectMs: reselect,
    findMs,
    editMs,
  };
}

test("research map performance across node counts, secondary link ratios and widths", async ({
  page,
}, info) => {
  test.setTimeout(60 * 60_000);
  const rows: Row[] = [];
  for (const size of sizes) {
    const orgId = await researchingOrganization(page, `성능 ${size}노드`);
    const nodes = await seedNodes(page, orgId, size);
    let links = 0;
    for (const ratio of linkRatios) {
      const want = Math.round(size * ratio);
      await seedLinks(page, orgId, nodes, want - links, size + want);
      links = want;
      for (const vp of viewports) {
        await page.setViewportSize(vp);
        const row = await measure(page, orgId, nodes[0]!, nodes.at(-1)!);
        rows.push({ nodes: size, links, viewport: `${vp.width}px`, ...row });
        console.log(JSON.stringify(rows.at(-1)));
      }
    }
  }
  console.table(rows);
  await info.attach("research-map-perf.json", {
    body: JSON.stringify(rows, null, 2),
    contentType: "application/json",
  });
});
