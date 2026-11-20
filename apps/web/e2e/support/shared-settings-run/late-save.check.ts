import { settled, type ProviderSettings } from "@babojubot/contracts";
import type { APIRequestContext } from "@playwright/test";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { openWithLiveEvents } from "../live-events.ts";
import { record, test as base } from "./fixture.ts";

// 서버로 보낸 저장의 응답을 기다리지 않고 끝난 테스트(응답 대기 시한을 넘긴 경우와 같다). 정리는 그 저장이 끝난 뒤에 되돌려야
// 늦게 끝난 저장이 되돌린 값을 덮지 않는다. 느린 서버는 route가 page와 상관없는 연결로 같은 PUT을 보내 흉내 낸다. 그 PUT은
// 테스트 본문이 끝난 뒤(afterEach) 보낸다. Playwright는 afterEach 뒤에 fixture를 정리하므로, 정리가 시작될 때 저장은 늘 오는 중이다.
// 늦은 저장의 응답과 fixture의 되돌리기 PUT은 기록 파일에 차례대로 남아, 바깥 시험이 저장 성공과 그 뒤의 되돌리기를 확인한다.
let sendLateWrite: (() => void) | undefined;

/** 늦은 저장을 보내는 연결과, 그 저장의 끝(저장·응답 넘기기)을 넘겨받아 기다리는 곳. */
type LateSave = {
  slowServer: APIRequestContext;
  hand: (work: Promise<unknown>) => void;
};

// Playwright는 route 처리기가 던진 오류를 처리되지 않은 오류로 다시 던져 테스트를 곧바로 끝낸다. 그러면 공용 설정 정리의
// 되돌리기도 닫힌 연결로 실패한다. 그래서 처리기는 늦은 저장의 끝을 이 fixture에 넘기고, 이 fixture가 공용 설정 정리 뒤에 그 끝을
// 기다려 실패를 이 테스트의 실패로 남긴 다음 연결을 닫는다. 공용 설정 정리(sharedSettings)가 기대는 `request`를 이 fixture에
// 기대게 해 정리 순서를 정한다(기대는 쪽이 먼저 정리된다).
const test = base.extend<{ lateSave: LateSave }>({
  lateSave: async ({ playwright, baseURL }, use) => {
    const slowServer = await playwright.request.newContext({ baseURL });
    await withCleanup(async (defer) => {
      defer(() => slowServer.dispose());
      let work: Promise<unknown> = Promise.resolve();
      await use({
        slowServer,
        hand: (handed) => {
          work = handed;
        },
      });
      await work;
    });
  },
  request: async ({ request, lateSave: _ }, use) => {
    await use(request);
  },
});

test.afterEach(() => {
  sendLateWrite?.();
  sendLateWrite = undefined;
});

test("ends while a released settings save is still on its way", async ({
  page,
  lateSave,
  sharedSettings,
}) => {
  await openWithLiveEvents(page, "/settings");
  const form = page.getByRole("form", { name: "기본 프로바이더" });
  const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
  await threshold.fill("600000");
  await threshold.blur();
  // 나중에 등록한 route가 먼저 돈다. 붙잡은 요청을 보내면 아래 느린 서버로 넘어간다. 이 route를 테스트 내내 두는 것은
  // page의 route가 모두 없어지면 붙잡혀 있던 요청이 곧바로 서버로 가기 때문이다(정리가 문 route를 떼어도 느린 서버는 남는다).
  let tookOver = false;
  let takeOver!: () => void;
  const tookOverWrite = new Promise<void>((resolve) => (takeOver = resolve));
  await page.route("**/api/providers/defaults", async (route) => {
    if (tookOver || route.request().method() !== "PUT") return route.fallback();
    tookOver = true;
    const bodyEnded = new Promise<void>((resolve) => (sendLateWrite = resolve));
    const work = bodyEnded.then(async () => {
      const response = await lateSave.slowServer.put(route.request().url(), {
        data: route.request().postDataJSON(),
      });
      const saved = response.ok()
        ? ((await response.json()) as ProviderSettings)
        : undefined;
      record({
        step: "late write answered",
        status: response.status(),
        thresholdTokens: saved?.compaction?.thresholdTokens,
      });
      // 정리가 이 저장을 기다리지 않으면 page가 먼저 닫혀 응답을 넘길 곳이 없다. page가 닫혀 난 그 오류(Playwright의 닫힘 문구)만
      // 넘기고, 그 밖의 오류는 늦은 저장의 실패로 남긴다.
      await route.fulfill({ response }).catch((error: unknown) => {
        const closed =
          page.isClosed() &&
          error instanceof Error &&
          /Target page, context or browser has been closed/.test(error.message);
        if (!closed) throw error;
      });
    });
    lateSave.hand(work);
    takeOver();
    // 처리기는 늦은 저장이 끝날 때까지 머물되 그 실패는 lateSave가 받는다.
    await settled(work);
  });
  const held = await sharedSettings.holdWrite(
    page,
    "**/api/providers/defaults"
  );
  await form.getByRole("button", { name: /^저장/ }).click();
  await held.arrived();
  held.send();
  // 느린 서버가 저장을 넘겨받은 뒤에 끝낸다.
  await tookOverWrite;
});
