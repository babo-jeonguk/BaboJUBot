import { expect, test, type Page } from "@playwright/test";
import { isReadyFrame, openWithLiveEvents } from "./live-events.ts";

/** helper가 page에 남긴 listener 수. Playwright `Page`는 EventEmitter지만 타입에 `listenerCount`를 드러내지 않는다. */
const listeners = (page: Page) => {
  const emitter = page as unknown as { listenerCount(event: string): number };
  return emitter.listenerCount("websocket") + emitter.listenerCount("close");
};

test("ready is the frame's type, not a substring of its payload", () => {
  expect(isReadyFrame(JSON.stringify({ type: "ready" }))).toBe(true);
  expect(isReadyFrame('{"type":"event","event":{"note":"\\"ready\\""}}')).toBe(
    false
  );
  expect(isReadyFrame('"ready"')).toBe(false);
  expect(isReadyFrame("not json")).toBe(false);
});

test("opening the same page again and again leaves no listener behind", async ({
  page,
}) => {
  const before = listeners(page);
  for (const path of ["/", "/inbox", "/"]) await openWithLiveEvents(page, path);
  expect(listeners(page)).toBe(before);
});

test("a page whose stream never sends ready fails within the deadline, naming what it waited for", async ({
  page,
}) => {
  // 화면이 Event stream을 열지 못해 ready frame이 오지 않는다.
  await page.addInitScript(() => {
    window.WebSocket = class {
      close() {}
    } as unknown as typeof WebSocket;
  });
  const before = listeners(page);
  const started = Date.now();
  await expect(
    openWithLiveEvents(page, "/", { timeout: 2_000 })
  ).rejects.toThrow(
    "/ 화면의 Event stream(/api/events): 화면을 열기 시작한 뒤 2000ms 안에 ready frame을 받지 못했다"
  );
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(listeners(page)).toBe(before);
});

test("a stream the server refuses fails at once with the reason", async ({
  page,
}) => {
  // 없는 조직의 구독을 요청하게 해 실제 서버가 연결을 거부(404)한다.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const refused = new URL(url);
        refused.searchParams.set(
          "organizationId",
          "00000000-0000-0000-0000-000000000000"
        );
        super(refused, protocols);
      }
    };
  });
  const before = listeners(page);
  const started = Date.now();
  await expect(openWithLiveEvents(page, "/")).rejects.toThrow(
    /^\/ 화면의 Event stream\(\/api\/events\): ready frame을 받기 전에 오류가 났다\(.*404/
  );
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(listeners(page)).toBe(before);
});
