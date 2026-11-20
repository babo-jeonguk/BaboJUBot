import { appendFileSync } from "node:fs";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { openWithLiveEvents } from "../live-events.ts";
import {
  readSettings,
  test as base,
  type SharedSettings,
} from "../shared-settings.ts";

/** 안쪽 실행이 바깥 시험(../shared-settings.spec.ts)에 남기는 기록 한 줄. 일어난 차례대로 적는다. */
export type Entry =
  | { step: "api put"; path: string }
  /** 서버에 닿았으면 응답 상태, 끊겼으면 브라우저의 실패 문구. */
  | { step: "late page write"; outcome: number | string }
  | {
      step: "late write answered";
      status: number;
      thresholdTokens: number | undefined;
    };

/** 바깥 시험이 읽을 기록 파일(SHARED_SETTINGS_RUN_LOG)에 한 줄을 더한다. 안쪽 실행이 끝난 뒤에 읽으므로 바로 적는다. */
export function record(entry: Entry) {
  appendFileSync(
    process.env.SHARED_SETTINGS_RUN_LOG!,
    `${JSON.stringify(entry)}\n`
  );
}

// `sharedSettings` fixture는 `request`로 되돌린다. API로 보낸 PUT을 차례대로 적어, 되돌리기가 화면의 늦은 저장보다 뒤였는지
// 바깥 시험이 확인한다. `failingPut`을 주면 그 경로의 PUT을 서버에 보내지 않고 실패시킨다(되돌리기 하나가 실패하는 정리).
export const test = base.extend<{ failingPut: string | undefined }>({
  failingPut: [undefined, { option: true }],
  request: async ({ request, failingPut }, use) => {
    await use(
      new Proxy(request, {
        get(target, key) {
          if (key === "put")
            return (...args: Parameters<APIRequestContext["put"]>) => {
              record({ step: "api put", path: String(args[0]) });
              if (String(args[0]) === failingPut)
                return Promise.reject(
                  new Error(`${failingPut} PUT을 일부러 실패시켰다`)
                );
              return target.put(...args);
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    );
  },
});

/** API로 전역 설정을 바꾸고, 화면에서 압축 기준 저장을 붙잡은 채 화면을 다시 연다. 붙잡은 저장은 서버에 가지 않았다. */
export async function leaveSettingsMidSave(
  page: Page,
  request: APIRequestContext,
  sharedSettings: SharedSettings
) {
  const changes: [string, unknown][] = [
    [
      "/api/providers/defaults",
      {
        leadDefault: { provider: "fake-2", model: "fake-2-max" },
        workerDefault: { provider: "fake-2", model: null },
        compaction: { thresholdTokens: 300000, ratio: 0.8 },
      },
    ],
    [
      "/api/providers/isolation",
      { isolated: !sharedSettings.initial.isolated },
    ],
    ["/api/providers/fake/limit", { maxConcurrentRuns: 7 }],
  ];
  for (const [path, data] of changes)
    expect((await request.put(path, { data })).status()).toBe(200);
  // 성공 응답만으로는 저장됐는지 모른다. 서버에 저장된 값으로 확인한다. 저장되지 않았으면 되돌리기를 시험하지 못한다.
  expect(await readSettings(request), "바꾼 전역 설정").toMatchObject({
    leadDefault: { provider: "fake-2", model: "fake-2-max" },
    workerDefault: { provider: "fake-2", model: null },
    compaction: { thresholdTokens: 300000, ratio: 0.8 },
    isolated: !sharedSettings.initial.isolated,
    limits: { fake: 7 },
  });

  await openWithLiveEvents(page, "/settings");
  const form = page.getByRole("form", { name: "기본 프로바이더" });
  const threshold = form.getByRole("spinbutton", { name: "압축 기준" });
  await expect(threshold).toHaveValue("300000");
  await threshold.fill("600000");
  await threshold.blur();
  const held = await sharedSettings.holdWrite(
    page,
    "**/api/providers/defaults"
  );
  await form.getByRole("button", { name: /^저장/ }).click();
  await held.arrived();
  // 붙잡힌 저장이 있는 채로 화면을 다시 열어도 정리는 멈추지 않는다.
  await page.reload();
  await expect(threshold).toHaveValue("300000");
}
