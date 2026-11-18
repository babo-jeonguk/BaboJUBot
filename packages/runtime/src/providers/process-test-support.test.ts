import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { killAndWait, readyLine } from "./process-test-support.ts";

// 준비 줄 없이 끝난 프로그램을 시한(10초)까지 기다리지 않는다. 출력을 물려받은 자손이 남아 출력이 닫히지 않아도 종료로 판단한다(PR #220 외부 리뷰 STD-1).
// 자손은 시험이 끌 때까지 끝나지 않으므로 출력은 닫히지 않는다. 종료로 판단하지 않았다면 시한 문구("no ready line within")로 실패한다.
it.skipIf(process.platform === "win32")(
  "fails soon after the program exits without its ready line, even while a descendant holds its output",
  async () => {
    // 자손 번호는 오류 출력으로 받아, 시험이 끝나면 끄고 끝날 때까지 기다린다.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const d = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] }); d.unref(); process.stderr.write(d.pid + "\\n");`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let descendant = "";
    child.stderr!.on("data", (chunk: Buffer) => (descendant += String(chunk)));
    try {
      await expect(readyLine(child, "ready", 10_000, 500)).rejects.toThrow(
        "exited before printing ready"
      );
    } finally {
      const pid = Number(descendant.trim());
      if (pid > 1) await killAndWait([pid]);
    }
  }
);

it("still reads a ready line written just before the program exits", async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.stdout.write("noise\\nready\\n"); process.exit(0)`],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  await expect(readyLine(child)).resolves.toBeUndefined();
});
