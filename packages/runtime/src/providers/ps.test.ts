import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { psField } from "./ps.ts";
import { testFolders } from "./test-folders.ts";

// ps 한 칸 조회의 "대상 없음" 계약: 대상이 없으면 ps는 아무것도 쓰지 않고 1로 끝난다(macOS·procps). 그때만 없음이고,
// 다른 종료 코드·오류 출력·빈 성공은 pid와 원인을 담아 던진다. 끝남을 정하는 가짜 ps를 PATH 앞에 둔다.
const folders = testFolders();
afterEach(() => {
  vi.unstubAllEnvs();
});

/** `script`를 몸으로 하는 가짜 ps를 PATH 맨 앞에 둔다. */
async function fakePs(script: string) {
  const folder = await folders.make("babojubot-fake-ps-");
  await writeFile(
    path.join(folder, "ps"),
    `#!${process.execPath}\n${script}\n`,
    {
      mode: 0o755,
    }
  );
  vi.stubEnv("PATH", `${folder}${path.delimiter}${process.env.PATH}`);
}

describe.skipIf(process.platform === "win32")("a ps field query", () => {
  it("reads the field of a running process", () => {
    expect(psField(process.pid, "pid", 5_000)).toBe(String(process.pid));
  });

  it("takes an exit of 1 without output for a process that is gone", async () => {
    await fakePs("process.exit(1);");
    expect(psField(4242, "lstart", 5_000)).toBeUndefined();
  });

  it.each([
    [
      "exits 1 with an error message",
      `process.stderr.write("ps: illegal option -- o"); process.exit(1);`,
      /4242.*exit 1.*illegal option/,
    ],
    ["exits with another code", "process.exit(2);", /4242.*exit 2/],
    ["succeeds without output", "process.exit(0);", /4242.*no output/],
  ])("fails with the cause when ps %s", async (_case, script, cause) => {
    await fakePs(script);
    expect(() => psField(4242, "lstart", 5_000)).toThrow(cause);
  });

  it("fails with the cause when ps cannot be started", () => {
    vi.stubEnv("PATH", "");
    expect(() => psField(4242, "lstart", 5_000)).toThrow(/4242.*ENOENT/);
  });
});
