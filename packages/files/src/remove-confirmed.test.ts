import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { testFolders } from "@babojubot/process/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeConfirmed } from "./remove-confirmed.ts";

// 링크를 만들 수 없는 디스크(#209)를 흉내 낸다. 이 코드가 있으면 hard link 만들기가 그 오류로 실패한다.
const disk = vi.hoisted(() => ({ linkFails: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const link: typeof real.link = async (...args) => {
    if (disk.linkFails)
      throw Object.assign(new Error("cannot link"), { code: disk.linkFails });
    return real.link(...args);
  };
  return { ...real, link, default: { ...real, link } };
});
afterEach(() => {
  disk.linkFails = undefined;
});

// 다른 쪽이 같은 이름에 새 파일을 둘 수 있는 자리에서, 확인한 파일만 지운다. 확인한 뒤 이름으로 지우면 그 사이 같은 이름에 둔
// 다른 파일을 지운다(#286 항목 8). 그래서 먼저 그 이름의 파일을 이 호출만 아는 이름으로 옮기고(이름 바꾸기는 한 번에 일어난다),
// 옮긴 파일을 확인해 맞을 때만 지운다. 아니면 원래 이름에 있던 것을 바꾸지 않고 되돌린다.
const folders = testFolders();

describe("removing a file in a place others can change, only the one confirmed", () => {
  it("removes the file when the confirmation of the moved file says so", async () => {
    const root = await folders.make("babojubot-remove-");
    const file = path.join(root, "config.json");
    await writeFile(file, "ours");
    const seen: string[] = [];
    const result = await removeConfirmed(file, async (moved) => {
      seen.push(await readFile(moved, "utf8"));
      expect(path.dirname(moved)).toBe(root);
      expect(moved).not.toBe(file);
      return true;
    });
    expect(result).toBe("removed");
    expect(seen).toEqual(["ours"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("answers missing when nothing is at the name", async () => {
    const root = await folders.make("babojubot-remove-");
    let asked = false;
    const result = await removeConfirmed(
      path.join(root, "config.json"),
      async () => {
        asked = true;
        return true;
      }
    );
    expect(result).toBe("missing");
    expect(asked).toBe(false);
  });

  // 확인 전에 같은 이름에 다른 파일이 저장됐으면, 옮긴 것은 그 다른 파일이다. 지우지 않고 그 이름으로 되돌린다.
  it("puts a file it does not confirm back under its name, leaving nothing else behind", async () => {
    const root = await folders.make("babojubot-remove-");
    const file = path.join(root, "config.json");
    await writeFile(file, "someone else's");
    const result = await removeConfirmed(file, async () => false);
    expect(result).toBe("restored");
    expect(await readFile(file, "utf8")).toBe("someone else's");
    expect(await readdir(root)).toEqual(["config.json"]);
  });

  // 링크를 만들 수 없는 디스크에서도 확인하지 못한 파일을 제자리에 되돌린다. 그 이름에 아무것도 없을 때만 만드는 복사로 되돌리므로
  // 그사이 생긴 새 파일은 바꾸지 않는다. 숨은 이름으로 남기면 사용자 설정이 제자리에서 사라진다(#286).
  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP"])(
    "puts a file it does not confirm back under its name on a disk that cannot link (%s)",
    async (code) => {
      const root = await folders.make("babojubot-remove-");
      const file = path.join(root, "config.json");
      await writeFile(file, "someone else's");
      disk.linkFails = code;
      const result = await removeConfirmed(file, async () => false);
      expect(result).toBe("restored");
      expect(await readFile(file, "utf8")).toBe("someone else's");
      expect(await readdir(root)).toEqual(["config.json"]);
    }
  );

  it("keeps a file it does not confirm under its moved name on a disk that cannot link, when another file took the name meanwhile", async () => {
    const root = await folders.make("babojubot-remove-");
    const file = path.join(root, "config.json");
    await writeFile(file, "first save");
    disk.linkFails = "EPERM";
    const result = await removeConfirmed(file, async () => {
      await writeFile(path.join(root, "saving"), "second save");
      await rename(path.join(root, "saving"), file);
      return false;
    });
    if (typeof result !== "object")
      throw new Error(`expected the moved file to be kept, got ${result}`);
    expect(await readFile(file, "utf8")).toBe("second save");
    // 옮긴 이름은 같은 폴더의 `.<이름>.<UUID>.removing`이다(UUID만 무작위).
    expect(path.relative(root, result.keptAs)).toMatch(
      /^\.config\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removing$/
    );
    expect(await readFile(result.keptAs, "utf8")).toBe("first save");
  });

  // 되돌리는 사이 그 이름에 또 새 파일이 저장됐으면 그 새 파일을 바꾸지 않는다. 옮긴 파일은 지우지 않고 그 이름으로 남겨 알린다.
  it("keeps a file it does not confirm under its moved name when another file took the name meanwhile", async () => {
    const root = await folders.make("babojubot-remove-");
    const file = path.join(root, "config.json");
    await writeFile(file, "first save");
    const result = await removeConfirmed(file, async () => {
      await writeFile(path.join(root, "saving"), "second save");
      await rename(path.join(root, "saving"), file);
      return false;
    });
    if (typeof result !== "object")
      throw new Error(`expected the moved file to be kept, got ${result}`);
    expect(await readFile(file, "utf8")).toBe("second save");
    // 옮긴 이름은 같은 폴더의 `.<이름>.<UUID>.removing`이다(UUID만 무작위).
    expect(path.relative(root, result.keptAs)).toMatch(
      /^\.config\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removing$/
    );
    expect(await readFile(result.keptAs, "utf8")).toBe("first save");
    expect((await readdir(root)).sort()).toEqual(
      ["config.json", path.basename(result.keptAs)].sort()
    );
  });

  // 확인이 실패하면 확인하지 못한 것이다. 지우지 않고 되돌린 뒤 그 실패를 던진다.
  it("puts the file back and throws when the confirmation fails", async () => {
    const root = await folders.make("babojubot-remove-");
    const file = path.join(root, "config.json");
    await writeFile(file, "unknown");
    const failure = Object.assign(new Error("could not read"), {
      code: "EIO",
    });
    await expect(
      removeConfirmed(file, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(await readFile(file, "utf8")).toBe("unknown");
    expect(await readdir(root)).toEqual(["config.json"]);
  });
});
