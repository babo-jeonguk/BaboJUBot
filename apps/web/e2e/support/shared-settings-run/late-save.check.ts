import type { ProviderSettings } from "@babojubot/contracts";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { openWithLiveEvents } from "../live-events.ts";
import { record, test } from "./fixture.ts";

// 서버로 보낸 저장의 응답을 기다리지 않고 끝난 테스트(응답 대기 시한을 넘긴 경우와 같다). 정리는 그 저장이 끝난 뒤에 되돌려야
// 늦게 끝난 저장이 되돌린 값을 덮지 않는다. 느린 서버는 route가 page와 상관없는 연결로 같은 PUT을 보내 흉내 낸다. 그 PUT은
// 테스트 본문이 끝난 뒤(afterEach) 보낸다. Playwright는 afterEach 뒤에 fixture를 정리하므로, 정리가 시작될 때 저장은 늘 오는 중이다.
// 늦은 저장의 응답과 fixture의 되돌리기 PUT은 기록 파일에 차례대로 남아, 바깥 시험이 저장 성공과 그 뒤의 되돌리기를 확인한다.
let sendLateWrite: (() => void) | undefined;
test.afterEach(() => {
  sendLateWrite?.();
  sendLateWrite = undefined;
});

test("ends while a released settings save is still on its way", async ({
  page,
  playwright,
  baseURL,
  sharedSettings,
}) => {
  const slowServer = await playwright.request.newContext({ baseURL });
  let lateWrite: Promise<unknown> | undefined;
  // 준비 중 실패해도 연결을 닫는다. 늦은 저장을 보냈으면 그 저장이 끝난 뒤 lateWrite가 닫는다.
  await withCleanup(async (defer) => {
    defer(async () => {
      if (!lateWrite) await slowServer.dispose();
    });

    await openWithLiveEvents(page, "/settings");
    const form = page.getByRole("form", { name: "기본 프로바이더" });
    const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
    await threshold.fill("600000");
    await threshold.blur();
    // 나중에 등록한 route가 먼저 돈다. 붙잡은 요청을 보내면 아래 느린 서버로 넘어간다. 이 route를 테스트 내내 두는 것은
    // page의 route가 모두 없어지면 붙잡혀 있던 요청이 곧바로 서버로 가기 때문이다(정리가 문 route를 떼어도 느린 서버는 남는다).
    let slowed = false;
    let takeOver!: () => void;
    const tookOver = new Promise<void>((resolve) => (takeOver = resolve));
    await page.route("**/api/providers/defaults", async (route) => {
      if (slowed || route.request().method() !== "PUT") return route.fallback();
      slowed = true;
      const bodyEnded = new Promise<void>(
        (resolve) => (sendLateWrite = resolve)
      );
      const sent = bodyEnded.then(async () => {
        const response = await slowServer.put(route.request().url(), {
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
        return response;
      });
      lateWrite = sent.finally(() => slowServer.dispose());
      takeOver();
      // 정리가 이 저장을 기다리지 않으면 page가 먼저 닫혀 응답을 넘길 곳이 없다.
      await route.fulfill({ response: await sent }).catch(() => {});
    });
    const held = await sharedSettings.holdWrite(
      page,
      "**/api/providers/defaults"
    );
    await form.getByRole("button", { name: /^저장/ }).click();
    await held.arrived();
    held.send();
    // 느린 서버가 저장을 넘겨받은 뒤에 끝낸다. 그 전에 끝나면 위 정리가 연결을 닫아 버린다.
    await tookOver;
  });
});
