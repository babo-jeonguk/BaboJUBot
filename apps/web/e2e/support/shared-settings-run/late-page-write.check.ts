import type { APIRequestContext, Page } from "@playwright/test";
import { openWithLiveEvents } from "../live-events.ts";
import { record, test as base } from "./fixture.ts";

// 테스트 본문이 끝난 뒤 화면이 전역 설정 변경을 새로 보낸다. 정리가 기다리는 요청은 본문이 보낸 것뿐이라, 끊지 않으면 그 변경이
// 되돌린 값을 덮는다. 화면의 변경은 정리가 되돌리기 PUT을 보낸 뒤 처음 하는 조회(되돌린 값의 확인) 때 보낸다. 본문은 PUT을 보내지
// 않으므로 그 조회는 늘 되돌리기 뒤다. 바깥 시험이 그 변경이 서버에 닿지 않았는지와 정리 뒤 설정을 본다.
async function sendFromPage(page: Page) {
  const path = "/api/providers/isolation";
  const sent = page.waitForRequest(
    (r) => r.method() === "PUT" && new URL(r.url()).pathname === path
  );
  // 브라우저의 fetch 결과는 쓰지 않는다. 서버에 닿았는지는 아래에서 Playwright가 본 요청의 응답·실패로 판정한다.
  const fetched = page.evaluate(async (target) => {
    const settings = (await (await fetch("/api/providers")).json()) as {
      isolated: boolean;
    };
    return fetch(target, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isolated: !settings.isolated }),
    }).then(
      (response) => response.status,
      (error: unknown) => String(error)
    );
  }, path);
  const request = await sent;
  await fetched;
  const response = await request.response();
  record({
    step: "late page write",
    outcome: response
      ? response.status()
      : (request.failure()?.errorText ?? "no response"),
  });
}

const test = base.extend({
  request: async ({ request, page }, use) => {
    let restoring = false;
    let sentFromPage = false;
    await use(
      new Proxy(request, {
        get(target, key) {
          if (key === "put")
            return (...args: Parameters<APIRequestContext["put"]>) => {
              restoring = true;
              return target.put(...args);
            };
          if (key === "get")
            return async (...args: Parameters<APIRequestContext["get"]>) => {
              const response = await target.get(...args);
              if (restoring && !sentFromPage) {
                sentFromPage = true;
                await sendFromPage(page);
              }
              return response;
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    );
  },
});

test("ends while the page still sends a settings change", async ({ page }) => {
  // 본문은 설정을 바꾸지 않는다. 시작 전 값은 fixture가 읽어 두었다.
  await openWithLiveEvents(page, "/settings");
});
