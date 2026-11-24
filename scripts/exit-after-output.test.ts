// 스크립트가 출력한 뒤 바로 process.exit()하면, 파이프로 이어진 표준 출력·오류에 아직 쓰지 못한 출력이 버려진다(POSIX의 파이프 쓰기는
// 비동기다, Node 문서 process `A note on process I/O`). 4MB를 쓰고 바로 끝낸 자식에서 부모가 받은 것은 146176바이트였다
// (#286, PR #287 같은 모양 수색의 PR 4 그룹 몫). 스크립트는 `process.exit(await afterOutput(code))`로 쓴 출력이 모두 닿은 뒤 끝낸다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { within } from "@babojubot/process/test-support";

// 같은 폴더의 도움을 URL로 바로 푼다. URL의 pathname은 퍼센트 인코딩된 글이라 파일 경로나 다른 파일 URL의 재료가 아니다.
const helper = new URL("./exit-after-output.ts", import.meta.url).href;
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

// 시험은 checkout 경로에 공백·`%`가 있어도 돌아야 한다. URL의 pathname은 퍼센트 인코딩된 글이라 그것을 다시 파일 URL로 만들면 `%20`이
// `%2520`이 되어 도움 파일을 찾지 못한다(#292 외부 리뷰 1회차 STD-1). 이 시험 파일과 도움을 그런 폴더에 옮겨 위 시험을 거기서 돌린다.
test("runs from a checkout path holding a space and a percent sign", (context) => {
  const folder = path.join(
    mkdtempSync(path.join(tmpdir(), "exit-after-output-")),
    "a dir %25 here"
  );
  context.after(() => removeFolder(path.dirname(folder)));
  mkdirSync(folder);
  for (const file of ["exit-after-output.ts", "exit-after-output.test.ts"])
    copyFileSync(
      fileURLToPath(new URL(`./${file}`, import.meta.url)),
      path.join(folder, file)
    );
  // 옮긴 시험이 저장소의 패키지를 가져가도록 node_modules를 잇는다.
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    path.join(folder, "node_modules"),
    "junction"
  );
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=hands back the exit code",
      path.join(folder, "exit-after-output.test.ts"),
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== "NODE_TEST_CONTEXT"
        )
      ),
    }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# pass 1/);
});

// 출력을 다 쓰지 못하면 성공 코드(0)로 끝내지 않고 1로 끝내며, 0이 아닌 코드는 그대로 둔다(#292 외부 리뷰 1회차 권고). 부모가 자식
// 표준 출력의 읽는 쪽을 먼저 닫아 쓰기가 EPIPE로 실패하게 한다. 자식은 신호(표준 입력)를 받은 뒤에야 쓴다.
test("hands back 1 instead of 0, and keeps any other code, when the output cannot be written", async (context) => {
  const folder = mkdtempSync(path.join(tmpdir(), "exit-after-output-pipe-"));
  context.after(() => removeFolder(folder));
  const driver = path.join(folder, "driver.mjs");
  writeFileSync(
    driver,
    `import { afterOutput } from ${JSON.stringify(helper)};
process.stdin.once("data", async () => {
  process.stdout.write("x".repeat(${1 << 20}));
  const code = await afterOutput(Number(process.argv[2]));
  process.stderr.write("handed back " + code + "\\n");
  process.exit(code);
});
`
  );
  for (const [asked, expected] of [
    [0, 1],
    [3, 3],
  ] as const) {
    const child = spawn(process.execPath, [driver, String(asked)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    const exited = once(child, "exit");
    child.stdout.destroy();
    child.stdin.write("go\n");
    const [code] = await within(exited, 60_000, "the driver did not end");
    assert.equal(code, expected, stderr);
    assert.match(stderr, new RegExp(`^handed back ${expected}$`, "m"));
  }
});
