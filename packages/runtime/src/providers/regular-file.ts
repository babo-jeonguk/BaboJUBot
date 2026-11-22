import { openRegularFile } from "@babojubot/files";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
} from "@babojubot/contracts";

/**
 * 경로가 일반 파일일 때만 그 UTF-8 내용을 돌려준다. `@babojubot/files`의 `openRegularFile`로 한 번 연 파일에서 종류를 보고
 * 읽으므로, 확인한 뒤 그 경로에 다른 파일이 들어와도 연 파일의 내용을 읽는다. 링크·폴더·특수 파일·없는 경로(위 칸이 폴더가
 * 아닌 경로 포함)는 `undefined`이고, 그 밖의 열기/확인/읽기 오류(권한·디스크·위 폴더의 링크 순환 등)는 던진다.
 */
export async function readRegularFile(
  file: string
): Promise<string | undefined> {
  let opened;
  try {
    opened = await openRegularFile(file);
  } catch (error) {
    if (hasErrorCode("ENOTDIR")(error)) return undefined;
    throw error;
  }
  if (typeof opened === "string") return undefined;
  const { handle } = opened;
  try {
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
