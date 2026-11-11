import { expect, test, type Page } from "@playwright/test";
import { goalInput } from "./support/organization.ts";
import { openWithLiveEvents } from "./support/live-events.ts";

// #150 복구 멈춤 화면. 서버 재시작 뒤 실행 의도 정산이 막힌 상태는 서버를 멈춰야만 생기므로(서버 회귀 시험
// apps/server/test/intent-recovery.test.ts가 실제 상태 전이를 검사한다), 이 시험은 에이전트 상세 응답의 복구 상태만
// 바꿔 화면의 안내·버튼·요청·갱신을 확인한다. 나머지 응답과 실시간 Event는 실제 E2E 서버의 것이다.

type Recovery = {
  state: "blocked" | "retrying";
  reason: "missing_source" | "inconsistent_record" | "retry_exhausted";
  since: string;
} | null;

async function createOrganization(page: Page, name: string) {
  const created = await page.request.post("/api/organizations", {
    data: { name, ...goalInput },
  });
  expect(created.status()).toBe(201);
  const org = (await created.json()) as {
    id: string;
    agents: { id: string; role: string }[];
  };
  return { id: org.id, leadId: org.agents.find((a) => a.role === "lead")!.id };
}

test("a blocked recovery shows its reason, the owner retries it, and the notice follows the server state until it clears", async ({
  page,
}) => {
  const org = await createOrganization(page, "복구 멈춤 E2E 조직");
  const agentPath = `/api/organizations/${org.id}/agents/${org.leadId}`;
  let recovery: Recovery = {
    state: "blocked",
    reason: "missing_source",
    since: new Date().toISOString(),
  };
  const withRecovery = async (
    res: Awaited<ReturnType<Page["request"]["get"]>>
  ) => ({
    ...((await res.json()) as object),
    recovery,
  });
  await page.route(
    (url) => url.pathname === agentPath,
    async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: await withRecovery(res) });
    }
  );
  let recoverRequests = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(
    (url) => url.pathname === `${agentPath}/recover`,
    async (route) => {
      recoverRequests++;
      await held;
      recovery = { ...recovery!, state: "retrying" };
      const res = await page.request.get(agentPath);
      await route.fulfill({
        status: 200,
        json: { ...((await res.json()) as object), recovery },
      });
    }
  );

  await openWithLiveEvents(page, `/orgs/${org.id}/agents/${org.leadId}`);
  const control = page.getByRole("region", { name: "에이전트 제어" });
  const notice = control.getByRole("status", { name: "실행 복구" });
  await expect(notice).toContainText("실행 복구가 멈췄습니다");
  await expect(notice).toContainText(
    "서버가 멈추기 전에 받은 쓰기의 원본 자료를 찾을 수 없습니다."
  );
  const retry = notice.getByRole("button", { name: "↻ 복구 다시 시도" });
  await expect(retry).toBeEnabled();

  // 요청하는 동안 버튼을 잠그고, 서버가 확정한 상태(다시 시도하는 중)로만 안내를 바꾼다.
  await retry.click();
  await expect(control.getByText("요청하는 중…")).toBeVisible();
  await expect(retry).toBeDisabled();
  release();
  await expect(notice).toContainText("실행 복구를 다시 시도하는 중입니다");
  await expect(notice.getByRole("button")).toHaveCount(0);
  expect(recoverRequests).toBe(1);

  // 정산이 끝나 막힘이 풀리면 다음 Event로 상세를 다시 불러와 안내가 사라진다.
  recovery = null;
  expect(
    (
      await page.request.post(`/api/organizations/${org.id}/messages`, {
        data: { body: "복구 뒤 메시지" },
      })
    ).status()
  ).toBe(201);
  await expect(notice).toHaveCount(0);
  await expect(
    control.getByRole("button", { name: /에이전트 일시정지/ })
  ).toBeEnabled();
});
