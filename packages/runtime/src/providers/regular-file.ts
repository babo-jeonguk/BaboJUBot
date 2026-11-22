import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts";

/**
 * 경로가 일반 파일일 때만 그 UTF-8 내용을 돌려준다. 파일 종류 확인과 내용 읽기를 한 번 연 파일 하나로 하므로,
 * 확인한 뒤 그 경로에 다른 파일이 들어와도 연 파일의 내용을 읽는다(경로를 다시 열면 그 사이 바뀐 파일을 읽을 수 있다).
 * 링크·폴더·없는 경로는 `undefined`이고, 그 밖의 열기/확인/읽기 오류(권한·디스크 등)는 던진다.
 * POSIX에서는 `O_NOFOLLOW`로 링크를 열 때부터 거절하고, `O_NONBLOCK`으로 FIFO를 기다리지 않고 연 뒤 일반 파일이 아니라고
 * 답한다. Windows에는 두 플래그가 없어 연 뒤 `lstat`의 경로 항목이 연 파일 자체(dev·ino)를 가리키는지 확인해 링크를 거절한다
 * (다른 파일의 내용을 대신 읽지는 않는다).
 */
export async function readRegularFile(
  file: string
): Promise<string | undefined> {
  const handle = await orIfMissing(
    () =>
      open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0)
      ),
    hasErrorCode("ENOENT", "ENOTDIR", "ELOOP", "EISDIR"),
    undefined
  );
  if (handle === undefined) return undefined;
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
