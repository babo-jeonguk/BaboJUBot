import { expect, test, type Page, type Route } from "@playwright/test";
import { openWithLiveEvents } from "./support/live-events.ts";
import { createSettledOrganization } from "./support/organization.ts";

// 승인 요청·결과 제출의 결정 영역(#144): 이 화면의 성공만 결정 기록으로 포커스를 옮기고, 다른 화면의 결정(Event)과
// 이미 결정됐다는 거절(409), 다른 항목으로 옮긴 뒤의 늦은 응답은 지금 포커스를 그대로 둔다.
// 일시정지·중단 안내는 결정 종류마다 실제 효과를 말한다.

/** 가짜 Lead의 실행 시도를 기다리는 시한. */
const leadWork = { timeout: 30_000 };

type Org = { id: string; api: (path: string) => string };

/** 조직을 만들고 첫 실행 시도(초기 연구 승인 요청)가 끝날 때까지 기다린다. */
async function newOrganization(page: Page, name: string): Promise<Org> {
  const { id } = await createSettledOrganization(page, name);
  return { id, api: (path) => `/api/organizations/${id}${path}` };
}

async function get<T>(page: Page, path: string) {
  const res = await page.request.get(path);
  expect(res.ok(), path).toBe(true);
  return (await res.json()) as T;
}

async function post(page: Page, path: string, data: object = {}) {
  const res = await page.request.post(path, { data });
  expect(res.ok(), path).toBe(true);
}

const stage = (page: Page, org: Org) =>
  get<{ stage: string }>(page, org.api("")).then((o) => o.stage);

/** 방금 생긴 요청·제출을 만든 실행 시도가 끝날 때까지 기다린다. 그 산출물이 보인 뒤에 부른다. */
const runsSettled = (page: Page, org: Org) =>
  expect
    .poll(async () => {
      const list = await get<{ status: string }[]>(page, org.api("/runs"));
      return list.length > 0 && list.every((r) => r.status === "completed");
    }, leadWork)
    .toBe(true);

async function pendingApprovals(page: Page, org: Org, kind: string) {
  const list = await get<{ id: string; kind: string; status: string }[]>(
    page,
    org.api("/approvals")
  );
  return list.filter((a) => a.kind === kind && a.status === "pending");
}

/** 초기 연구 승인 요청을 API로 승인하고, 승인으로 생긴 팀이 첫 작업 두 개를 끝낼 때까지 기다린다. */
async function approveInitial(page: Page, org: Org) {
  const [initial] = await pendingApprovals(page, org, "initial_research");
  expect(initial).toBeDefined();
  await post(page, org.api(`/approvals/${initial!.id}/decision`), {
    decision: "approve",
  });
  await expect
    .poll(async () => {
      const tasks = await get<{ status: string }[]>(page, org.api("/tasks"));
      return tasks.filter((t) => t.status === "completed").length;
    }, leadWork)
    .toBe(2);
}

/** Lead에게 결과 제출을 부탁하고, 새로 생긴 검토 대기 제출의 ID를 돌려준다. */
async function requestResult(page: Page, org: Org) {
  const pending = async () =>
    (
      await get<{ id: string; status: string }[]>(page, org.api("/results"))
    ).find((s) => s.status === "pending")?.id;
  await post(page, org.api("/messages"), { body: "결과 제출 부탁해요" });
  await expect.poll(pending, leadWork).toBeTruthy();
  await runsSettled(page, org);
  return (await pending())!;
}

/**
 * 결정 POST를 가로챈다. `reply`는 서버까지 보내 저장하게 한 뒤 응답만 `release`까지 붙잡아, 그사이 서버의 Event가 응답보다
 * 먼저 화면에 닿게 한다. `sent`는 서버가 응답한 뒤 풀리고, `delivered`는 화면이 응답을 받은 뒤 풀린다. 끝나면 `dispose`로 푼다.
 */
