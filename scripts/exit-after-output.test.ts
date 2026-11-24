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
import { folderCleanup, withCleanup } from "@babojubot/process/test-cleanup";
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

// checkout 경로에 공백·`%`가 있어도 도움을 찾아야 한다. URL의 pathname은 퍼센트 인코딩된 글이라 그것을 다시 파일 URL로 만들면
// `%20`이 `%2520`이 되어 도움 파일을 찾지 못한다(#292 외부 리뷰 1회차 STD-1). 그런 폴더에 도움을 두고, 같은 폴더의 스크립트가 이 시험
// 파일처럼 자기 URL에서 도움을 풀어 가져와 쓰고 끝내게 한다. 안쪽 시험 러너의 보고 글은 판마다 바뀔 수 있어 판정에 쓰지 않는다(#292
// 외부 리뷰 5회차 STD-5). 종료 코드와 출력을 정확한 값으로 본다.
test("resolves the helper by URL from a path holding a space and a percent sign", (context) => {
  const folder = path.join(
    mkdtempSync(path.join(tmpdir(), "exit-after-output-")),
    "a dir %25 here"
  );
  context.after(() => removeFolder(path.dirname(folder)));
  mkdirSync(folder);
  copyFileSync(
    fileURLToPath(new URL("./exit-after-output.ts", import.meta.url)),
    path.join(folder, "exit-after-output.ts")
  );
  // 옮긴 도움이 저장소의 패키지를 가져가도록 node_modules를 잇는다.
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    path.join(folder, "node_modules"),
    "junction"
  );
  const script = path.join(folder, "driver.mjs");
  writeFileSync(
    script,
    `const { afterOutput } = await import(new URL("./exit-after-output.ts", import.meta.url).href);
process.stdout.write("o".repeat(${size}));
process.stderr.write("e".repeat(${size}));
process.exit(await afterOutput(3));
`
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  assert.equal(result.status, 3, result.stderr.slice(-200));
  assert.equal(result.stdout, "o".repeat(size));
  assert.equal(result.stderr, "e".repeat(size));
});

// 출력을 다 쓰지 못하면 성공 코드(0)로 끝내지 않고 1로 끝내며, 0이 아닌 코드는 그대로 둔다(#292 외부 리뷰 1회차 권고). 부모가 자식
// 표준 출력의 읽는 쪽을 먼저 닫아 쓰기가 EPIPE로 실패하게 한다. 자식은 신호(표준 입력)를 받은 뒤에야 쓴다. 종료와 출력의 끝(표준
// 오류의 end, 닫은 표준 출력의 close)을 띄운 직후 각각 기록하고, 모두 상한 안에 끝난 뒤 단언한다: exit 때는 표준 오류가 아직 열려
// 있을 수 있다(CODING_STANDARDS.md, #292 외부 리뷰 2회차 STD-2). 정리는 자식을 끄고 끝과 출력 닫힘(close)을 상한 안에서 확인한 뒤
// 폴더를 지운다(#292 외부 리뷰 3회차 권고).
test("hands back 1 instead of 0, and keeps any other code, when the output cannot be written", () =>
  withCleanup(async (defer) => {
    const folder = mkdtempSync(path.join(tmpdir(), "exit-after-output-pipe-"));
    const { own, cleanUp } = folderCleanup(() => removeFolder(folder));
    defer(cleanUp);
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
      const exited = once(child, "exit");
      // 정리도 기다리는 닫힘(close)을 본문의 기다림에 함께 둔다. 거기서 바로 처리기가 붙어, 띄우지 못한 자식의 거절이 처리되지 않은
      // 채 남지 않는다.
      const closed = once(child, "close");
      const ended = Promise.all([
        exited,
        once(child.stderr, "end"),
        once(child.stdout, "close"),
        closed,
      ]);
      // 자식 객체로 끈다: Node는 끝을 본 자식에는 신호를 보내지 않는다.
      own(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await within(
          closed,
          10_000,
          "a killed driver or its output did not end"
        );
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
      child.stdout.destroy();
      child.stdin.write("go\n");
      const [[code]] = await within(
        ended,
        60_000,
        "the driver or its output did not end"
      );
      assert.equal(code, expected, stderr);
      assert.equal(stderr, `handed back ${expected}\n`);
    }
  }));
