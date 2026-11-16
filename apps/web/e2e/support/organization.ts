import { expect, type Locator, type Page } from "@playwright/test";

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
  await expect
    .poll(
      async () => {
        const list = (await (
          await page.request.get(`/api/organizations/${org.id}/runs`)
        ).json()) as { status: string }[];
        return list.length > 0 && list.every((r) => r.status === "completed");
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return org;
}