async function holdDecisionReply(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const sent = new Promise<void>((resolve) => (reached = resolve));
  const url = /\/decision$/;
  const delivered = page.waitForEvent("requestfinished", {
    predicate: (request) => url.test(request.url()),
    timeout: 60_000,
  });
  // 앞서 실패해 응답이 끝나지 않으면 이 대기는 page와 함께 거절된다. 기다리지 않은 거절이 다른 오류로 보이지 않게 한다.
  delivered.catch(() => {});
  const handler = async (route: Route) => {
    const response = await route.fetch();
    reached();
    await released;
    await route.fulfill({ response });
  };
  await page.route(url, handler);
  return {
    sent,
    delivered,
    release,
    dispose: async () => {
      release();
      await page.unroute(url, handler);
    },
  };
}

test("an approval decided here focuses its record even when the Event lands before the reply, while another screen keeps its focus", async ({
  page,
  context,
}) => {
  const org = await newOrganization(page, "결정 표시 승인 E2E 조직");
  const [approval] = await pendingApprovals(page, org, "initial_research");
  expect(approval).toBeDefined();
  await post(page, org.api("/pause"));
  const pausedNotice = "조직이 일시정지 중입니다 · 결정하면 재개";

  // 다른 화면: 같은 요청의 Inbox 상세. 결정 영역 밖의 링크에 포커스가 있다.
  const other = await context.newPage();
  await openWithLiveEvents(other, `/inbox/${org.id}/approval/${approval!.id}`);
  const otherDecision = other.getByRole("region", { name: "결정" });
  await expect(otherDecision).toContainText(pausedNotice);
  const kept = other.getByRole("link", { name: /원래 화면에서 자세히 보기/ });
  await kept.focus();
  await expect(kept).toBeFocused();

  // 이 화면: 승인 요청 상세에서 승인한다. 응답보다 Event가 먼저 와 폼이 결정 기록으로 바뀐다.
  const path = `/orgs/${org.id}/approvals/${approval!.id}`;
  await openWithLiveEvents(page, path);
  const decision = page.getByRole("region", { name: "결정" });
  await expect(decision).toContainText(pausedNotice);
  const held = await holdDecisionReply(page);
  try {
    await decision.getByRole("button", { name: "승인" }).click();
    await held.sent;
    await expect(decision).toContainText("승인됨");
    await expect(decision).not.toBeFocused();
    await expect(otherDecision).toContainText("승인됨");
    await expect(kept).toBeFocused();

    // 응답이 닿으면 이 화면의 성공이므로 결정 기록으로 포커스가 간다. 주소와 다른 화면의 포커스는 그대로다.
    held.release();
    await expect(decision).toBeFocused();
    await expect(page).toHaveURL(path);
    await expect(kept).toBeFocused();
    await expect(otherDecision).not.toBeFocused();
  } finally {
    await held.dispose();
  }
  // 일시정지 중의 초기 연구 승인 결정은 조직을 재개한다.
  expect(await stage(page, org)).toBe("researching");
});

