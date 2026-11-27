import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { testFolders } from "@babojubot/process/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmFailed, removeConfirmed } from "./remove-confirmed.ts";

// 링크를 만들 수 없는 디스크(#209)를 흉내 낸다. 결함이 있으면 정확히 그 경로(`at`, 그 시험 폴더의 파일)로 hard link를 만들 때 그
// 코드의 오류로 실패하고, 실패시킨 경로를 `failedAt`에 남긴다. 다른 경로의 link는 그대로 한다(#286).
type LinkFault = { at: string; code: string; failedAt: string[] };
const disk = vi.hoisted(() => ({
  linkFails: undefined as LinkFault | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const link: typeof real.link = async (existing, target) => {
    const fault = disk.linkFails;
    if (fault?.at === String(target)) {
      fault.failedAt.push(String(target));
      throw Object.assign(new Error("cannot link"), { code: fault.code });
    }
    return real.link(existing, target);
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

  // 확인하지 못한 파일을 한 번에 되돌릴 수 없으면 옮긴 이름에 그대로 두고 그 이름을 알린다. 그 이름이 차지됐으면 새 파일을 바꾸지
  // 않고, 링크를 만들 수 없는 디스크에서는 옮긴 이름을 다시 열어 복사하지 않는다(그사이 놓인 다른 것을 제자리에 둘 수 있다, #286
  // 병합분 항목 12). 확인이 "아님"이든 확인이 실패했든 남긴 이름(같은 폴더 안의 파일 이름)이 부른 쪽에 닿는다. 확인이 실패하면 그
  // 실패와 남긴 이름을 함께 던진다(#296 외부 리뷰 1회차 STD-1·SPEC-2).
  const takeName = async (root: string, file: string) => {
    await writeFile(path.join(root, "saving"), "second save");
    await rename(path.join(root, "saving"), file);
  };
  const kept =
    /^\.config\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removing$/;
  const failure = Object.assign(new Error("could not read"), { code: "EIO" });
  /** 확인이 실패했을 때 던진 것. 이행하면 그 자체로 실패이고, 거절 값은 그 실패와 남긴 결과를 담은 `ConfirmFailed`여야 한다. */
  const confirmFailure = async (attempt: Promise<unknown>) => {
    const failed = await attempt.then(
      (result) => {
        throw new Error(
          `expected a confirm failure, but it fulfilled with ${JSON.stringify(result)}`
        );
      },
      (error: unknown) => error
    );
    if (!(failed instanceof ConfirmFailed))
      throw new Error(`expected a confirm failure, got ${String(failed)}`);
    return failed;
  };
  it.each([
    ["another file took the name", undefined, true],
    ["the disk cannot link (EPERM)", "EPERM", false],
    ["the disk cannot link (ENOTSUP)", "ENOTSUP", false],
    ["the disk cannot link (EOPNOTSUPP)", "EOPNOTSUPP", false],
  ] as const)(
    "keeps a file it does not confirm under its moved name and names it when %s",
    async (_case, linkFails, taken) => {
      const root = await folders.make("babojubot-remove-");
      const file = path.join(root, "config.json");
      await writeFile(file, "first save");
      const fault: LinkFault | undefined = linkFails
        ? { at: file, code: linkFails, failedAt: [] }
        : undefined;
      disk.linkFails = fault;
      const result = await removeConfirmed(file, async () => {
        if (taken) await takeName(root, file);
        return false;
      });
      if (typeof result !== "object")
        throw new Error(`expected the moved file to be kept, got ${result}`);
      expect(result).toEqual({ keptAs: expect.stringMatching(kept) });
      expect(await readFile(path.join(root, result.keptAs), "utf8")).toBe(
        "first save"
      );
      expect((await readdir(root)).sort()).toEqual(
        (taken ? ["config.json", result.keptAs] : [result.keptAs]).sort()
      );
      expect(fault?.failedAt).toEqual(linkFails ? [file] : undefined);
    }
  );

  it.each([
    ["another file took the name", undefined, true],
    ["the disk cannot link (EPERM)", "EPERM", false],
  ] as const)(
    "throws the confirmation's failure together with the moved name it kept when %s",
    async (_case, linkFails, taken) => {
      const root = await folders.make("babojubot-remove-");
      const file = path.join(root, "config.json");
      await writeFile(file, "first save");
      const fault: LinkFault | undefined = linkFails
        ? { at: file, code: linkFails, failedAt: [] }
        : undefined;
      disk.linkFails = fault;
      const failed = await confirmFailure(
        removeConfirmed(file, async () => {
          if (taken) await takeName(root, file);
          throw failure;
        })
      );
      expect(failed.cause).toBe(failure);
      expect(failed.kept).toEqual({ keptAs: expect.stringMatching(kept) });
      if (typeof failed.kept !== "object")
        throw new Error("expected the moved file to be kept");
      expect(await readFile(path.join(root, failed.kept.keptAs), "utf8")).toBe(
        "first save"
      );
      expect(fault?.failedAt).toEqual(linkFails ? [file] : undefined);
    }
  );

  // 확인이 실패하면 확인하지 못한 것이다. 지우지 않고 되돌린 뒤 그 실패를 되돌렸다는 결과와 함께 던진다.
  it("puts the file back and throws when the confirmation fails", async () => {
    const root = await folders.make("babojubot-remove-");
    const file = path.join(root, "config.json");
    await writeFile(file, "unknown");
    const failed = await confirmFailure(
      removeConfirmed(file, async () => {
        throw failure;
      })
    );
    expect(failed.cause).toBe(failure);
    expect(failed.kept).toBe("restored");
    expect(await readFile(file, "utf8")).toBe("unknown");
    expect(await readdir(root)).toEqual(["config.json"]);
  });
});
