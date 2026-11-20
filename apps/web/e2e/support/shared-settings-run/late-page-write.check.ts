import type { APIRequestContext, Page } from "@playwright/test";
import { openWithLiveEvents } from "../live-events.ts";
import { record, test as base } from "./fixture.ts";

// 테스트 본문이 끝난 뒤 화면이 전역 설정 변경을 새로 보낸다. 정리가 기다리는 요청은 본문이 보낸 것뿐이라, 끊지 않으면 그 변경이
// 되돌린 값을 덮는다. 화면의 변경은 정리가 되돌리기를 마치고 확인 조회를 할 때 보낸다(시작 조회 다음의 두 번째 조회). 바깥 시험이
// 그 변경이 거절됐는지와 정리 뒤 설정을 본다.
async function sendFromPage(page: Page) {
  const outcome = await page.evaluate(async () => {
    try {
      const settings = (await (await fetch("/api/providers")).json()) as {
        isolated: boolean;
      };
      const response = await fetch("/api/providers/isolation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isolated: !settings.isolated }),
      });
      return response.status;
    } catch {
      return "refused" as const;
    }
  });
  record({ step: "late page write", outcome });
}

const test = base.extend({
  request: async ({ request, page }, use) => {
    let reads = 0;
    await use(
      new Proxy(request, {
        get(target, key) {
          if (key === "get")
            return async (...args: Parameters<APIRequestContext["get"]>) => {
              const response = await target.get(...args);
              reads += 1;
              if (reads === 2) await sendFromPage(page);
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