test("a stopped organization refuses initial approval decisions but still takes worker requests, which leave a paused organization paused and whose late reply leaves the next item alone", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const closedNotice = "중단된 조직이라 결정할 수 없습니다.";

  // 중단된 조직의 초기 연구 승인: 상세와 Inbox 상세 모두 안내하고 결정 버튼을 잠근다.
  const stopped = await newOrganization(page, "결정 표시 중단 E2E 조직");
  const [initial] = await pendingApprovals(page, stopped, "initial_research");
  await post(page, stopped.api("/stop"));
  for (const path of [
    `/orgs/${stopped.id}/approvals/${initial!.id}`,
    `/inbox/${stopped.id}/approval/${initial!.id}`,
  ]) {
    await page.goto(path);
    const decision = page.getByRole("region", { name: "결정" });
    await expect(decision).toContainText(closedNotice);
    await decision.getByLabel(/결정 사유/).fill("사유가 있어도 막힌다");
    for (const name of ["승인", "수정 요청", "반려"])
      await expect(decision.getByRole("button", { name })).toBeDisabled();
  }

  // 작업자 추가 요청 두 개를 받아 둔다.
  const org = await newOrganization(page, "결정 표시 작업자 E2E 조직");
  await approveInitial(page, org);
  expect(
    (
      await page.request.put(org.api("/approval-policy"), {
        data: { addWorker: true },
      })
    ).ok()
  ).toBe(true);
  for (const count of [1, 2]) {
    await post(page, org.api("/messages"), { body: "작업자 추가: researcher" });
    await expect
      .poll(
        async () => (await pendingApprovals(page, org, "add_worker")).length,
        leadWork
      )
      .toBe(count);
    await runsSettled(page, org);
  }
  const [first, second] = await pendingApprovals(page, org, "add_worker");

  // 일시정지 중: 재개한다는 말 없이 일시정지만 알린다.
  await post(page, org.api("/pause"));
  await openWithLiveEvents(page, `/inbox/${org.id}/approval/${first!.id}`);
  const decision = page.getByRole("region", { name: "결정" });
  await expect(
    decision.getByText("조직이 일시정지 중입니다", { exact: true })
  ).toBeVisible();

  // 승인을 보내고 응답이 오기 전에 Inbox에서 다음 요청으로 옮겨 사유를 쓴다. 늦게 온 응답은 그 요청의 포커스·초안을 건드리지 않는다.
  const held = await holdDecisionReply(page);
  try {
    await decision.getByRole("button", { name: "승인" }).click();
    await held.sent;
    await page.getByRole("button", { name: "Inbox 열기" }).click();
    await page
      .getByRole("complementary", { name: "Inbox" })
      .locator(`a[href="/inbox/${org.id}/approval/${second!.id}"]`)
      .click();
    await expect(page).toHaveURL(`/inbox/${org.id}/approval/${second!.id}`);
    const note = decision.getByLabel(/결정 사유/);
    await expect(note).toHaveValue("");
    await note.fill("다음 요청의 사유");
    await expect(note).toBeFocused();
    held.release();
    await held.delivered;
    await expect(note).toBeFocused();
    await expect(note).toHaveValue("다음 요청의 사유");
    await expect(decision.getByRole("button", { name: "반려" })).toBeEnabled();
  } finally {
    await held.dispose();
  }
  // 일시정지 중의 작업자 추가 승인은 작업자를 더하지만 조직은 일시정지 그대로다.
  expect(
    (await get<{ status: string }>(page, org.api(`/approvals/${first!.id}`)))
      .status
  ).toBe("approved");
  expect(await stage(page, org)).toBe("paused");

  // 중단된 뒤에도 작업자 추가 요청은 결정할 수 있다.
  await post(page, org.api("/stop"));
  await page.goto(`/orgs/${org.id}/approvals/${second!.id}`);
  const reject = decision.getByRole("button", { name: "반려" });
  await expect(reject).toBeVisible();
  await expect(decision).not.toContainText(closedNotice);
  await decision.getByLabel(/결정 사유/).fill("중단해서 필요 없습니다");
  await reject.click();
  await expect(decision).toContainText("반려됨");
  await expect(decision).toBeFocused();
});

