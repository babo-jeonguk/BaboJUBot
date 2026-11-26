// 실제 프로바이더 확인 스크립트의 정리: 앞 정리가 실패해도 뒤 정리를 하고, 정리 실패가 원래 실패를 가리지 않는다(#255).
// 실제 확인은 자격 증명이 들어 CI에서 돌리지 않으므로 자원을 여닫는 부분을 가짜 DB·서버로 확인한다.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  withCleanup,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
import { withCheckServer } from "./check-server.mjs";

/**
 * 닫힌 순서를 `closed`에 남기는 가짜 DB·서버. `failing`에 든 이름은 닫기에 실패한다. `own`이 있으면 서버가 제품 폴더를 받는 순간 그
 * 폴더의 지우기를 맡긴다(닫기가 실패해 폴더가 남는 시험: 단언이 어디서 실패해도 폴더를 남기지 않는다. 가짜 서버는 아무것도 돌리지 않는다).
 */
function resources(failing = [], own) {
  const closed = [];
  const opened = {};
  const closer = (name) => async () => {
    closed.push(name);
    if (failing.includes(name)) throw new Error(`${name} close failed`);
  };
  return {
    closed,
    opened,
    options: {
      prefix: "babojubot-check-server-",
      openDatabase: async () => ({ close: closer("database") }),
      startServer: async ({ workspace }) => {
        own?.(() => removeFolderWithin(workspace));
        opened.workspace = workspace;
        return { close: closer("server") };
      },
    },
  };
}

test("a finished check closes the server and the database and removes the folder", async () => {
  const { closed, opened, options } = resources();
  const result = await withCheckServer(options, ({ workspace }) => {
    assert.ok(existsSync(workspace));
    return "checked";
  });
  assert.equal(result, "checked");
  assert.deepEqual(closed, ["server", "database"]);
  assert.equal(existsSync(opened.workspace), false);
});

// 폴더는 서버가 쓰는 제품 폴더다. 서버나 DB의 닫기가 실패하면 그 끝을 확인하지 못했으므로 폴더를 남긴다(#286 3b-3, 닫힘 확인 뒤에만
// 지우기). 남은 폴더는 시험이 확인한 뒤 지운다(가짜 서버는 아무것도 돌리지 않는다).
test("a failing server close still closes the database and keeps the folder, and the check failure stays visible", async () => {
  await withCleanup(async (defer) => {
    const { closed, opened, options } = resources(["server"], defer);
    await assert.rejects(
      withCheckServer(options, () => {
        throw new Error("check failed");
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map((each) => each.message),
          ["check failed", "server close failed"]
        );
        return true;
      }
    );
    assert.deepEqual(closed, ["server", "database"]);
    assert.equal(existsSync(opened.workspace), true);
  });
});

test("a failing database close after a passed check is reported and the folder is kept", async () => {
  await withCleanup(async (defer) => {
    const { closed, opened, options } = resources(["database"], defer);
    await assert.rejects(
      withCheckServer(options, () => "checked"),
      {
        message: "database close failed",
      }
    );
    assert.deepEqual(closed, ["server", "database"]);
    assert.equal(existsSync(opened.workspace), true);
  });
});

test("a server that does not start leaves no database or folder behind", async () => {
  const { closed, options } = resources();
  /** @type {string | undefined} */
  let workspace;
  await assert.rejects(
    withCheckServer(
      {
        ...options,
        startServer: async (opened) => {
          workspace = opened.workspace;
          throw new Error("server did not start");
        },
      },
      () => assert.fail("the check ran without a server")
    ),
    /server did not start/
  );
  assert.deepEqual(closed, ["database"]);
  // 서버를 띄우려 했어야 그 폴더가 지워졌는지 볼 수 있다.
  assert.ok(workspace, "the server was not started with a workspace");
  assert.equal(existsSync(workspace), false);
});

test("a database that does not open leaves no folder behind", async () => {
  const { closed, options } = resources();
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith(options.prefix))
  );
  await assert.rejects(
    withCheckServer(
      {
        ...options,
        openDatabase: async () => {
          throw new Error("database did not open");
        },
      },
      () => assert.fail("the check ran without a database")
    ),
    /database did not open/
  );
  assert.deepEqual(closed, []);
  const left = readdirSync(tmpdir()).filter(
    (name) => name.startsWith(options.prefix) && !before.has(name)
  );
  assert.deepEqual(left, []);
});
