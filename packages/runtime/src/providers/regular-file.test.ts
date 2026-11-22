import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hasErrorCode } from "@babojubot/contracts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";
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

/**
 * 이 컴퓨터에서 링크를 만들 수 있는가. Windows는 링크 만들기 권한(관리자·개발자 모드)이 있어야 하고, 없으면 EPERM이다.
 * 권한이 있는 Windows(CI 실행기)에서는 링크 시험이 연 뒤 경로 항목과 연 파일을 대조하는 길을 실제로 돈다.
 */
async function linksAllowed() {
  if (process.platform !== "win32") return true;
  return withCleanup(async (defer) => {
    const root = await mkdtemp(path.join(tmpdir(), "babojubot-link-"));
    defer(() => removeFolder(root));
    try {
      await symlink(path.join(root, "target"), path.join(root, "link"));
      return true;
    } catch (error) {
      if (hasErrorCode("EPERM")(error)) return false;
      throw error;
    }
  });
}
const canLink = await linksAllowed();

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

  it.skipIf(!canLink)(
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

  // 링크를 따라가는 열기(Windows)는 대상 없는 링크에서 ENOENT로 실패한다. 그래도 그 자리는 없는 경로가 아니라 링크다.
  it.skipIf(!canLink)(
    "returns nothing for a link whose target is missing",
    async () => {
      const root = await folders.make("babojubot-regular-");
      await symlink(
        path.join(root, "missing.json"),
        path.join(root, "link.json")
      );
      expect(
        await readRegularFile(path.join(root, "link.json"))
      ).toBeUndefined();
    }
  );

  // 위 폴더의 링크 순환은 그 경로의 링크·폴더·없음이 아니라 읽지 못한 것이다. 링크를 따라가지 않는 열기도 같은 ELOOP을 낸다.
  // Windows는 링크 순환을 POSIX의 ELOOP 규칙으로 알리지 않는다.
  it.skipIf(process.platform === "win32")(
    "throws when a link loop above the path stops it being read",
    async () => {
      const root = await folders.make("babojubot-regular-");
      const loop = path.join(root, "loop");
      await symlink(loop, loop);
      await expect(
        readRegularFile(path.join(loop, "login.json"))
      ).rejects.toMatchObject({ code: "ELOOP" });
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
