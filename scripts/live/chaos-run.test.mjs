// 장면 준비가 실패해도 그때까지 만든 폴더를 남기지 않고 원래 실패를 드러내는지 본다(#255 리뷰 권고). 실제 모델은 부르지 않는다.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  withCleanup,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
import { cleanupScene, prepareScene } from "./chaos-run.mjs";

test("a failing scene preparation removes the folders it made and keeps its error", async () => {
  await withCleanup(async (defer) => {
    const root = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-prepare-"));
    defer(() => removeFolderWithin(root));
    const failure = new Error("budget was not written");
    await assert.rejects(
      prepareScene(() => {
        // 두 폴더를 만든 뒤 실패한다.
        assert.equal(readdirSync(root).length, 2);
        throw failure;
      }, root),
      (error) => error === failure
    );
    assert.deepEqual(readdirSync(root), []);
  });
});

test("a prepared scene has its home and harness folders, private to the owner", async () => {
  await withCleanup(async (defer) => {
    const root = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-prepare-"));
    defer(() => removeFolderWithin(root));
    const { home, harnessDir } = await prepareScene(() => {}, root);
    assert.deepEqual(
      readdirSync(root).sort(),
      [path.basename(home), path.basename(harnessDir)].sort()
    );
    // Windows는 POSIX 권한 비트를 쓰지 않는다.
    if (process.platform !== "win32")
      for (const dir of [home, harnessDir])
        assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

// 장면 서버와 시험용 명령은 harness 폴더를 쓴다. 서버 정리가 실패하면 그 끝을 확인하지 못했으므로 폴더를 지우지 않고 남기고, 정리
// 실패로 센다(#298 자원 표에서 찾음: 그동안 dispose가 실패해도 지웠다).
test("a scene whose server cleanup failed keeps its harness folder and counts the failure", async (t) => {
  await withCleanup(async (defer) => {
    const root = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-cleanup-"));
    defer(() => removeFolderWithin(root));
    const { harnessDir } = await prepareScene(() => {}, root);
    const failure = Object.assign(new Error("server did not stop"), {
      code: "EBUSY",
    });
    /** 정리가 부른 dispose 수. 다른 것은 부르지 않는다. */
    let disposed = 0;
    const server = {
      running: false,
      dispose: async (...received) => {
        assert.deepEqual(received, []);
        disposed += 1;
        throw failure;
      },
    };
    // 정리가 터미널에 알린 줄을 기록만 한다(원래대로 출력된다).
    const reported = t.mock.method(console, "error");
    const cleanup = await cleanupScene({
      server,
      harnessDir,
      marker: `chaos-cleanup-test-${randomUUID()}`,
    });
    reported.mock.restore();
    assert.equal(disposed, 1);
    assert.equal(existsSync(harnessDir), true);
    assert.equal(cleanup.harnessKept, true);
    assert.equal(cleanup.problems, 1);
    assert.deepEqual(
      reported.mock.calls.map((call) => call.arguments),
      [
        ["[chaos] scene server cleanup failed (EBUSY)"],
        [
          `[chaos] the scene harness folder ${harnessDir} is kept: the scene server or its commands were not confirmed ended`,
        ],
      ]
    );
  });
});

// 정리 결과의 홈 칸은 지우기를 실제로 한 결과다. 뒤에 홈이 있는지 조회해 짐작하면, 조회가 "없음"을 낸 홈(조회 실패도 그렇게 나온다)을
// 지운 것으로 적었다(#286 3b-3a 5회차 점검). 정리는 홈을 조회하지 않으므로 홈 경로를 받지 않는다. 서버 정리가 지웠다고 알릴 때만 지운 것이다.
for (const scene of [
  {
    name: "a scene whose server cleanup failed",
    dispose: async () => {
      throw Object.assign(new Error("server did not stop"), { code: "EBUSY" });
    },
  },
  {
    name: "a scene whose server cleanup did not remove its home",
    dispose: async () => ({
      postgres: false,
      providerRecordsFound: 0,
      providerRecordsLeft: 0,
      homeRemoved: false,
    }),
  },
])
  test(`${scene.name} does not report its home removed`, async (t) => {
    await withCleanup(async (defer) => {
      const root = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-cleanup-"));
      defer(() => removeFolderWithin(root));
      const { harnessDir } = await prepareScene(() => {}, root);
      const server = {
        running: false,
        dispose: async (...received) => {
          assert.deepEqual(received, []);
          return scene.dispose();
        },
      };
      // 정리가 터미널에 알린 줄은 기록만 한다(원래대로 출력된다). 이 시험은 홈 칸만 본다.
      const reported = t.mock.method(console, "error");
      const cleanup = await cleanupScene({
        server,
        harnessDir,
        marker: `chaos-cleanup-test-${randomUUID()}`,
      });
      reported.mock.restore();
      assert.equal(cleanup.homeRemoved, false);
      assert.equal(cleanup.homeKept, true);
    });
  });
