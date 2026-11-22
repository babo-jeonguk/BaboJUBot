import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { testFolders } from "@babojubot/process/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openRegularFile } from "./regular-file.ts";

// Windows에는 `O_NOFOLLOW`·`O_NONBLOCK`이 없어 열기가 링크를 따라가고, 연 뒤 경로 항목이 연 파일인지 대조한다.
// 두 값을 지운 node:fs로 그 길을 POSIX에서도 돌린다. 링크를 따라가는 열기는 대상 없는 링크에서도 ENOENT로 실패하므로,
// 열기 오류만으로는 없는 경로와 그 자리의 링크를 가르지 못한다.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const constants = {
    ...real.constants,
    O_NOFOLLOW: undefined,
    O_NONBLOCK: undefined,
  };
  return { ...real, constants, default: { ...real, constants } };
});

const folders = testFolders();

/** 연 결과. 열었으면 그 handle에서 읽은 내용이고 handle은 시험 끝에 닫는다. 열지 않았으면 그 이유다. */
async function opened(file: string) {
  const result = await openRegularFile(file);
  if (typeof result === "string") return result;
  onTestFinished(() => result.handle.close());
  return await result.handle.readFile("utf8");
}

// 실제 Windows에서는 링크를 만들려면 권한이 필요하다. 그 시스템의 실제 길은 regular-file.test.ts가 링크를 만들 수 있을 때 본다.
describe.skipIf(process.platform === "win32")(
  "opening only a regular file where opening follows links, as on Windows",
  () => {
    it("opens a regular file", async () => {
      const root = await folders.make("babojubot-files-");
      const file = path.join(root, "mark.json");
      await writeFile(file, "content");
      expect(await opened(file)).toBe("content");
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

    it("calls a link to a regular file not a regular file", async () => {
      const root = await folders.make("babojubot-files-");
      const target = path.join(root, "target.json");
      await writeFile(target, "content");
      await symlink(target, path.join(root, "link.json"));
      expect(await opened(path.join(root, "link.json"))).toBe("not-regular");
    });

    it("calls a link whose target is missing not a regular file, not missing", async () => {
      const root = await folders.make("babojubot-files-");
      await symlink(
        path.join(root, "missing.json"),
        path.join(root, "link.json")
      );
      expect(await opened(path.join(root, "link.json"))).toBe("not-regular");
    });
  }
);
