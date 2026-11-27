import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { hasErrorCode } from "@babojubot/contracts";
import { fileLinks } from "@babojubot/process/test-support";
import path from "node:path";
import { armSwap, resetSwap } from "@babojubot/process/fs-swap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRegularFile } from "./regular-file.ts";
import { testFolders } from "./test-folders.ts";

// 파일 종류와 내용을 한 번 연 파일 하나로 확인한다. 확인한 뒤 같은 경로를 다시 열면, 그 사이 바뀐 파일의 내용을 앞서 확인한
// 파일의 것으로 읽는다. 열린 직후 경로를 다른 파일로 바꿔 그 사이를 만든다.
const swap = vi.hoisted(() => ({
  /** 이 경로를 열면 이 오류로 실패하고 그 경로를 `failedAt`에 남긴다. */
  failing: undefined as
    { path: string; error: Error; failedAt: string[] } | undefined,
}));
// 열린 직후 경로를 다른 파일로 바꾸는 것은 공용 바꿔치기 대역(`@babojubot/process/fs-swap`)이 한다. 시험은 `armSwap`으로 무장한다.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const swapped = (await import("@babojubot/process/fs-swap")).swapAfter(real, [
    "open",
  ]);
  const open: typeof real.open = async (file, ...rest) => {
    const { failing } = swap;
    if (failing && String(file) === failing.path) {
      failing.failedAt.push(String(file));
      throw failing.error;
    }
    return swapped.open(file, ...rest);
  };
  return { ...real, open, default: { ...real, open } };
});

// 링크를 만들 권한이 없는 Windows에서는 링크 시험을 이유와 함께 건너뛴다. CI는 필수로 정해 권한 있는 실행기에서 링크 시험이
// 연 뒤 경로 항목과 연 파일을 대조하는 길을 실제로 돈다(`fileLinks`, #286 항목 16).
const canLink = fileLinks();

const folders = testFolders();
afterEach(() => {
  resetSwap();
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
    const failing = { path: file, error: denied, failedAt: [] as string[] };
    swap.failing = failing;
    await expect(readRegularFile(file)).rejects.toBe(denied);
    // 주입한 권한 오류는 그 시험의 경로를 연 열기에서 났다.
    expect(failing.failedAt).toEqual([file]);
  });

  // 열 때와 바로 뒤 사이에 자리가 바뀐 것은 없음이 아니라 확인하지 못한 것이다. 없음으로 접으면 부르는 쪽(자리 표시 확인)이
  // 그 자리에 새로 게시해 다른 쪽이 둔 파일을 바꾼다(#286 항목 6).
  it("throws when the place changed between the open and the look right after", async () => {
    const root = await folders.make("babojubot-regular-");
    const file = path.join(root, "login.json");
    await writeFile(file, "content");
    const failing = {
      path: file,
      error: Object.assign(new Error("no such file"), { code: "ENOENT" }),
      failedAt: [] as string[],
    };
    swap.failing = failing;
    await expect(readRegularFile(file)).rejects.toMatchObject({
      code: "changed",
    });
    // 주입한 "없음"은 그 시험의 경로를 연 열기에서 났다.
    expect(failing.failedAt).toEqual([file]);
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
      const swapped = armSwap({ path: file, replacement });
      expect(await readRegularFile(file)).toBe("opened");
      expect(swapped.used).toBe(true);
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
