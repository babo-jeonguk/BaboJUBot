import { randomUUID } from "node:crypto";
import { link, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts/failure";

/** `removeConfirmed`의 결과. `keptAs`는 확인하지 못한 파일을 되돌리지 못해 남긴 이름(같은 폴더)이다. */
export type Removal = "removed" | "missing" | "restored" | { keptAs: string };

/** 옮긴 파일을 원래 이름으로 되돌린다. 그 사이 새 파일이 그 이름을 차지했으면(EEXIST) 새 것을 바꾸지 않고 옮긴 이름으로 남긴다. */
async function putBack(moved: string, file: string): Promise<Removal> {
  try {
    await link(moved, file);
  } catch (error) {
    // 같은 이름에 이미 무엇이 있으면(그 사이 새 파일이 저장됨) 새 것을 바꾸지 않고 옮긴 이름으로 남긴다.
    // 링크를 만들 수 없는 디스크(#209)도 옮긴 파일을 잃지 않도록 같은 답을 쓴다.
    if (hasErrorCode("EEXIST", "EPERM", "ENOTSUP", "EOPNOTSUPP")(error))
      return { keptAs: moved };
    throw error;
  }
  await unlink(moved);
  return "restored";
}

/**
 * 다른 쪽이 같은 이름에 새 파일을 둘 수 있는 자리에서, 확인한 파일만 지운다(CWE-367). 확인한 뒤 이름으로 지우면 그 사이 같은
 * 이름에 둔 다른 파일을 지운다. 그래서 먼저 그 이름의 파일을 이 호출만 아는 이름(`moved`)으로 옮기고, 옮긴 파일을 `confirm`으로
 * 확인해 맞을 때만 지운다. `rename`은 이름 자체에 하는 일이라 그 자리의 링크를 따라가지 않고, `moved`는 이 호출만 아는 이름이라
 * 확인한 것과 지우는 것이 같다. 아니면 같은 이름에 있던 것을 바꾸지 않고 되돌린다.
 *
 * `confirm`이 던지면 확인하지 못한 것이므로 되돌린 뒤 그 오류를 그대로 던진다. 되돌리지 못한 실패는 남기고 원래 오류를 던진다.
 * 이름을 되돌리지 못하면(그 사이 새 파일이 이름을 차지함, 링크를 만들 수 없음) 옮긴 파일을 지우지 않고 `{ keptAs }`로 알린다.
 */
export async function removeConfirmed(
  file: string,
  confirm: (moved: string) => Promise<boolean>
): Promise<Removal> {
  const moved = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.removing`
  );
  const renamed = await orIfMissing(
    async () => {
      await rename(file, moved);
      return true;
    },
    hasErrorCode("ENOENT"),
    false
  );
  if (!renamed) return "missing";
  let confirmed: boolean;
  try {
    confirmed = await confirm(moved);
  } catch (error) {
    await continueAfterFailure(
      async () => {
        const removal = await putBack(moved, file);
        if (typeof removal === "object")
          console.warn(
            `[files] a file that could not be confirmed was kept as ${removal.keptAs}`
          );
      },
      (restoreError) =>
        console.warn(
          `[files] a file that could not be confirmed was not put back (${failureCode(restoreError)})`
        )
    );
    throw error;
  }
  if (confirmed) {
    await unlink(moved);
    return "removed";
  }
  return putBack(moved, file);
}
