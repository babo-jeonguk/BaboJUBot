// 스크립트가 출력한 뒤 바로 process.exit()하면, 파이프로 이어진 표준 출력·오류에 아직 쓰지 못한 출력이 버려진다(POSIX의 파이프 쓰기는
// 비동기다, Node 문서 process `A note on process I/O`). 4MB를 쓰고 바로 끝낸 자식에서 부모가 받은 것은 146176바이트였다
// (#286, PR #287 같은 모양 수색의 PR 4 그룹 몫). 스크립트는 `process.exit(await afterOutput(code))`로 쓴 출력이 모두 닿은 뒤 끝낸다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const helper = pathToFileURL(
  new URL("./exit-after-output.ts", import.meta.url).pathname
).href;
const size = 4 << 20;

function run(code: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
}

test("hands back the exit code once everything written to stdout and stderr has reached the pipe", () => {
  const result = run(
    `import { afterOutput } from ${JSON.stringify(helper)};\nprocess.stdout.write("o".repeat(${size}));\nprocess.stderr.write("e".repeat(${size}));\nprocess.exit(await afterOutput(3));\n`
  );
  assert.equal(result.status, 3, result.stderr.slice(-200));
  assert.equal(result.stdout.length, size);
  assert.equal(result.stderr.length, size);
});
