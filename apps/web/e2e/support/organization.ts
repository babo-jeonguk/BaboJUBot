import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * API로 조직을 만들 때 쓰는 기본 연구 목표와 완료 기준. 조직을 만들면 가짜 Lead가 이 목표로 곧바로 초기 연구 승인을 요청한다.
 */
export const goalInput = {
  goal: "오류 유형을 정리한다",
  completionCriteria: "유형 목록",
};

// E2E 서버와 DB는 여러 spec과 반복 실행이 같이 쓰므로 같은 표시 이름의 조직이 여럿 있을 수 있다(제품도 이름 중복을 막지 않는다).
// 아래 locator는 어느 조직인지를 링크가 가리키는 조직 ID로 가리고, 표시 이름은 화면이 보이는 내용으로만 확인한다.

/** 레일(`연구 조직` navigation)에서 이 조직으로 가는 링크. 접근 이름(`이름 · 단계 · …`)이 `name`과 맞아야 한다. */
export function railOrganizationLink(
  rail: Locator,
  organizationId: string,
  name: string | RegExp
) {
  return rail
    .getByRole("link", { name })
    .and(rail.locator(`a[href="/orgs/${organizationId}"]`));
}

/** Inbox 목록에서 이 조직의 항목 링크(`/inbox/<조직 ID>/…`). 접근 이름으로 더 좁히려면 `name`을 준다. */
export function inboxOrganizationLinks(
  list: Locator,
  organizationId: string,
  name?: string | RegExp
) {
  const links = list.locator(`a[href^="/inbox/${organizationId}/"]`);
  return name === undefined
    ? links
    : links.and(list.getByRole("link", { name }));
}

/** Inbox 목록에서 이 조직의 항목(`listitem`). 항목 안의 정리 버튼까지 다룰 때 쓴다. */
export function inboxOrganizationItems(list: Locator, organizationId: string) {
  // `has`는 항목 안에서 찾으므로 목록에서 이어 만든 locator가 아니라 page 기준 locator를 넘긴다.
  return list.getByRole("listitem").filter({
    has: list.page().locator(`a[href^="/inbox/${organizationId}/"]`),
  });
}

/**
 * API로 조직을 만들고, 생성으로 깨어난 가짜 Lead가 초기 연구 승인을 요청하고 첫 실행 시도를 끝낼 때까지 기다린다.
 * 실행 시도는 그때까지 쌓인 깨움을 모두 한꺼번에 받으므로, 바로 이어 보낸 메시지(`실패 연습` 등)가 생성의 깨움과
 * 한 실행 시도로 묶이면 초기 연구 승인 요청이 생기지 않는다. 이어서 메시지를 보낼 spec은 이 함수로 만든다.
 */
export async function createSettledOrganization(
  page: Page,
  name: string,
  input: { goal: string; completionCriteria: string } = goalInput
) {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...input },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  await runsSettled(page.request, org.id);
  return org;
}

/**
 * 가짜 Lead 실행 시도 하나를 기다리는 상한(#215). 깨우기 → 가짜 프로바이더 → DB → Event를 거치고, 가짜 프로바이더의
 * 동시 실행 칸(2)을 앞 spec의 조직이 쓰고 있으면 그 실행이 끝나기를 기다린다. 2 CPU에 부하를 건 기기에서 기본 5초를
 * 넘겼다. 이 대기는 실행 시도가 끝났는지만 보고, 화면 확인은 그 뒤에 기본 대기로 한다.
 */
export const leadRun = { timeout: 30_000 };

/** 이 조직에 실행 시도가 생기고 모두 끝날 때까지 기다린다. 조직을 만든 뒤 생성으로 깨어난 Lead의 실행 시도를 기다릴 때 쓴다. */
export async function runsSettled(
  request: APIRequestContext,
  organizationId: string
) {
  await expect
    .poll(async () => {
      const list = (await (
        await request.get(`/api/organizations/${organizationId}/runs`)
      ).json()) as { status: string }[];
      // 실패하면 기다리던 실행 시도들의 상태가 그대로 보이게 상태 목록을 비교한다.
      return list.map((r) => r.status).join(",");
    }, leadRun)
    .toMatch(/^completed(,completed)*$/);
}

/**
 * 이 조직의 첫 승인 요청 ID. 조직을 만들면 가짜 Lead가 초기 연구 승인을 요청하는데, 그 요청이 생길 때까지 기다린다.
 * 실행 시도가 끝났는지는 보지 않는다. 그것까지 필요하면 `runsSettled`를 함께 쓴다.
 */
export async function firstApprovalId(
  request: APIRequestContext,
  organizationId: string
) {
  let approvalId = "";
  await expect
    .poll(async () => {
      const res = await request.get(
        `/api/organizations/${organizationId}/approvals`
      );
      approvalId = ((await res.json()) as { id: string }[])[0]?.id ?? "";
      return approvalId;
    }, leadRun)
    .not.toBe("");
  return approvalId;
}

/** 서버가 저장한 사용자 메시지. 보내기 응답에서 받는다. */
export type SentMessage = { id: string; conversationId: string };

/** 보내기 응답(`/messages`는 메시지, 새 대화는 `{ conversation, message }`)에서 저장된 메시지를 꺼낸다. */
export async function sentMessage(
  response: Pick<APIResponse, "status" | "json">
): Promise<SentMessage> {
  expect(response.status()).toBe(201);
  const body = (await response.json()) as
    SentMessage | { message: SentMessage };
  return "message" in body ? body.message : body;
}

/**
 * 화면에서 메시지를 보내는 `send`를 하고, 서버가 저장한 그 메시지를 돌려준다. 보내기 요청은 `send` 전에 기다리기 시작한다.
 */
export async function sendingMessage(
  page: Page,
  send: () => Promise<unknown>
): Promise<SentMessage> {
  const posted = page.waitForResponse((res) => {
    const { pathname } = new URL(res.url());
    return (
      res.request().method() === "POST" &&
      /^\/api\/organizations\/[^/]+\/(messages|conversations|conversations\/[^/]+\/messages)$/.test(
        pathname
      )
    );
  }, leadRun);
  await send();
  return sentMessage(await posted);
}

/**
 * 보낸 메시지(`sent`, 보내기 응답의 메시지)를 받은 실행 시도가 끝날 때까지 기다린다. 메시지 ID로 그 메시지를 찾고, 그 메시지가
 * 전달된 실행 시도의 ID로 상태를 보므로 같은 글의 앞선 메시지나 앞서 끝난 실행 시도에 속지 않는다(#215).
 */
export async function messageAnswered(
  request: APIRequestContext,
  organizationId: string,
  sent: SentMessage
) {
  const api = `/api/organizations/${organizationId}`;
  await expect
    .poll(async () => {
      const { messages } = (await (
        await request.get(
          `${api}/conversations/${sent.conversationId}/messages`
        )
      ).json()) as {
        messages: { id: string; deliveredToRunId: string | null }[];
      };
      const runId = messages.find((m) => m.id === sent.id)?.deliveredToRunId;
      if (!runId) return "not delivered";
      const run = await request.get(`${api}/runs/${runId}`);
      return ((await run.json()) as { status: string }).status;
    }, leadRun)
    .toBe("completed");
}