test("result decisions say what they do to a paused organization, focus the record only for this screen's success, and leave focus alone after another screen or a 409", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const org = await newOrganization(page, "결정 표시 결과 E2E 조직");
  await approveInitial(page, org);
  const first = await requestResult(page, org);
  await post(page, org.api("/pause"));
  const pausedNotice =
    "조직이 일시정지 중입니다 · 수정 요청하면 재개 · 최종 완료하면 연구 종료";

  // 다른 화면: Inbox 상세. 이 화면: 결과 제출 상세에서 수정 요청한다. 응답보다 Event가 먼저 닿는다.
  const other = await context.newPage();
  await openWithLiveEvents(
    other,
    `/inbox/${org.id}/result_submission/${first}`
  );
  const otherDecision = other.getByRole("region", { name: "결정" });
  await expect(otherDecision).toContainText(pausedNotice);
  const kept = other.getByRole("link", { name: /원래 화면에서 자세히 보기/ });
  await kept.focus();

  const path = `/orgs/${org.id}/results/${first}`;
  await openWithLiveEvents(page, path);
  const decision = page.getByRole("region", { name: "결정" });
  await expect(decision).toContainText(pausedNotice);
  await decision.getByLabel(/의견/).fill("한계도 적어 주세요");
  const held = await holdDecisionReply(page);
  try {
    await decision.getByRole("button", { name: "수정 요청" }).click();
    await held.sent;
    await expect(decision).toContainText("수정 요청됨");
    await expect(decision).not.toBeFocused();
    await expect(otherDecision).toContainText("수정 요청됨");
    await expect(kept).toBeFocused();
    held.release();
    await expect(decision).toBeFocused();
    await expect(page).toHaveURL(path);
    await expect(kept).toBeFocused();
  } finally {
    await held.dispose();
  }
  // 일시정지 중의 수정 요청은 조직을 재개한다(Lead가 다시 제출하면 결과 검토로 넘어간다).
  await expect.poll(() => stage(page, org)).not.toBe("paused");

  // Lead가 다시 제출한 결과를 일시정지 중에 다른 곳에서 최종 완료한다.
  const pendingSecond = async () =>
    (
      await get<{ id: string; status: string }[]>(page, org.api("/results"))
    ).find((s) => s.status === "pending")?.id;
  await expect.poll(pendingSecond, leadWork).toBeTruthy();
  const second = (await pendingSecond())!;
  await runsSettled(page, org);
  await post(page, org.api("/pause"));

  // 다른 화면(실시간): 결과 제출 상세의 근거 산출물 링크에 포커스가 있다.
  await openWithLiveEvents(other, `/orgs/${org.id}/results/${second}`);
  const evidence = other
    .getByRole("region", { name: /근거 산출물/ })
    .getByRole("link")
    .first();
  await evidence.focus();
  await expect(evidence).toBeFocused();

  // 오래된 화면: Event를 받지 않는 Inbox 상세가 결정 폼을 보고 있다.
  const stale = await context.newPage();
  await stale.routeWebSocket(/\/api\/events/, () => {});
  await stale.goto(`/inbox/${org.id}/result_submission/${second}`);
  const staleDecision = stale.getByRole("region", { name: "결정" });
  await expect(staleDecision).toContainText(pausedNotice);

  await post(page, org.api(`/results/${second}/decision`), {
    decision: "complete",
  });
  await expect(otherDecision).toContainText("연구를 최종 완료했습니다");
  await expect(evidence).toBeFocused();

  // 오래된 화면의 수정 요청은 409로 거절되고, 먼저 온 최종 완료를 결정 기록으로 보이되 포커스를 옮기지 않는다.
  await staleDecision.getByLabel(/의견/).fill("늦게 보낸 수정 요청");
  await staleDecision.getByRole("button", { name: "수정 요청" }).click();
  await expect(staleDecision).toContainText("연구를 최종 완료했습니다");
  await expect(staleDecision.getByRole("button")).toHaveCount(0);
  await expect(staleDecision).not.toContainText("늦게 보낸 수정 요청");
  await expect(staleDecision).not.toBeFocused();
  expect(await stage(page, org)).toBe("completed");
});

test("a result submitted to an organization that is then stopped cannot be decided on the detail or Inbox screens", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const org = await newOrganization(page, "결정 표시 결과 중단 E2E 조직");
  await approveInitial(page, org);
  const submission = await requestResult(page, org);
  await post(page, org.api("/stop"));
  for (const path of [
    `/orgs/${org.id}/results/${submission}`,
    `/inbox/${org.id}/result_submission/${submission}`,
  ]) {
    await page.goto(path);
    const decision = page.getByRole("region", { name: "결정" });
    await expect(decision).toContainText("중단된 조직이라 결정할 수 없습니다.");
    await decision.getByLabel(/의견/).fill("의견이 있어도 막힌다");
    for (const name of ["수정 요청", "최종 완료"])
      await expect(decision.getByRole("button", { name })).toBeDisabled();
  }
});
