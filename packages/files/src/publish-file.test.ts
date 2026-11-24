import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileLinks } from "@babojubot/process/test-support";
import { testFolders } from "@babojubot/process/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishFile } from "./index.ts";

// 쓰기·이름 바꾸기·지우기를 원하는 오류로 실패시킨다. 쓰기 실패는 임시 파일을 만든 뒤에 낸다(디스크가 찬 경우처럼).
const failing = vi.hoisted(() => ({
  writeAfterCreate: undefined as Error | undefined,
  rename: undefined as Error | undefined,
  rm: undefined as Error | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof real.writeFile = async (file, data, options) => {
    if (failing.writeAfterCreate) {
      await real.writeFile(file, "", options);
      throw failing.writeAfterCreate;
    }
    return real.writeFile(file, data, options);
  };
  const rename: typeof real.rename = async (...args) => {
    if (failing.rename) throw failing.rename;
    return real.rename(...args);
  };
  const rm: typeof real.rm = async (...args) => {
    if (failing.rm) throw failing.rm;
    return real.rm(...args);
  };
  const patched = { writeFile, rename, rm };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

const folders = testFolders();
afterEach(() => {
  failing.writeAfterCreate = undefined;
  failing.rename = undefined;
  failing.rm = undefined;
  vi.restoreAllMocks();
});
const code = (value: string) =>
  Object.assign(new Error(`failed with ${value}`), { code: value });

// 다른 쪽이 읽는 자리의 파일을 한 번에 바꾼다. 읽는 쪽은 이전 것이나 완성된 내용만 보고, 실패하면 임시 파일을 남기지 않는다(#280 리뷰 2회차 STD-2).
describe("publishing a file in one step", () => {
  it("places the complete content and leaves no temporary file", async () => {
    const root = await folders.make("babojubot-publish-");
    const file = path.join(root, "token");
    await publishFile(file, "first", { mode: 0o600 });
    await publishFile(file, "second", { mode: 0o600 });
    expect(await readFile(file, "utf8")).toBe("second");
    expect(await readdir(root)).toEqual(["token"]);
  });

  // 링크를 만들 권한이 없는 Windows에서는 이유와 함께 건너뛴다. CI는 필수로 정한다(`fileLinks`, #286 항목 16).
  it.skipIf(!fileLinks())(
    "replaces a link at the place without following it",
    async () => {
      const root = await folders.make("babojubot-publish-");
      await mkdir(path.join(root, "elsewhere"));
      const target = path.join(root, "elsewhere", "token");
      await writeFile(target, "elsewhere");
      await symlink(target, path.join(root, "token"));
      await publishFile(path.join(root, "token"), "placed", { mode: 0o600 });
      expect(await readFile(target, "utf8")).toBe("elsewhere");
      expect(await readFile(path.join(root, "token"), "utf8")).toBe("placed");
    }
  );

  it("removes the temporary file when the write fails after creating it, and throws that failure", async () => {
    const root = await folders.make("babojubot-publish-");
    const full = code("ENOSPC");
    failing.writeAfterCreate = full;
    await expect(
      publishFile(path.join(root, "token"), "placed", { mode: 0o600 })
    ).rejects.toBe(full);
    expect(await readdir(root)).toEqual([]);
  });

  it("throws the rename failure, not the removal failure, when both fail", async () => {
    const root = await folders.make("babojubot-publish-");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const busy = code("EBUSY");
    failing.rename = busy;
    failing.rm = code("EIO");
    await expect(
      publishFile(path.join(root, "token"), "placed", { mode: 0o600 })
    ).rejects.toBe(busy);
    // 지우지 못한 것은 원인과 함께 남긴다.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EIO"));
  });
});
