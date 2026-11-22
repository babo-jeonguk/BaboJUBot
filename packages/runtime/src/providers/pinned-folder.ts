import { constants } from "node:fs";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts";

/** 칸을 따라 내려가지 못한 이유. 없음, 링크, 폴더가 아님(파일·FIFO 등). */
export type FolderMiss = "missing" | "link" | "not_folder";
export type InFolder<T> =
  { reached: true; value: T } | { reached: false; miss: FolderMiss };
/** 확인한 폴더 안의 이름을 여는 데 쓸 경로. 이 경로는 그 폴더 handle을 거치므로 중간 칸이 바뀌어도 같은 폴더를 가리킨다. */
export type Folder = { path: string; at(name: string): string };

/**
 * 조직 폴더처럼 격리 실행의 컨테이너가 쓸 수 있는 폴더 안으로 한 칸씩 들어가, 확인한 폴더의 handle을 거쳐 그 안의 이름을 연다.
 * Node에는 openat이 없어 경로를 확인한 뒤 다시 열면 그 사이에 중간 칸이 링크로 바뀌어 다른 곳을 열 수 있다. 경로를 고정해 읽는
 * 선례(apps/server/src/workspace.ts와 antigravity-config.ts가 고정한 자식 프로세스로 하는 일)를, 여기서는 폴더 handle의
 * `/proc/self/fd/<fd>/<이름>` 경로로 이 프로세스 안에서 한다. Linux에서는 fd가 연 폴더 자체를 붙들므로, 그 폴더를 옮기고 다른
 * 폴더로 바꿔도 경로는 원래 폴더를 가리킨다. 그 밖의 시스템은 격리 실행을 하지 않으므로(docs/providers.md), 경로를 따라가며
 * `lstat`으로 확인하는 지금과 같은 보장만 한다.
 *
 * 부르는 쪽은 돌려받은 `Folder.at(이름)`으로 마지막 이름을 열 때 `O_NOFOLLOW | O_NONBLOCK`을 써야 한다(링크를 따라가지 않고
 * FIFO에서 기다리지 않는다). 이름 자체에 작용하는 `lstat`·`readlink`·`rm`·`writeFile`(flag `"wx"`)은 그대로 써도 된다. 한 칸이라도
 * 폴더가 아니면 `use`를 부르지 않고 없음·링크·폴더 아님을 돌려준다. 모든 이름은 경로 칸 하나여야 한다.
 */
export async function inFolder<T>(
  root: string,
  parts: readonly string[],
  use: (folder: Folder) => Promise<T>,
  options: { create?: boolean } = {}
): Promise<InFolder<T>> {
  for (const part of parts) checkStep(part);
  return process.platform === "linux"
    ? inFolderLinux(root, parts, use, options)
    : inFolderByPath(root, parts, use, options);
}

/** 이름 하나가 경로 칸 하나인가. 아니면 경로를 글자로 해석해 다른 곳으로 새지 않게 던진다. */
function checkStep(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes(path.sep)
  )
    throw new Error("a folder step must be one name");
}

/** 링크를 따라가지 않고 폴더만 여는 flag. 열 때부터 링크·파일을 거절한다. */
const folderFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** 확인한 폴더 안의 파일 하나를 여는 flag. 링크를 거절하고 FIFO에서 기다리지 않는다. */
const fileFlags =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/** `openFileIn`이 연 일반 파일: handle과 연 때의 크기. 부르는 쪽이 handle을 닫는다. */
export type OpenedFile = { handle: FileHandle; size: number };
/** 확인한 폴더 안의 이름 하나를 연다. 링크를 따라가지 않고(O_NOFOLLOW) FIFO에서 기다리지 않는다(O_NONBLOCK). 열린 것이 일반 파일일 때만 그 handle과 크기를 돌려주고, 없음·링크·일반 파일 아님은 값으로 가른다. 그 밖의 열기·확인 오류는 던진다. */
export async function openFileIn(
  folder: Folder,
  name: string
): Promise<OpenedFile | "missing" | "link" | "not_regular"> {
  let handle: FileHandle;
  try {
    handle = await open(folder.at(name), fileFlags);
  } catch (error) {
    if (hasErrorCode("ENOENT", "ENOTDIR")(error)) return "missing";
    if (hasErrorCode("ELOOP")(error)) return "link";
    if (hasErrorCode("EISDIR")(error)) return "not_regular";
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await closeHandles([handle]);
      return "not_regular";
    }
    return { handle, size: info.size };
  } catch (error) {
    await closeHandles([handle]);
    throw error;
  }
}

