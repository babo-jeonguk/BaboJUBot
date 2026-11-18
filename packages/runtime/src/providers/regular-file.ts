import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

/**
 * 경로가 일반 파일일 때만 그 UTF-8 내용을 돌려준다. 파일 종류 확인과 내용 읽기를 한 번 연 파일 하나로 하므로,
 * 확인한 뒤 그 경로에 다른 파일이 들어와도 연 파일의 내용을 읽는다(경로를 다시 열면 그 사이 바뀐 파일을 읽을 수 있다).
 * 링크·폴더·없는 경로와 열기/확인/읽기 오류는 `undefined`다.
 * POSIX에서는 `O_NOFOLLOW`로 링크를 열 때부터 거절한다. Windows에는 `O_NOFOLLOW`가 없어 연 뒤 `lstat`으로 일반 파일인지만
 * 다시 확인한다(다른 파일의 내용을 대신 읽지는 않는다).
 */
export async function readRegularFile(
  file: string
): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    if (constants.O_NOFOLLOW === undefined) {
      const found = await lstat(file);
      if (!found.isFile()) return undefined;
    }
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    return await handle.readFile("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
