// 테스트가 실패하면 시험 실행도 실패 코드로 끝나는지 실제 vitest로 본다. 내장 DB를 싣는 라이브러리가 실패 코드를 0으로
// 덮어써서 CI가 실패를 놓친 적이 있다. 이 문제가 다시 생기면 패키지 안의 테스트는 스스로 실패를 숨기므로 밖에서 확인한다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "scripts/fixtures/test-exit-code");
const failingTest = ["run", "--dir", fixtures, "--globals"];
const brokenSetup = [
  "run",
  "--config",
  path.join(fixtures, "broken-setup.config.mjs"),
];
const cases = [
  {
    name: "실패한 DB 테스트",
    workspace: "packages/db",
    args: failingTest,
    expected: /Tests\s+1 failed \(1\)/,
  },
  {
    name: "실패한 서버 테스트",
    workspace: "apps/server",
    args: failingTest,
    expected: /Tests\s+1 failed \(1\)/,
  },
  {
    name: "시험용 DB 시작 실패",
    workspace: "packages/db",
    args: brokenSetup,
    expected: /test database failed to start/,
  },
];

let failed = false;
for (const { name, workspace, args, expected } of cases) {
  const cwd = path.join(root, workspace);
  const { status, signal, error, stdout, stderr } = spawnSync(
    process.execPath,
    [path.join(cwd, "node_modules/vitest/vitest.mjs"), ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    }
  );
  const output = `${stdout}\n${stderr}`;
  // 일부러 낸 실패로 끝났을 때만 성공이다. 다른 이유로 끝난 실행은 이 검사를 증명하지 못한다.
  if (!error && !signal && status && expected.test(output)) {
    console.log(`확인: ${name} → 종료 코드 ${status}`);
    continue;
  }
  failed = true;
  console.error(
    `실패: ${name}. 실패 코드와 ${expected}가 함께 나와야 합니다. 종료 코드 ${status}, 신호 ${signal}, 오류 ${error?.message}\n${output}`
  );
}
if (failed) process.exit(1);
console.log(
  `시험 실패가 실패 종료로 이어지는 것을 ${cases.length}가지로 확인했습니다.`
);
