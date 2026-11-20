// 장면 서버의 마지막 정리 순서(#263 외부 리뷰 1회차 S1). 서버 멈춤·남은 DB·남은 프로바이더 기록·띄운 서버 트리 정리 중 앞 단계가
// 실패해도 띄운 트리는 끄고, 실패는 모아 알린다. 남은 DB와 기록의 제품 정리는 서버가 멈춘 뒤에만 한다(살아 있는 서버의 DB를 끄지 않음).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUpScene } from "./chaos-server.mjs";

const step = (done, name, failure) => async () => {
  done.push(name);
  if (failure) throw failure;
};

test("stops every server tree when a leftover cleanup fails, and reports the failure", async () => {
  const done = [];
  const failure = new Error("the leftover database could not be stopped");
  await assert.rejects(
    cleanUpScene({
      stopServer: step(done, "stop server"),
      cleanLeftovers: [
        step(done, "leftover database", failure),
        step(done, "leftover provider records"),
      ],
      stopTrees: step(done, "stop trees"),
      message: "scene cleanup failed",
    }),
    (error) => {
      assert.equal(error, failure);
      return true;
    }
  );
  assert.deepEqual(done, [
    "stop server",
    "leftover database",
    "leftover provider records",
    "stop trees",
  ]);
});

test("stops every server tree when the server does not stop, without touching what the live server holds", async () => {
  const done = [];
  const stopFailure = new Error("the server did not stop");
  const treeFailure = new Error("a tree could not be confirmed stopped");
  await assert.rejects(
    cleanUpScene({
      stopServer: step(done, "stop server", stopFailure),
      cleanLeftovers: [step(done, "leftover database")],
      stopTrees: step(done, "stop trees", treeFailure),
      message: "scene cleanup failed",
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [stopFailure, treeFailure]);
      return true;
    }
  );
  assert.deepEqual(done, ["stop server", "stop trees"]);
});
