import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasErrorCode } from "@babojubot/contracts";
import { armSwap, resetSwap } from "@babojubot/process/fs-swap";
import { fileLinks } from "@babojubot/process/test-support";
import { testFolders } from "@babojubot/process/testing";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { openRegularFile } from "./regular-file.ts";

// 확인한 파일과 읽는 파일이 같아야 한다. 열린 직후 경로를 다른 파일로 바꾸거나, 열기를 원하는 오류로 실패시켜 그 사이를 만든다.
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

/** 연 결과. 열었으면 그 handle에서 읽은 내용이고 handle은 시험 끝에 닫는다. 열지 않았으면 그 이유다. */
async function opened(file: string) {
  const result = await openRegularFile(file);
  if (typeof result === "string") return result;
  onTestFinished(() => result.handle.close());
  return await result.handle.readFile("utf8");
}

describe("opening a file in a place others can change, only if it is a regular file", () => {
  it("opens a regular file and gives its kind and size from the same handle", async () => {
    const root = await folders.make("babojubot-files-");
    const file = path.join(root, "mark.json");
    await writeFile(file, "content");
    const result = await openRegularFile(file);
    if (typeof result === "string") throw new Error(`not opened: ${result}`);
    onTestFinished(() => result.handle.close());
    expect(result.info.isFile()).toBe(true);
    expect(result.info.size).toBe(7n);
    expect(await result.handle.readFile("utf8")).toBe("content");
  });

  it("calls a missing path missing", async () => {
    const root = await folders.make("babojubot-files-");
    expect(await opened(path.join(root, "missing"))).toBe("missing");
  });

  it("calls a folder not a regular file", async () => {
    const root = await folders.make("babojubot-files-");
    await mkdir(path.join(root, "folder"));
    expect(await opened(path.join(root, "folder"))).toBe("not-regular");
  });

  it.skipIf(!canLink)(
    "calls a link not a regular file, even a link to one",
    async () => {
      const root = await folders.make("babojubot-files-");
      const target = path.join(root, "target.json");
      await writeFile(target, "content");
      await symlink(target, path.join(root, "link.json"));
      expect(await opened(path.join(root, "link.json"))).toBe("not-regular");
    }
  );

  // 링크를 따라가는 열기(Windows)는 대상 없는 링크에서 ENOENT로 실패한다. 그래도 그 자리는 없는 경로가 아니라 링크다.
  it.skipIf(!canLink)(
    "calls a link whose target is missing not a regular file, not missing",
    async () => {
      const root = await folders.make("babojubot-files-");
      await symlink(
        path.join(root, "missing.json"),
        path.join(root, "link.json")
      );
      expect(await opened(path.join(root, "link.json"))).toBe("not-regular");
    }
  );

  // 다른 쪽이 FIFO를 두면, 쓰는 쪽 없이 읽기로 여는 열기는 끝나지 않는다(POSIX open()). 기다리지 않고 일반 파일이 아니라고 답한다.
  it.skipIf(process.platform === "win32")(
    "calls a FIFO not a regular file without waiting for a writer",
    { timeout: 10_000 },
    async () => {
      const root = await folders.make("babojubot-files-");
      const fifo = path.join(root, "mark.json");
      execFileSync("mkfifo", [fifo], { timeout: 10_000 });
      // 열기가 멈춰 있으면 쓰는 쪽으로 한 번 열어 풀어 준다. 읽는 쪽이 없으면(이미 끝남) ENXIO다.
      folders.own(async () => {
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch (error) {
          if (!hasErrorCode("ENXIO")(error)) throw error;
        }
      }, "fifo writer");
      expect(await opened(fifo)).toBe("not-regular");
    }
  );

  // 위 폴더의 링크 순환은 그 자리의 링크가 아니라 읽지 못한 것이다. 링크를 따라가지 않는 열기도 같은 ELOOP을 낸다.
  // Windows는 링크 순환을 POSIX의 ELOOP 규칙으로 알리지 않는다.
  it.skipIf(process.platform === "win32")(
    "throws the open error when a link loop above the path stops it being opened",
    async () => {
      const root = await folders.make("babojubot-files-");
      const loop = path.join(root, "loop");
      await symlink(loop, loop);
      await expect(
        openRegularFile(path.join(loop, "mark.json"))
      ).rejects.toMatchObject({ code: "ELOOP" });
    }
  );

  // 위 칸이 폴더가 아닌 것은 없음과 다르다. 부르는 쪽이 원인(ENOTDIR)을 보고 정한다. Windows는 이때 ENOENT를 낸다.
  it.skipIf(process.platform === "win32")(
    "throws the open error when a file sits where a folder above should be",
    async () => {
      const root = await folders.make("babojubot-files-");
      await writeFile(path.join(root, "folder"), "a file");
      await expect(
        openRegularFile(path.join(root, "folder", "mark.json"))
      ).rejects.toMatchObject({ code: "ENOTDIR" });
    }
  );

  // 없는 것과 열 수 없는 것은 다르다. 권한·디스크 오류를 "없음"으로 바꾸면 실제 장애가 조용히 사라진다.
  it("throws an open error on a regular file as it is", async () => {
    const root = await folders.make("babojubot-files-");
    const file = path.join(root, "mark.json");
    await writeFile(file, "content");
    const denied = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const failing = { path: file, error: denied, failedAt: [] as string[] };
    swap.failing = failing;
    await expect(openRegularFile(file)).rejects.toBe(denied);
    // 주입한 열기 실패가 그 시험의 경로에서 났다.
    expect(failing.failedAt).toEqual([file]);
  });

  // 열기가 본 항목(없음·링크·폴더)과 바로 뒤 lstat이 본 일반 파일이 다르면 그 사이 자리가 바뀐 것이다. 다른 실행이 같은 자리에
  // 새 파일을 둘 때 생긴다(#279 CI macOS 간헐 실패). 열기 오류로 던지지 않고 "바뀜"으로 답해 부르는 쪽이 정한다. 다시 열어 보지 않는다.
  it.each(["ENOENT", "ELOOP", "EISDIR"])(
    "calls the place changed when the open met %s but a regular file is there right after",
    async (code) => {
      const root = await folders.make("babojubot-files-");
      const file = path.join(root, "mark.json");
      await writeFile(file, "content");
      const failing = {
        path: file,
        error: Object.assign(new Error("the place changed"), { code }),
        failedAt: [] as string[],
      };
      swap.failing = failing;
      expect(await openRegularFile(file)).toBe("changed");
      // 주입한 열기 실패가 그 시험의 경로에서 났다(다시 열어 보지 않는다).
      expect(failing.failedAt).toEqual([file]);
    }
  );

  // "없음"은 열기와 바로 뒤 lstat이 모두 없다고 본 때만이다. 열기가 권한·디스크 오류로 실패했으면 그 자리를 확인하지 못한 것이고,
  // 바로 뒤 자리가 비었어도 없다고 답하지 않는다. 처음 쓰는 조직 폴더로 보고 표식을 게시할 수 있다(#286 항목 5).
  it.each(["EACCES", "EIO"])(
    "throws the open error %s even when nothing is at the path right after",
    async (code) => {
      const root = await folders.make("babojubot-files-");
      const file = path.join(root, "mark.json");
      const failed = Object.assign(new Error("could not open"), { code });
      const failing = { path: file, error: failed, failedAt: [] as string[] };
      swap.failing = failing;
      await expect(openRegularFile(file)).rejects.toBe(failed);
      // 주입한 열기 실패가 그 시험의 경로에서 났다(다시 열어 보지 않는다).
      expect(failing.failedAt).toEqual([file]);
    }
  );

  // 열기가 링크·폴더를 만났는데 바로 뒤 자리가 비었으면 그 사이 자리가 바뀐 것이다. 없음이 아니다.
  it.each(["ELOOP", "EISDIR"])(
    "calls the place changed when the open met %s but nothing is there right after",
    async (code) => {
      const root = await folders.make("babojubot-files-");
      const file = path.join(root, "mark.json");
      const failing = {
        path: file,
        error: Object.assign(new Error("the place changed"), { code }),
        failedAt: [] as string[],
      };
      swap.failing = failing;
      expect(await openRegularFile(file)).toBe("changed");
      // 주입한 열기 실패가 그 시험의 경로에서 났다(다시 열어 보지 않는다).
      expect(failing.failedAt).toEqual([file]);
    }
  );

  // Windows는 열린 파일의 자리에 다른 파일을 옮길 수 없어 이 사이가 생기지 않는다.
  it.skipIf(process.platform === "win32")(
    "keeps the file it opened even when the path is replaced right after",
    async () => {
      const root = await folders.make("babojubot-files-");
      const file = path.join(root, "mark.json");
      await writeFile(file, "opened");
      const replacement = path.join(root, "replacement.json");
      await writeFile(replacement, "replaced");
      const swapped = armSwap({ path: file, replacement });
      expect(await opened(file)).toBe("opened");
      expect(swapped.used).toBe(true);
    }
  );
});
