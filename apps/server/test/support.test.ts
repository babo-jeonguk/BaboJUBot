import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeFolder } from "@babojubot/process/remove-folder";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderConnection } from "@babojubot/contracts";
import { createFakeProviders } from "@babojubot/runtime";
import { startTestServer } from "./support.ts";

// 시험 서버 helper가 서버를 넘기기 전에 실패하면, 자기가 만든 것(서버·DB·작업 폴더)을 치우고 원래 오류로 실패한다.
// 작업 폴더는 운영체제 임시 폴더에 만들므로, 이 시험만의 임시 폴더를 운영체제 임시 폴더로 정해 남은 것을 본다.

let base: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (base) await removeFolder(base);
  base = undefined;
});

/** helper가 만드는 임시 폴더가 이 시험의 폴더 안에 생기게 한다. Node는 POSIX에서 TMPDIR, Windows에서 TEMP·TMP를 읽는다. */
async function ownTemporaryFolder() {
  base = await mkdtemp(path.join(tmpdir(), "babojubot-support-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, base);
  return base;
}

it("removes the workspace folder it made and keeps the start error when the server cannot start", async () => {
  const temp = await ownTemporaryFolder();
  // 알림 채널이 하나가 아니면 서버는 아무것도 띄우기 전에 거절한다.
  await expect(startTestServer({ notificationChannels: [] })).rejects.toThrow(
    "exactly one notification channel is supported, got 0"
  );
  expect(await readdir(temp)).toEqual([]);
});

it("closes the started server and removes its folder when the readiness check before handing it over fails", async () => {
  const temp = await ownTemporaryFolder();
  // 서버는 떴지만 준비 확인의 응답이 깨졌다.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("not json")
  );
  await expect(startTestServer()).rejects.toThrow(SyntaxError);
  expect(await readdir(temp)).toEqual([]);
});

it("leaves a workspace folder it was given when the server cannot start", async () => {
  const temp = await ownTemporaryFolder();
  const given = await mkdtemp(path.join(temp, "given-"));
  await expect(
    startTestServer({ notificationChannels: [], dataDir: given })
  ).rejects.toThrow("exactly one notification channel is supported, got 0");
  expect(await readdir(temp)).toEqual([path.basename(given)]);
});

it("fails naming what it waited for and cleans up when the startup readiness check does not finish within its limit", async () => {
  const temp = await ownTemporaryFolder();
  // 준비 확인을 시험이 붙잡아 끝나지 않게 한다. 상한 0이면 첫 확인에서 상한이 지나므로 실행기 속도와 상관없이 상한에 걸린다.
  const [fake] = createFakeProviders(1);
  const held: ProviderConnection = {
    ...fake!,
    id: "held",
    adapter: {
      ...fake!.adapter,
      // 서버를 닫으면 멈춤 신호로 끝난다.
      checkReadiness: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        ),
    },
  };
  const failure = await startTestServer({
    providers: [held],
    readinessSettleMs: 0,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect((failure as Error).message).toMatch(
    /^the test server's providers did not finish their startup readiness check in 0ms: (held \((checking|not_checked)\)|no answer from GET \/api\/providers yet)$/
  );
  // 넘기기 전 실패의 정리를 모두 마쳤다(정리 실패가 없어 원래 오류 그대로다). 작업 폴더는 서버가 닫힌 것을 확인한 뒤에만 지운다.
  expect(await readdir(temp)).toEqual([]);
});

// 서버의 끝을 확인하지 못하면 그 서버가 쓰는 DB와 작업 폴더를 닫거나 지우지 않는다(#294 외부 리뷰 5회차 STD-4-R1). 서버 닫기의 한 단계(알림
// 채널 닫기)를 실패시킨다. 서버의 닫기는 다시 부를 수 없으므로(이미 닫은 부분에서 실패한다), 끄기가 실패한 서버는 그 뒤에도 닫힌 것이
// 확인되지 않는다.
it("keeps the database and the workspace folder when stopping the server failed, and reports that failure on close", async () => {
  const temp = await ownTemporaryFolder();
  const refused = new Error("the notification channel did not close");
  const t = await startTestServer({
    notificationChannels: [
      {
        name: "refusing-close",
        deliver: () => Promise.resolve(),
        listen: () => {},
        close: () => Promise.reject(refused),
      },
    ],
  });
  await expect(t.stopServer()).rejects.toBe(refused);
  await expect(t.close()).rejects.toBe(refused);
  expect(await readdir(temp)).toHaveLength(1);
  // DB는 닫히지 않았다. 일부러 남긴 것: 그 DB(시험 실행의 cluster와 함께 지워짐)와 연결(pg pool이 유휴 10초 뒤 닫음). 작업 폴더는
  // afterEach가 이 시험의 임시 폴더와 함께 지운다.
  expect((await t.db.execute("select 1 as one")).rows).toEqual([{ one: 1 }]);
});
