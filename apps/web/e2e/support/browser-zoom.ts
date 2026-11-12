import { chromium, type BrowserContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Chrome의 실제 페이지 확대를 켠 브라우저를 띄운다. 사용자가 Ctrl+로 바꾸는 것과 같은 기본 확대 수준(`default_zoom_level`)을
 * 프로필 설정에 적어 둔다. 확대 수준 n의 배율은 1.2^n이다. 가벼운 headless shell은 이 설정을 읽지 않아 전체 Chromium으로 띄운다.
 * 창 크기는 확대 전 크기이고, 화면의 CSS 폭은 창 폭 ÷ 배율이 된다.
 */
export async function launchZoomed({
  baseURL,
  profileDir,
  zoom,
  window,
}: {
  baseURL: string;
  profileDir: string;
  zoom: number;
  window: { width: number; height: number };
}): Promise<BrowserContext> {
  mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  writeFileSync(
    path.join(profileDir, "Default", "Preferences"),
    JSON.stringify({
      partition: {
        default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) },
      },
    })
  );
  return chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    baseURL,
    // 화면 크기 흉내를 끄고 실제 창으로 띄운다. 흉내를 켜면 확대 대신 그 크기가 쓰인다. 시험 설정(Desktop Chrome)의 화소 비율도 지운다.
    viewport: null,
    deviceScaleFactor: undefined,
    args: [`--window-size=${window.width},${window.height}`],
  });
}
