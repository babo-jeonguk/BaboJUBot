import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  continueAfterFailure,
  failureCode,
} from "@babojubot/contracts/failure";

/**
 * 파일 하나를 한 번에 바꾼다. 같은 폴더의 임시 이름에 다 쓴 뒤 `rename` 한 번으로 제자리에 두므로, 다른 쪽은 이전 것이나 완성된
 * 내용만 보고 비어 있거나 반쯤 쓰인 파일을 보지 않는다. hard link를 쓰지 않아 링크를 만들 수 없는 디스크(#209)에서도 된다.
 * `file`이 확인한 폴더의 `folder.at(이름)`이면 임시 파일도 그 폴더 handle 안에 둔다. `rename`은 이름 자체에 하는 일이라 그 자리의
 * 링크를 따라가지 않고 링크를 바꾼다. 임시 파일은 만드는 순간부터 정리 범위다: 쓰기나 이름 바꾸기가 실패하면 지우고, 지우기
 * 실패는 원인과 함께 남기되 원래 오류를 던진다(#280 리뷰 2회차 STD-2).
 */
export async function publishFile(
  file: string,
  contents: string,
  options: { mode: number }
): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: options.mode });
    await rename(temporary, file);
  } catch (error) {
    await continueAfterFailure(
      () => rm(temporary, { force: true }),
      (cleanup) =>
        console.warn(
          `[files] a temporary file could not be removed (${failureCode(cleanup)})`
        )
    );
    throw error;
  }
}