/** Linux: 연 폴더 handle의 /proc/self/fd 경로로 한 칸씩 내려간다. 확인한 폴더를 옮기거나 바꿔도 같은 폴더를 가리킨다. */
async function inFolderLinux<T>(
  root: string,
  parts: readonly string[],
  use: (folder: Folder) => Promise<T>,
  options: { create?: boolean }
): Promise<InFolder<T>> {
  const handles: FileHandle[] = [];
  try {
    const first = await orIfMissing(
      () => open(root, folderFlags),
      hasErrorCode("ENOENT"),
      undefined
    );
    if (first === undefined) return { reached: false, miss: "missing" };
    handles.push(first);
    try {
      // /proc이 없으면 없는 경로가 "없음"으로 읽혀 확인을 통과할 수 있다. handle을 거치는 길이 있는지 먼저 본다.
      await stat(`/proc/self/fd/${first.fd}`);
    } catch (cause) {
      throw new Error(
        "the folder handle cannot be reached through /proc/self/fd",
        { cause }
      );
    }
    let current = first;
    for (const part of parts) {
      const next = `/proc/self/fd/${current.fd}/${part}`;
      if (options.create) {
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (error) {
          // 이미 있으면 아래 열기가 폴더인지 본다.
          if (!hasErrorCode("EEXIST")(error)) throw error;
        }
      }
      let opened: FileHandle;
      try {
        opened = await open(next, folderFlags);
      } catch (error) {
        if (hasErrorCode("ENOENT")(error))
          return { reached: false, miss: "missing" };
        if (hasErrorCode("ENOTDIR", "ELOOP")(error))
          return { reached: false, miss: await missAt(next) };
        throw error;
      }
      handles.push(opened);
      current = opened;
    }
    const last = current;
    const folder: Folder = {
      path: `/proc/self/fd/${last.fd}`,
      at(name) {
        checkStep(name);
        return `/proc/self/fd/${last.fd}/${name}`;
      },
    };
    return { reached: true, value: await use(folder) };
  } finally {
    await closeHandles(handles);
  }
}

/** 열지 못한 칸이 링크인지 폴더가 아닌지 이름 자체로 가른다. 그 사이 사라졌으면 없음이다. */
async function missAt(at: string): Promise<FolderMiss> {
  const found = await orIfMissing(
    () => lstat(at),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (!found) return "missing";
  return found.isSymbolicLink() ? "link" : "not_folder";
}

/** 다른 시스템: 경로를 따라가며 각 칸을 확인한다. 격리 실행이 없어 확인과 사용 사이의 바꿔치기는 지금과 같이 막지 못한다. */
async function inFolderByPath<T>(
  root: string,
  parts: readonly string[],
  use: (folder: Folder) => Promise<T>,
  options: { create?: boolean }
): Promise<InFolder<T>> {
  const rootMiss = await folderMissAt(root);
  if (rootMiss) return { reached: false, miss: rootMiss };
  let at = root;
  for (const part of parts) {
    at = path.join(at, part);
    if (options.create) {
      try {
        await mkdir(at, { mode: 0o700 });
      } catch (error) {
        // 이미 있으면 아래 확인이 폴더인지 본다.
        if (!hasErrorCode("EEXIST")(error)) throw error;
      }
    }
    const miss = await folderMissAt(at);
    if (miss) return { reached: false, miss };
  }
  const folder: Folder = {
    path: at,
    at(name) {
      checkStep(name);
      return path.join(at, name);
    },
  };
  return { reached: true, value: await use(folder) };
}

/** 경로 하나가 폴더인가. 없음(상위가 파일인 것 포함)·링크·폴더 아님을 돌려주고, 그 밖의 오류는 던진다. */
async function folderMissAt(at: string): Promise<FolderMiss | undefined> {
  const found = await orIfMissing(
    () => lstat(at),
    hasErrorCode("ENOENT", "ENOTDIR"),
    undefined
  );
  if (!found) return "missing";
  if (found.isSymbolicLink()) return "link";
  if (!found.isDirectory()) return "not_folder";
  return undefined;
}

/** 연 폴더 handle을 모두 닫는다. 하나를 닫지 못해도 나머지를 닫고, 실패는 원인과 함께 남긴다. */
async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  await Promise.all(
    handles.map((handle) =>
      continueAfterFailure(
        () => handle.close(),
        (error) =>
          console.warn(
            `[provider] a folder handle could not be closed (${failureCode(error)})`
          )
      )
    )
  );
}
