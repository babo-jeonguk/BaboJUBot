// run-worker의 시간 한도(--limit)는 worker 호출 전체의 상한이다(#255 리뷰 SPEC-1). 한도에 닿으면 세션이 없어도 다시 띄우지 않고
// 종료 코드 4로 끝난다. 실제 모델은 부르지 않고, PATH 맨 앞의 가짜 opencode가 세션 없이 멈춰 있다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { withCleanup } from "@babojubot/runtime/test-cleanup";

const script = fileURLToPath(new URL("./run-worker.mjs", import.meta.url));

// 가짜 opencode: 띄워질 때마다 한 줄을 남기고, 세션을 알리지 않은 채 멈춰 있다.
const fakeOpencode = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_OPENCODE_LAUNCHES, "launch\\n");
setInterval(() => {}, 1000);
`;

test(
  "a worker that reaches --limit is not launched again and ends with exit code 4",
  {
    // run-worker는 worker를 자기 프로세스 그룹(음수 pid)으로 끈다. 가짜 opencode는 PATH의 shebang 스크립트다. 둘 다 POSIX 전용이다.
    skip:
      process.platform === "win32"
        ? "process groups and shebang scripts on PATH are POSIX only"
        : false,
  },
  async () => {
    await withCleanup(async (defer) => {
      const dir = mkdtempSync(path.join(tmpdir(), "babojubot-run-worker-"));
      defer(() => removeFolder(dir));
      const fake = path.join(dir, "opencode");
      writeFileSync(fake, fakeOpencode);
      chmodSync(fake, 0o755);
      const launches = path.join(dir, "launches");
      writeFileSync(launches, "");
      const result = spawnSync(
        process.execPath,
        [
          script,
          "--model",
          "fake/model",
          "--title",
          "limit test",
          "--out",
          path.join(dir, "out.jsonl"),
          "--message",
          "hi",
          // 한도(1.2초)가 세션 확인(60초)보다 먼저 온다.
          "--limit",
          "0.02",
          "--start-check",
          "60",
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            FAKE_OPENCODE_LAUNCHES: launches,
          },
        }
      );
      assert.equal(result.status, 4, result.stdout + result.stderr);
      assert.match(
        result.stdout,
        /^status: stopped after the 0\.02-minute limit$/m
      );
      assert.match(result.stdout, /^attempts: 1$/m);
      assert.equal(readFileSync(launches, "utf8"), "launch\n");
    });
  }
);
