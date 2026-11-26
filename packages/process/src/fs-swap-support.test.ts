import * as fsPromises from "node:fs/promises";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { armSwap, resetSwap, swapAfter } from "./fs-swap-support.ts";
import { testFolders } from "./test-folders.ts";

// 공용 바꿔치기 대역(`@babojubot/process/fs-swap`)을 진짜 파일 시스템 위에서 본다. 시험 파일의 vi.mock factory는 진짜 모듈을 넘기므로
// 여기서도 진짜 모듈을 넘긴다.
const folders = testFolders();
afterEach(() => {
  resetSwap();
});

async function scene() {
  const root = await folders.make("babojubot-fs-swap-");
  const file = path.join(root, "mark.json");
  const replacement = path.join(root, "replacement.json");
  await writeFile(file, "opened");
  await writeFile(replacement, "replaced");
  return { root, file, replacement };
}

it("swaps the armed path right after the first call on it, once", async () => {
  const { file, replacement } = await scene();
  const swapped = swapAfter(fsPromises, ["open"]);
  const arming = armSwap({ path: file, replacement });
  const handle = await swapped.open(file);
  folders.own(() => handle.close(), "the opened mark");
  // 연 것은 바꾸기 전의 파일이고, 경로에는 바꾼 파일이 있다.
  expect(await handle.readFile("utf8")).toBe("opened");
  expect(arming.used).toBe(true);
  expect(await readFile(file, "utf8")).toBe("replaced");
  // 두 번째 호출은 바꾸지 않는다(옮길 파일이 이미 없지만 실패하지 않는다).
  const again = await swapped.open(file);
  folders.own(() => again.close(), "the mark opened again");
  expect(await readFile(file, "utf8")).toBe("replaced");
});

it("leaves a path that is not armed as the real call does", async () => {
  const { file, replacement } = await scene();
  const swapped = swapAfter(fsPromises, ["readFile"]);
  const arming = armSwap({ path: replacement, replacement: file });
  expect(await swapped.readFile(file, "utf8")).toBe("opened");
  expect(arming.used).toBe(false);
  expect(await readFile(replacement, "utf8")).toBe("replaced");
});

it("refuses to arm the same path twice", async () => {
  const { file, replacement } = await scene();
  armSwap({ path: file, replacement });
  expect(() => armSwap({ path: file, replacement })).toThrow(
    `${file} is already armed to swap`
  );
});

it("closes what open returned and throws the swap's failure when the swap fails", async () => {
  const { root, file } = await scene();
  const handles: fsPromises.FileHandle[] = [];
  const recording = {
    ...fsPromises,
    open: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    },
  };
  const swapped = swapAfter(recording, ["open"]);
  // 옮길 파일이 없어 바꾸기가 ENOENT로 실패한다.
  armSwap({ path: file, replacement: path.join(root, "missing.json") });
  await expect(swapped.open(file)).rejects.toMatchObject({
    code: "ENOENT",
    syscall: "rename",
  });
  expect(handles).toHaveLength(1);
  // 닫힌 handle의 조회는 EBADF로 거절된다.
  for (const handle of handles)
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});
