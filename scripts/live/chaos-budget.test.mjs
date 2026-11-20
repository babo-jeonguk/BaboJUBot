// 실모델 장애 검사의 실행 관문(gateConnection)이 읽기 실패를 "예산 없음"·"준비 안 됨"으로 숨기지 않고, 실행 시도 토큰을 쓴 뒤
// 실패해도 토큰 파일을 남기지 않는지 본다(#255 리뷰 SPEC-2·STD-1). 실제 모델은 부르지 않는다.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { withCleanup } from "@babojubot/runtime/test-cleanup";
import {
  createLedger,
  gateConnection,
  writeBudget,
  writeSecretFile,
} from "./chaos-budget.mjs";
import { permissionDenial } from "@babojubot/runtime/testing";

// Windows는 파일 권한으로 읽기를 막을 수 없고, root는 권한과 상관없이 읽는다.
// root는 권한을 넘어 읽으므로 그 시험은 root에서 건너뛴다. CI는 BABOJUBOT_REQUIRE_PERMISSION_DENIAL=1로 필수로 정한다.
const noPermissionDenial =
  process.platform === "win32"
    ? "file modes cannot make a file unreadable on Windows"
    : !permissionDenial() && "root reads files regardless of their mode";

const budget = {
  scene: "a",
  maxLiveRuns: 5,
  sceneMaxRuns: 5,
  deadlineAt: Date.now() + 3_600_000,
};

const request = {
  identity: { runId: "run-1" },
  access: { token: "token-1" },
  instructions: [],
  context: {},
  previousSession: null,
  wakeReasons: [],
  model: null,
};

/** 관문 하나와 그 파일들. `prepare(files)`로 예산·제어 파일을 망가뜨린다. 안쪽 실행은 부른 횟수만 센다. */
async function withGate(prepare, check, readiness) {
  await withCleanup(async (defer) => {
    const dir = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-gate-"));
    defer(() => removeFolder(dir));
    const files = {
      ledgerFile: path.join(dir, "ledger.jsonl"),
      budgetFile: path.join(dir, "budget.json"),
      tokenDir: dir,
      controlFile: path.join(dir, "control.json"),
    };
    writeBudget(files.budgetFile, budget);
    // 권한을 뺀 파일도 정리 때 지울 수 있게 되돌린다(폴더 권한은 그대로라 지우기는 된다).
    defer(() => {
      for (const file of [files.budgetFile, files.controlFile])
        if (existsSync(file)) chmodSync(file, 0o600);
    });
    prepare(files);
    const executed = [];
    const connection = gateConnection(
      {
        id: "live",
        adapter: {
          capabilities: {},
          checkReadiness:
            readiness ?? (async () => ({ status: "ready", reason: null })),
          async execute(input) {
            executed.push(input.identity.runId);
            return {
              stopReason: "completed",
              error: null,
              summary: null,
              usage: null,
              nextSession: null,
            };
          },
        },
      },
      { live: true, brief: "brief", ...files }
    );
    const run = () =>
      connection.adapter.execute(request, {
        signal: new AbortController().signal,
        emit: async () => {},
      });
    const tokenFile = path.join(dir, "run-1.token");
    await check({
      run,
      executed,
      tokenFile,
      ledger: createLedger(files.ledgerFile),
    });
  });
}

test("a broken control file fails the run with its error and leaves no run token", async () => {
  await withGate(
    (files) => writeFileSync(files.controlFile, "{not json"),
    async ({ run, executed, tokenFile }) => {
      await assert.rejects(run(), SyntaxError);
      assert.deepEqual(executed, []);
      assert.equal(existsSync(tokenFile), false);
    }
  );
});

test("a control file that cannot be read (not a file) fails the run and leaves no run token", async () => {
  await withGate(
    (files) => mkdirSync(files.controlFile),
    async ({ run, executed, tokenFile }) => {
      await assert.rejects(run(), { code: "EISDIR" });
      assert.deepEqual(executed, []);
      assert.equal(existsSync(tokenFile), false);
    }
  );
});

test(
  "a control file without read permission fails the run and leaves no run token",
  { skip: noPermissionDenial },
  async () => {
    await withGate(
      (files) => {
        writeFileSync(files.controlFile, "{}");
        chmodSync(files.controlFile, 0o000);
      },
      async ({ run, executed, tokenFile }) => {
        await assert.rejects(run(), { code: "EACCES" });
        assert.deepEqual(executed, []);
        assert.equal(existsSync(tokenFile), false);
      }
    );
  }
);

test(
  "a budget file without read permission is an error, not a missing budget",
  { skip: noPermissionDenial },
  async () => {
    await withGate(
      (files) => chmodSync(files.budgetFile, 0o000),
      async ({ run, executed, ledger }) => {
        await assert.rejects(run(), { code: "EACCES" });
        assert.deepEqual(executed, []);
        assert.deepEqual(
          ledger.read().filter((e) => e.kind === "refused"),
          []
        );
      }
    );
  }
);

test("a budget path that cannot be read as a file is an error, not a missing budget", async () => {
  await withGate(
    (files) => {
      removeBudget(files);
      mkdirSync(files.budgetFile);
    },
    async ({ run, executed }) => {
      await assert.rejects(run(), { code: "EISDIR" });
      assert.deepEqual(executed, []);
    }
  );
});

test("a missing or unparsable budget refuses the live run as no budget", async () => {
  for (const prepare of [
    removeBudget,
    (files) => writeFileSync(files.budgetFile, "{not json"),
  ])
    await withGate(prepare, async ({ run, executed, ledger }) => {
      const result = await run();
      assert.equal(result.stopReason, "failed");
      assert.match(result.error, /no budget/);
      assert.deepEqual(executed, []);
      assert.deepEqual(
        ledger.read().map((e) => [e.kind, e.reason]),
        [["refused", "no_budget"]]
      );
    });
});

test("a failing readiness check refuses the run and names the failure", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await withGate(
    () => {},
    async ({ run, executed }) => {
      const result = await run();
      assert.match(result.error, /no free model/);
      assert.deepEqual(executed, []);
      assert.ok(
        logged.mock.calls.some((call) =>
          String(call.arguments[0]).includes("ECONNRESET")
        ),
        "the readiness failure was not reported"
      );
    },
    async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
  );
});

/** 예산 파일이 없는 상태를 만든다(파일 하나만 지운다). */
function removeBudget(files) {
  rmSync(files.budgetFile);
}

test("a secret file whose write fails is not left behind and the write error is kept", async () => {
  await withCleanup(async (defer) => {
    const dir = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-secret-"));
    defer(() => removeFolder(dir));
    const file = path.join(dir, "token");
    // 문자열·버퍼가 아닌 내용은 파일을 만든 뒤 쓰기에서 실패한다.
    await assert.rejects(
      async () => writeSecretFile(file, { not: "text" }),
      TypeError
    );
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a replacement whose write fails keeps the old file and leaves no partial one", async () => {
  await withCleanup(async (defer) => {
    const dir = mkdtempSync(path.join(tmpdir(), "babojubot-chaos-secret-"));
    defer(() => removeFolder(dir));
    const file = path.join(dir, "control.json");
    writeSecretFile(file, '{"before":true}');
    await assert.rejects(
      async () => writeSecretFile(file, { not: "text" }, { replace: true }),
      TypeError
    );
    assert.deepEqual(readdirSync(dir), ["control.json"]);
    assert.equal(readFileSync(file, "utf8"), '{"before":true}');
  });
});
