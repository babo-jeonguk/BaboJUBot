import { openWithLiveEvents } from "../live-events.ts";
import { test } from "./fixture.ts";

// `send`로 보낸 저장의 응답이 끝내 오지 않은 채 끝나는 테스트. 정리는 그 응답을 시한(10초) 안에서만 기다리고, 기다리지 못한
// 사실을 실패로 남긴 뒤에도 되돌리기를 한다. 응답은 page가 닫힐 때까지 붙잡아 두므로 정리가 끝날 때까지 오지 않는다.
test("ends while a sent settings save never gets its reply", async ({
  page,
  sharedSettings,
}) => {
  await openWithLiveEvents(page, "/settings");
  const form = page.getByRole("form", { name: "기본 프로바이더" });
  const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
  await threshold.fill("600000");
  await threshold.blur();
  // 나중에 등록한 route가 먼저 돈다. 붙잡은 요청을 보내면 이 route로 넘어와 page가 닫힐 때까지 머문다.
  await page.route("**/api/providers/defaults", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await new Promise<void>((resolve) => page.once("close", () => resolve()));
  });
  const held = await sharedSettings.holdWrite(
    page,
    "**/api/providers/defaults"
  );
  await form.getByRole("button", { name: /^저장/ }).click();
  await held.arrived();
  held.send();
});
