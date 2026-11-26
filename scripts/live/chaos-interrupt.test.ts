// 두 번째 Ctrl-C는 비상 종료다: 출력이 다 닿기를 기다리지 않고 바로 끝난다. 표준 출력을 아무도 읽지 않는 파이프면 출력이 영영 닿지
// 않으므로, 출력을 기다리면 사용자가 끝낼 길이 없어진다(#292 외부 리뷰 1회차 SPEC-1). 처리기를 단 프로그램이 읽지 않는 파이프에 큰
// 출력을 낸 뒤 SIGINT를 두 번 받는다. 시험의 상한은 실패 판정용이다: 끝남은 프로그램의 exit 이벤트로 본다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  awaitedLater,
  folderCleanup,
  withCleanup,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";

const handler = new URL("./chaos-interrupt.ts", import.meta.url).href;

// 정리는 자원을 잡은 직후 등록하고 의존 순서를 지킨다: 프로그램을 끄고 끝과 출력 닫힘(close)을 상한 안에서 확인한 뒤 폴더를 지운다
// (CODING_STANDARDS.md#정리, #292 외부 리뷰 2회차 STD-3, 3회차 권고). 정상과 실패가 같은 길이다.
test("a second Ctrl-C ends at once even when nobody reads the output", () =>
  withCleanup(async (defer) => {
    const folder = mkdtempSync(path.join(tmpdir(), "chaos-interrupt-"));
    const { own, cleanUp } = folderCleanup(() => removeFolderWithin(folder));
    defer(cleanUp);
    const driver = path.join(folder, "driver.mjs");
    writeFileSync(
      driver,
      `import { installUserInterrupt } from ${JSON.stringify(handler)};
installUserInterrupt(new AbortController());
process.stdout.write("o".repeat(${4 << 20}));
process.stderr.write("ready\\n");
setInterval(() => undefined, 1000);
`
    );
    const child = spawn(process.execPath, [driver], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = awaitedLater(once(child, "exit"));
    const closed = awaitedLater(once(child, "close"));
    // 자식 객체로 끈다: Node는 끝을 본 자식에는 신호를 보내지 않는다. 읽지 않던 출력은 흘려보내 끝까지 읽어야 닫힘이 온다(끝난
    // 프로그램의 출력을 물려받은 자손이 쥐고 있으면 오지 않아 실패한다).
    own(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      child.stdout.resume();
      child.stderr.resume();
      await within(closed, 10_000, "a killed driver or its output did not end");
    });
    // 표준 출력은 읽지 않는다(파이프가 차서 프로그램의 쓰기가 끝나지 않는다).
    child.stdout.pause();
    let stderr = "";
    const stderrHas = (text: string) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!stderr.includes(text)) return;
          child.stderr.off("data", onData);
          resolve();
        };
        const onData = (chunk: Buffer) => {
          stderr += String(chunk);
          check();
        };
        child.stderr.on("data", onData);
        check();
      });
    await within(stderrHas("ready"), 30_000, "the driver did not get ready");
    child.kill("SIGINT");
    await within(
      stderrHas("Stopping"),
      30_000,
      "the first Ctrl-C was not handled"
    );
    child.kill("SIGINT");
    const [code] = await within(
      exited,
      10_000,
      "the second Ctrl-C did not end the program"
    );
    assert.equal(code, 130);
  }));
