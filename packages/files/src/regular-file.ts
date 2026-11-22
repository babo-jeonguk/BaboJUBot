import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  continueAfterFailure,
  failureCode,
} from "@babojubot/contracts/failure";

/** 열고 확인한 일반 파일. 부른 쪽이 `handle`을 닫는다. `info`는 그 handle의 종류·크기다. */
export type OpenedRegularFile = { handle: FileHandle; info: BigIntStats };
/** 열지 않은 이유: 경로에 아무것도 없음, 또는 그 자리가 일반 파일이 아님(링크·폴더·FIFO 같은 특수 파일). */
export type NotOpened = "missing" | "not-regular";
/** 파일 식별(장치·inode). 같은 두 값이면 같은 파일 시스템 항목이다. */
export type EntryIdentity = { dev: bigint; ino: bigint };

/** 두 항목이 같은 파일인가. 경로로 본 항목(`lstat`)과 연 것(handle의 `stat`)을 대조할 때 쓴다. */
export const sameEntry = (a: EntryIdentity, b: EntryIdentity) =>
  a.dev === b.dev && a.ino === b.ino;

/**
 * 다른 쪽이 바꿀 수 있는 자리의 파일을 확인한 대상 그대로 연다(#242, CWE-367). 종류·크기는 돌려준 handle의 것이므로, 연 뒤
 * 그 경로에 다른 것이 들어와도 확인한 파일의 내용을 읽는다.
 * POSIX에서는 `O_NOFOLLOW`로 링크를 열 때부터 거절하고, `O_NONBLOCK`으로 FIFO를 기다리지 않는다. Windows에는 두 값이 없어
 * 링크를 따라 연 뒤, 경로 항목(`lstat`)이 연 파일 자신(dev·ino)인지 대조해 링크를 거절한다.
 * 열지 못하면 열기 오류 코드로 짐작하지 않고 링크를 따라가지 않는 `lstat`으로 그 항목을 본다. 링크를 따라 여는 Windows에서는
 * 대상 없는 링크도 ENOENT이고, 위 폴더의 링크 순환도 링크 거절과 같은 ELOOP이기 때문이다. 없으면 `"missing"`, 일반 파일이
 * 아니면 `"not-regular"`, 그 밖(위 칸이 폴더가 아님·위 폴더 순환·권한 등)은 열기 오류를 그대로 던진다. 그 `lstat` 뒤에는
 * 아무것도 읽지 않으므로 그사이 바뀌어도 쓰는 것이 없다.
 */
export async function openRegularFile(
  file: string
): Promise<OpenedRegularFile | NotOpened> {
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    return await unopened(file, error);
  }
  let kept = false;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return "not-regular";
    if (constants.O_NOFOLLOW === undefined) {
      if (!sameEntry(await lstat(file, { bigint: true }), info))
        return "not-regular";
    }
    kept = true;
    return { handle, info };
  } finally {
    if (!kept)
      await continueAfterFailure(
        () => handle.close(),
        (error) =>
          console.warn(
            `[files] a file handle could not be closed (${failureCode(error)})`
          )
      );
  }
}

/** 열지 못한 경로를 링크를 따라가지 않고 본다(위 `openRegularFile` 설명). */
async function unopened(file: string, openError: unknown): Promise<NotOpened> {
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (failureCode(error) === "ENOENT") return "missing";
    throw openError;
  }
  if (entry.isFile()) throw openError;
  return "not-regular";
}
