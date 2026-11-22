// 장면 준비가 실패해도 그때까지 만든 폴더를 남기지 않고 원래 실패를 드러내는지 본다(#255 리뷰 권고). 실제 모델은 부르지 않는다.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { prepareScene } from "./chaos-run.mjs";

test("a failing scene preparation removes the folders it made and keeps its error", async () => {
  await withCleanup(async (defer) => {
    const root = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-prepare-"));
    defer(() => removeFolder(root));
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
    defer(() => removeFolder(root));
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
