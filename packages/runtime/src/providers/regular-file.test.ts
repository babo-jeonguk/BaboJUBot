import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { hasErrorCode } from "@babojubot/contracts";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRegularFile } from "./regular-file.ts";
import { testFolders } from "./test-folders.ts";

// 파일 종류와 내용을 한 번 연 파일 하나로 확인한다. 확인한 뒤 같은 경로를 다시 열면, 그 사이 바뀐 파일의 내용을 앞서 확인한
// 파일의 것으로 읽는다. 열린 직후 경로를 다른 파일로 바꿔 그 사이를 만든다.
const swap = vi.hoisted(() => ({
  /** 이 경로를 열면, 연 직후 `replacement`를 그 경로로 옮긴다. */
  path: undefined as string | undefined,
  replacement: undefined as string | undefined,
  /** 이 경로를 열면 이 오류로 실패한다. */
  failing: undefined as { path: string; error: Error } | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof real.open = async (file, ...rest) => {
    if (swap.failing && String(file) === swap.failing.path)
      throw swap.failing.error;
    const handle = await real.open(file, ...rest);
    if (swap.path && String(file) === swap.path && swap.replacement) {
      await real.rename(swap.replacement, swap.path);
      swap.path = undefined;
    }
    return handle;
  };
  return { ...real, open, default: { ...real, open } };
});

const folders = testFolders();
afterEach(() => {
  swap.path = undefined;
  swap.replacement = undefined;
  swap.failing = undefined;
});

describe("reading a file only if it is a regular file", () => {
  it("returns the contents of a regular file", async () => {
    const root = await folders.make("babojubot-regular-");
    const file = path.join(root, "login.json");
    await writeFile(file, "content");
    expect(await readRegularFile(file)).toBe("content");
  });

  it("returns nothing for a missing path or a folder", async () => {
    const root = await folders.make("babojubot-regular-");
    expect(await readRegularFile(path.join(root, "missing"))).toBeUndefined();
    await mkdir(path.join(root, "folder"));
    expect(await readRegularFile(path.join(root, "folder"))).toBeUndefined();
  });

  // 없는 것과 읽을 수 없는 것은 다르다. 권한·디스크 오류를 "파일 없음"으로 바꾸면 실제 장애가 조용히 사라진다.
  it("throws an open error other than a missing path, a link or a folder", async () => {
    const root = await folders.make("babojubot-regular-");
    const file = path.join(root, "login.json");
    await writeFile(file, "content");
    const denied = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    swap.failing = { path: file, error: denied };
    await expect(readRegularFile(file)).rejects.toBe(denied);
  });

  // Windows에서 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하다. 링크를 거절하는 동작은 POSIX에서 본다.
  it.skipIf(process.platform === "win32")(
    "returns nothing for a link, even to a regular file",
    async () => {
      const root = await folders.make("babojubot-regular-");
      const target = path.join(root, "target.json");
      await writeFile(target, "content");
      await symlink(target, path.join(root, "link.json"));
      expect(
        await readRegularFile(path.join(root, "link.json"))
      ).toBeUndefined();
    }
  );

  // Windows는 열린 파일의 자리에 다른 파일을 옮길 수 없어 이 사이가 생기지 않는다.
  it.skipIf(process.platform === "win32")(
    "reads the file it opened even when the path is replaced right after",
    async () => {
      const root = await folders.make("babojubot-regular-");
      const file = path.join(root, "login.json");
      await writeFile(file, "opened");
      const replacement = path.join(root, "replacement.json");
      await writeFile(replacement, "replaced");
      swap.path = file;
      swap.replacement = replacement;
      expect(await readRegularFile(file)).toBe("opened");
    }
  );

  // 다른 쪽(격리 실행의 에이전트)이 쓸 수 있는 자리에 FIFO를 두면, 쓰는 쪽 없이 읽기로 여는 열기는 끝나지 않는다(POSIX open()).
  // 열어서 종류를 확인하더라도 기다리지 않고 일반 파일이 아니라고 답해야 한다.
  it.skipIf(process.platform === "win32")(
    "returns nothing for a FIFO without waiting for a writer",
    { timeout: 10_000 },
    async () => {
      const root = await folders.make("babojubot-regular-");
      const fifo = path.join(root, "login.json");
      execFileSync("mkfifo", [fifo], { timeout: 10_000 });
      // 열기가 멈춰 있으면 쓰는 쪽으로 한 번 열어 풀어 준다. 읽는 쪽이 없으면(이미 끝남) ENXIO다.
      folders.own(async () => {
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch (error) {
          if (!hasErrorCode("ENXIO")(error)) throw error;
        }
      }, "fifo writer");
      expect(await readRegularFile(fifo)).toBeUndefined();
    }
  );
});
