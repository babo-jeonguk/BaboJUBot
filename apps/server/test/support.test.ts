import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { afterEach, expect, it, vi } from "vitest";
import { startTestServer } from "./support.ts";

// 시험 서버 helper가 띄우다 실패하면, 자기가 만든 것(DB·작업 폴더)을 치우고 원래 시작 오류로 실패한다.
// 작업 폴더는 운영체제 임시 폴더에 만들므로, 이 시험만의 임시 폴더를 운영체제 임시 폴더로 정해 남은 것을 본다.

let base: string | undefined;
afterEach(async () => {
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

it("leaves a workspace folder it was given when the server cannot start", async () => {
  const temp = await ownTemporaryFolder();
  const given = await mkdtemp(path.join(temp, "given-"));
  await expect(
    startTestServer({ notificationChannels: [], dataDir: given })
  ).rejects.toThrow("exactly one notification channel is supported, got 0");
  expect(await readdir(temp)).toEqual([path.basename(given)]);
});
