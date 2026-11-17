import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { readyLine } from "./process-test-support.ts";

// 준비 줄 없이 끝난 프로그램을 시한(10초)까지 기다리지 않는다. 출력을 물려받은 자손이 남아 출력이 닫히지 않아도 종료로 판단한다(PR #220 외부 리뷰 STD-1).
it.skipIf(process.platform === "win32")(
  "fails soon after the program exits without its ready line, even while a descendant holds its output",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: ["ignore", "inherit", "ignore"] }).unref();`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const started = Date.now();
    await expect(readyLine(child, "ready", 10_000, 500)).rejects.toThrow(
      "exited before printing ready"
    );
    expect(Date.now() - started).toBeLessThan(3000);
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
