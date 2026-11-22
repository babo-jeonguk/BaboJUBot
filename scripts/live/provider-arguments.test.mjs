// 실제 프로바이더 스크립트가 받는 프로바이더 이름은 정한 목록 안에서만 고른다(#281 리뷰 REC-1). 일반 객체를 허용 목록으로 두고
// `이름 in 객체`로 확인하면 모든 객체가 물려받는 이름(constructor·toString)도 통과해, 사용법 오류 대신 물려받은 함수를 프로바이더로
// 쓴다. 실제 모델은 부르지 않는다: 사용법 경로만 보고, PATH를 비워 어떤 프로바이더 CLI도 띄울 수 없게 한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scripts = [
  {
    script: "scripts/live/make-stdio-fixture.mjs",
    args: (name, folder) => [name, path.join(folder, "fixture.json")],
  },
  {
    script: "scripts/provider-live.mjs",
    args: (name) => [name, "--allow-live"],
  },
  {
    script: "scripts/provider-smoke.mjs",
    args: (name) => [name, "--allow-live"],
  },
];

for (const { script, args } of scripts)
  for (const name of ["constructor", "toString"])
    test(`${script} answers "${name}" with its usage`, (context) => {
      const folder = mkdtempSync(path.join(tmpdir(), "provider-arguments-"));
      context.after(() => removeFolder(folder));
      const result = spawnSync(
        process.execPath,
        [script, ...args(name, folder)],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          killSignal: "SIGKILL",
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([variable]) => !variable.startsWith("BABOJUBOT_")
              )
            ),
            BABOJUBOT_HOME: folder,
            PATH: "",
          },
        }
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /^Usage: /);
      assert.equal(existsSync(path.join(folder, "fixture.json")), false);
    });
