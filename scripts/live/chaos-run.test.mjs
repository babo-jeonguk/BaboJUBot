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

/**
 * 준비한 장면을 가짜 서버(`dispose`만 있음)로 정리하고 결과, harness 폴더, 정리가 터미널에 알린 줄을 돌려준다. 장면 폴더는 시험이
 * 소유한 임시 폴더 아래에 만든다. `dispose`는 받은 인수 없이 한 번만 불려야 한다. 알린 줄은 기록만 한다(원래대로 출력된다).
 */
async function cleanedUpWith(t, defer, dispose) {
  const root = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-cleanup-"));
  defer(() => removeFolderWithin(root));
  const { harnessDir } = await prepareScene(() => {}, root);
  let disposed = 0;
  const server = {
    running: false,
    dispose: async (...received) => {
      assert.deepEqual(received, []);
      disposed += 1;
      return dispose();
    },
  };
  const reported = t.mock.method(console, "error");
  const cleanup = await cleanupScene({
    server,
    harnessDir,
    marker: `chaos-cleanup-test-${randomUUID()}`,
  });
  reported.mock.restore();
  assert.equal(disposed, 1);
  return {
    cleanup,
    harnessDir,
    reported: reported.mock.calls.map((call) => call.arguments),
  };
}

// 장면 서버와 시험용 명령은 harness 폴더를 쓴다. 서버 정리가 실패하면 그 끝을 확인하지 못했으므로 폴더를 지우지 않고 남기고, 정리
// 실패로 센다(#298 자원 표에서 찾음: 그동안 dispose가 실패해도 지웠다). 홈도 지웠다고 적지 않는다: 정리 결과의 폴더 칸은 지우기를 실제로
// 한 결과이고, 뒤에 조회해 짐작하면 조회가 "없음"을 낸 홈(조회 실패도 그렇게 나온다)을 지운 것으로 적었다(#286 3b-3a 5회차 점검).
test("a scene whose server cleanup failed keeps its folders and counts the failure", async (t) => {
  await withCleanup(async (defer) => {
    const { cleanup, harnessDir, reported } = await cleanedUpWith(
      t,
      defer,
      async () => {
        throw Object.assign(new Error("server did not stop"), {
          code: "EBUSY",
        });
      }
    );
    assert.equal(existsSync(harnessDir), true);
    assert.equal(cleanup.harnessKept, true);
    assert.equal(cleanup.homeRemoved, false);
    assert.equal(cleanup.homeKept, true);
    assert.equal(cleanup.problems, 1);
    assert.deepEqual(reported, [
      ["[chaos] scene server cleanup failed (EBUSY)"],
      [
        `[chaos] the scene harness folder ${harnessDir} is kept: the scene server or its commands were not confirmed ended`,
      ],
    ]);
  });
});

// 서버 정리가 실패하면 남은 DB·프로세스 기록을 알 수 없다. 그 칸을 "남은 것 없음"(false·0)으로 적지 않고 모름(null)으로 적고,
// 장면은 정리되지 않은 것으로 센다(#286 PR 3b-3b-1 감독 판정: 모름을 없음으로 접던 `?? false`·`?? 0`).
test("a scene whose server cleanup failed records its leftovers as unknown, not none", async (t) => {
  await withCleanup(async (defer) => {
    const { cleanup } = await cleanedUpWith(t, defer, async () => {
      throw Object.assign(new Error("server did not stop"), {
        code: "EBUSY",
      });
    });
    assert.deepEqual(
      {
        postgresLeft: cleanup.postgresLeft,
        providerRecordsFound: cleanup.providerRecordsFound,
        providerRecordsLeft: cleanup.providerRecordsLeft,
      },
      {
        postgresLeft: null,
        providerRecordsFound: null,
        providerRecordsLeft: null,
      }
    );
  });
});

// 서버 정리가 홈 지우기를 시작했지만 그 끝을 확인하지 못했으면(실패·상한 초과, 그 뒤에 지워질 수 있다) 그 홈은 남긴 것이 아니라
// 지우기를 확인하지 못한 것이다. 결과 칸에 그대로 적고 정리 문제로 센다. 서버의 끝은 확인됐으므로 harness 폴더는 지운다
// (#286 PR #300 외부 리뷰 1회차 SPEC-1).
test("a scene whose home removal was not confirmed records it as unconfirmed, not kept, and counts it", async (t) => {
  await withCleanup(async (defer) => {
    const { cleanup, harnessDir } = await cleanedUpWith(t, defer, async () => ({
      postgres: false,
      providerRecordsFound: 0,
      providerRecordsLeft: 0,
      home: "unconfirmed",
    }));
    assert.deepEqual(
      {
        home: cleanup.home,
        harness: cleanup.harness,
        problems: cleanup.problems,
      },
      { home: "unconfirmed", harness: "removed", problems: 1 }
    );
    assert.equal(existsSync(harnessDir), false);
  });
});

// 서버 정리가 끝났어도 되살리지 못한 프로세스 기록이 남으면 사람이 볼 수 있게 홈을 남긴다(`dispose`가 지우지 않았다고 알림).
test("a scene whose server cleanup kept its home for left provider records does not report it removed", async (t) => {
  await withCleanup(async (defer) => {
    const { cleanup } = await cleanedUpWith(t, defer, async () => ({
      postgres: false,
      providerRecordsFound: 1,
      providerRecordsLeft: 1,
      homeRemoved: false,
    }));
    assert.equal(cleanup.homeRemoved, false);
    assert.equal(cleanup.homeKept, true);
    assert.equal(cleanup.providerRecordsLeft, 1);
  });
});
