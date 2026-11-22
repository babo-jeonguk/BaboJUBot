import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
} from "@babojubot/contracts";

/**
 * 경로가 일반 파일일 때만 그 UTF-8 내용을 돌려준다. 파일 종류 확인과 내용 읽기를 한 번 연 파일 하나로 하므로,
 * 확인한 뒤 그 경로에 다른 파일이 들어와도 연 파일의 내용을 읽는다(경로를 다시 열면 그 사이 바뀐 파일을 읽을 수 있다).
 * 링크·폴더·없는 경로는 `undefined`이고, 그 밖의 열기/확인/읽기 오류(권한·디스크 등)는 던진다. 열지 못하면 그 자리를
 * `unopened`가 링크를 따라가지 않고 가린다(위 폴더의 링크 순환은 던진다).
 * POSIX에서는 `O_NOFOLLOW`로 링크를 열 때부터 거절하고, `O_NONBLOCK`으로 FIFO를 기다리지 않고 연 뒤 일반 파일이 아니라고
 * 답한다. Windows에는 두 플래그가 없어 연 뒤 `lstat`의 경로 항목이 연 파일 자체(dev·ino)를 가리키는지 확인해 링크를 거절한다
 * (다른 파일의 내용을 대신 읽지는 않는다).
 */
export async function readRegularFile(
  file: string
): Promise<string | undefined> {
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
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return undefined;
    if (constants.O_NOFOLLOW === undefined) {
      const entry = await lstat(file, { bigint: true });
      if (entry.dev !== info.dev || entry.ino !== info.ino) return undefined;
    }
    return await handle.readFile("utf8");
  } finally {
    await continueAfterFailure(
      () => handle.close(),
      (error) =>
        console.warn(
          `[provider] a file handle could not be closed (${failureCode(error)})`
        )
    );
  }
}

/**
 * 열지 못한 경로를 링크를 따라가지 않고 본다. 열기 오류 코드만으로는 경로 항목을 알 수 없다: 링크를 따라 여는 Windows에서
 * 대상 없는 링크도 ENOENT이고, 위 폴더의 링크 순환도 `O_NOFOLLOW`의 링크 거절과 같은 ELOOP이다. 없는 경로(ENOENT·ENOTDIR)이거나
 * 일반 파일이 아닌 항목(링크·폴더·특수 파일)이면 `undefined`, 그 밖에는 열기 오류를 던진다. 내용은 읽지 않으므로 본 뒤 바뀌어도
 * 쓰는 것이 없다.
 */
async function unopened(file: string, openError: unknown): Promise<undefined> {
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (hasErrorCode("ENOENT", "ENOTDIR")(error)) return undefined;
    throw openError;
  }
  if (entry.isFile()) throw openError;
  return undefined;
}
