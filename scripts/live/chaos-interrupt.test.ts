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
import { removeFolder } from "@babojubot/process/remove-folder";
import { within } from "@babojubot/process/test-support";

const handler = new URL("./chaos-interrupt.ts", import.meta.url).href;

test("a second Ctrl-C ends at once even when nobody reads the output", async (context) => {
  const folder = mkdtempSync(path.join(tmpdir(), "chaos-interrupt-"));
  context.after(() => removeFolder(folder));
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
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
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
  const exited = once(child, "exit");
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
});
