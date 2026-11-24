import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasErrorCode } from "@babojubot/contracts";
import { testFolders } from "@babojubot/process/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { inFolder, openRegularFile } from "./index.ts";

const folders = testFolders();
const windows = process.platform === "win32";

/** `root/parts…` 폴더를 만들고 그 안에 `name` 파일을 둔다. */
async function placed(parts: string[], name: string, content: string) {
  const root = await folders.make("babojubot-folder-");
  await mkdir(path.join(root, ...parts), { recursive: true });
  await writeFile(path.join(root, ...parts, name), content);
  return root;
}

/** 확인한 폴더 안의 이름을 `openRegularFile`로 열어 내용이나 열지 않은 이유를 돌려준다. */
async function openedIn(root: string, parts: string[], name: string) {
  return inFolder(root, parts, async (folder) => {
    const result = await openRegularFile(folder.at(name));
    if (typeof result === "string") return result;
    onTestFinished(() => result.handle.close());
    return await result.handle.readFile("utf8");
  });
}

// 다른 쪽(격리 실행의 컨테이너)이 쓸 수 있는 폴더 안으로 한 칸씩 확인하며 들어가, 확인한 폴더 안의 이름만 연다(#278).
describe("reaching a name inside folders others can change", () => {
  it("reaches a nested folder and opens a file in it", async () => {
    const root = await placed(["data", "store"], "file.db", "content");
    expect(await openedIn(root, ["data", "store"], "file.db")).toEqual({
      state: "reached",
      value: "content",
    });
  });

  it("calls a missing folder on the way absent without using it", async () => {
    const root = await folders.make("babojubot-folder-");
    let used = false;
    expect(
      await inFolder(root, ["data", "store"], async () => {
        used = true;
      })
    ).toEqual({ state: "absent" });
    expect(used).toBe(false);
    expect(
      await inFolder(path.join(root, "missing"), [], async () => undefined)
    ).toEqual({ state: "absent" });
  });

  it("calls a file in place of a folder unverifiable, not absent", async () => {
    const root = await folders.make("babojubot-folder-");
    await writeFile(path.join(root, "data"), "a file");
    expect(await inFolder(root, ["data"], async () => undefined)).toEqual({
      state: "unverifiable",
      found: "not_folder",
    });
  });

  it("makes the missing folders on the way when asked to", async () => {
    const root = await folders.make("babojubot-folder-");
    const reached = await inFolder(
      root,
      ["login", "nested"],
      async (folder) => {
        await writeFile(folder.at("token"), "placed", { flag: "wx" });
      },
      { create: true }
    );
    expect(reached).toEqual({ state: "reached", value: undefined });
    expect(
      await readFile(path.join(root, "login", "nested", "token"), "utf8")
    ).toBe("placed");
  });

  it("refuses a step that is not one name", async () => {
    const root = await folders.make("babojubot-folder-");
    for (const step of ["", ".", "..", path.join("a", "b"), "a/b"])
      await expect(
        inFolder(root, [step], async () => undefined),
        JSON.stringify(step)
      ).rejects.toThrow(/one name/);
    await expect(
      inFolder(root, [], async (folder) => folder.at(".."))
    ).rejects.toThrow(/one name/);
  });

  // 폴더 자리의 링크는 모든 시스템에서 본다. Windows의 폴더 링크(junction)는 권한 없이 만들 수 있고, 그 시스템에서 다른 쪽이
  // 폴더를 바꿔 두는 모양이다. 다른 시스템은 `"junction"`을 무시하고 폴더를 가리키는 링크를 만든다(Node `fs.symlink`). junction의
  // 대상은 절대 경로여야 한다.
  it("calls a link in place of a folder unverifiable without following it", async () => {
    const root = await placed(["elsewhere"], "file.db", "elsewhere");
    await symlink(
      path.join(root, "elsewhere"),
      path.join(root, "data"),
      "junction"
    );
    expect(await openedIn(root, ["data"], "file.db")).toEqual({
      state: "unverifiable",
      found: "link",
    });
  });

  // Windows에는 FIFO가 없고, 파일 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하다. FIFO·파일 링크 경우는 POSIX에서 본다.

  // FIFO 자리를 폴더로 열 때 쓰는 쪽을 기다리지 않고, 없는 것이 아니라 확인할 수 없는 것으로 답한다(#280 리뷰 1회차 STD-1).
  it.skipIf(windows)(
    "calls a FIFO in place of a folder unverifiable without waiting",
    { timeout: 10_000 },
    async () => {
      const root = await folders.make("babojubot-folder-");
      execFileSync("mkfifo", [path.join(root, "data")], { timeout: 10_000 });
      expect(await inFolder(root, ["data"], async () => undefined)).toEqual({
        state: "unverifiable",
        found: "not_folder",
      });
    }
  );

  it.skipIf(windows)(
    "does not open a link or a FIFO as the name inside the folder",
    { timeout: 10_000 },
    async () => {
      const root = await placed(["data"], "target.db", "target");
      await symlink(
        path.join(root, "data", "target.db"),
        path.join(root, "data", "link.db")
      );
      const fifo = path.join(root, "data", "fifo.db");
      execFileSync("mkfifo", [fifo], { timeout: 10_000 });
      // 열기가 멈춰 있으면 쓰는 쪽으로 한 번 열어 풀어 준다. 읽는 쪽이 없으면(이미 끝남) ENXIO다.
      folders.own(async () => {
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch (error) {
          if (!hasErrorCode("ENXIO")(error)) throw error;
        }
      }, "fifo writer");
      expect(await openedIn(root, ["data"], "link.db")).toEqual({
        state: "reached",
        value: "not-regular",
      });
      expect(await openedIn(root, ["data"], "fifo.db")).toEqual({
        state: "reached",
        value: "not-regular",
      });
    }
  );

  // Linux에서는 확인한 폴더의 handle을 거쳐 열므로, 들어간 뒤 그 폴더가 옮겨지고 그 자리가 다른 곳을 가리키는 링크로 바뀌어도
  // 원래 폴더 안을 연다. 격리 실행(Docker)은 Linux에서만 돌아 그 밖의 시스템에는 이 사이에 바꾸는 쪽이 없다.
  it.skipIf(process.platform !== "linux")(
    "keeps the folder it reached when the path is swapped for a link right after",
    async () => {
      const root = await placed(["data"], "file.db", "reached");
      await mkdir(path.join(root, "other"));
      await writeFile(path.join(root, "other", "file.db"), "other");
      expect(
        await inFolder(root, ["data"], async (folder) => {
          await rename(path.join(root, "data"), path.join(root, "moved"));
          await symlink(path.join(root, "other"), path.join(root, "data"));
          return readFile(folder.at("file.db"), "utf8");
        })
      ).toEqual({ state: "reached", value: "reached" });
    }
  );
});
