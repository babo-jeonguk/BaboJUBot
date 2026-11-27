import * as fsPromises from "node:fs/promises";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { armSwap, resetSwap, swapAfter } from "./fs-swap-support.ts";
import { awaitedLater } from "./test-cleanup.ts";
import { testFolders } from "./test-folders.ts";
import { within } from "./test-support.ts";

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

// 바꾸는 호출은 handle을 남기지 않는 `readFile`로 본다. 연 handle을 쥔 채 그 경로에 다른 파일을 옮겨 넣는 것은 Windows가 거절한다(EPERM:
// 열린 파일은 지우기 공유 없이 바꿀 수 없다). 그 장면을 쓰는 시험(regular-file 둘, workspace-identity-swap)은 이유와 함께 Windows에서
// 건너뛴다.
it("swaps the armed path right after the first call on it, once", async () => {
  const { file, replacement } = await scene();
  const swapped = swapAfter(fsPromises, ["readFile"]);
  const arming = armSwap({ path: file, replacement });
  // 읽은 것은 바꾸기 전의 파일이고, 경로에는 바꾼 파일이 있다.
  expect(await swapped.readFile(file, "utf8")).toBe("opened");
  expect(arming.used).toBe(true);
  expect(await readFile(file, "utf8")).toBe("replaced");
  // 두 번째 호출은 바꾸지 않는다(옮길 파일이 이미 없지만 실패하지 않는다).
  expect(await swapped.readFile(file, "utf8")).toBe("replaced");
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
      // 열기를 시작 순간 정리에 맡긴다. 대역이 닫지 못하거나 바꾸기가 뜻밖에 성공해도 시험이 끝날 때, 열기의 끝을 확인한 뒤 연 handle을
      // 닫는다(이미 닫힌 handle의 close는 이행한다. 열기가 실패했으면 닫을 것이 없다).
      const opening = open(...args);
      folders.own(async () => {
        const [opened] = await Promise.allSettled([opening]);
        if (opened.status === "fulfilled") await opened.value.close();
      }, "the handle the swap should close");
      const handle = await opening;
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

// 호출이 도는 사이 시험이 무장을 풀고(reset) 같은 경로에 새로 무장해도, 그 호출은 불린 순간 찾은 무장만 쓴다. 진짜 `readFile`을
// 붙잡는 의존성을 넘겨 호출 도중의 순간을 만든다(시간 대기·폴링 없이 붙잡기를 시험이 푼다).
it("uses the arming it found when called, even after a reset and a new arming while the call runs", async () => {
  const { root, file, replacement } = await scene();
  const later = path.join(root, "later.json");
  await writeFile(later, "armed later");
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = {
    rename: fsPromises.rename,
    readFile: async (...args: Parameters<typeof readFile>) => {
      reached.resolve();
      await release.promise;
      return readFile(...args);
    },
  };
  const swapped = swapAfter(held, ["readFile"]);
  const first = armSwap({ path: file, replacement });
  const reading = awaitedLater(swapped.readFile(file, "utf8"));
  await within(reached.promise, 5_000, "the held read did not start");
  resetSwap();
  const second = armSwap({ path: file, replacement: later });
  release.resolve();
  expect(await within(reading, 5_000, "the held read did not end")).toBe(
    "opened"
  );
  expect(first.used).toBe(true);
  expect(second.used).toBe(false);
  expect(await readFile(file, "utf8")).toBe("replaced");
  expect(await readFile(later, "utf8")).toBe("armed later");
});

// 바꾸기도 실패하고 연 것의 닫기도 실패하면, 바꾸기의 실패를 첫 원인으로 닫기의 실패를 그 뒤에 함께 던진다(어느 것도 버리지 않는다).
// 진짜 handle의 닫기를 실패시킬 안전한 길이 없어(바탕 번호를 먼저 닫으면 그 번호가 다른 파일에 다시 쓰일 수 있다) 닫기가 실패하는
// handle을 돌려주는 의존성을 넘긴다.
it("throws the swap's failure first and the close failure after it when both fail", async () => {
  const { root, file } = await scene();
  const closeFailure = Object.assign(new Error("close failed"), {
    code: "EIO",
  });
  const opened: unknown[] = [];
  const failing = {
    rename: fsPromises.rename,
    open: async (target: string) => {
      opened.push(target);
      return {
        close: async () => {
          throw closeFailure;
        },
      };
    },
  };
  const swapped = swapAfter(failing, ["open"]);
  // 옮길 파일이 없어 바꾸기가 ENOENT로 실패한다.
  armSwap({ path: file, replacement: path.join(root, "missing.json") });
  const failure = await swapped.open(file).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(opened).toEqual([file]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    errors: [{ code: "ENOENT", syscall: "rename" }, closeFailure],
  });
});
