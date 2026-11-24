import { randomUUID } from "node:crypto";
import { link, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  failureCode,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts/failure";

/**
 * 지우지 못하고 옮긴 이름에 남긴 파일. `keptAs`는 원래 파일과 같은 폴더 안의 파일 이름이다. 부른 쪽은 자기가 아는 폴더 기준으로
 * 그 위치를 적는다(폴더 handle의 경로는 handle을 닫으면 쓸 수 없다). `because`는 남긴 까닭이 예상 밖의 실패일 때 그 실패다(되돌리기의
 * 링크·옮긴 이름 지우기). 이름이 차지됐거나 링크를 만들 수 없는 디스크면 없다.
 */
export type Kept = { keptAs: string; because?: unknown };
/** `removeConfirmed`의 결과. */
export type Removal = "removed" | "missing" | "restored" | Kept;

/**
 * `confirm`이 던져 옮긴 파일을 확인하지 못했다. 지우지 않았다. `cause`는 그 오류이고, `kept`는 제자리에 되돌렸는지(`"restored"`) 옮긴
 * 이름에 남겼는지다. 남긴 위치를 확인 실패와 함께 부른 쪽에 넘긴다. `code`는 원인의 코드(`failureCode`)라, 이 오류를 받아 코드만
 * 남기는 기록도 감싼 오류의 이름이 아니라 원래 원인을 남긴다.
 */
export class ConfirmFailed extends Error {
  readonly kept: "restored" | Kept;
  readonly code: string;
  constructor(cause: unknown, kept: "restored" | Kept) {
    super("the moved file could not be confirmed; it was not removed", {
      cause,
    });
    this.kept = kept;
    this.code = failureCode(cause);
  }
}

/**
 * 옮긴 파일을 원래 이름으로 되돌린다. hard link 한 번으로 옮긴 이름이 가리키는 것 그대로 원래 이름에 두고, 그 이름이 이미
 * 차지됐으면(EEXIST) 새 것을 바꾸지 않는다. 링크를 만들 수 없는 디스크(EPERM·ENOTSUP·EOPNOTSUPP)에는 한 번에 되돌릴 길이 없다.
 * 옮긴 이름을 다시 열어 복사하면 그사이 그 이름에 놓인 다른 것(링크라면 그 너머)을 원래 이름에 둘 수 있으므로 되돌리지 않는다.
 * 되돌리지 못했거나 되돌린 뒤 옮긴 이름을 지우지 못했으면 옮긴 파일을 그 이름으로 남겨 알린다(fail closed). 던지지 않는다.
 */
async function putBack(
  moved: string,
  file: string
): Promise<"restored" | Kept> {
  const keptAs = path.basename(moved);
  try {
    await link(moved, file);
  } catch (error) {
    if (hasErrorCode("EEXIST", "EPERM", "ENOTSUP", "EOPNOTSUPP")(error))
      return { keptAs };
    return { keptAs, because: error };
  }
  return (await removeMoved(moved)) ?? "restored";
}

/** 옮긴 이름을 지운다. 지우지 못하면 그 이름에 남은 것(`Kept`)을, 지웠으면 `undefined`를 돌려준다. */
async function removeMoved(moved: string): Promise<Kept | undefined> {
  try {
    await unlink(moved);
  } catch (error) {
    return { keptAs: path.basename(moved), because: error };
  }
  return undefined;
}

/**
 * 다른 쪽이 같은 이름에 새 파일을 둘 수 있는 자리에서, 확인한 파일만 지운다(CWE-367). 확인한 뒤 이름으로 지우면 그 사이 같은
 * 이름에 둔 다른 파일을 지운다. 그래서 먼저 그 이름의 파일을 이 호출만 아는 이름(`moved`)으로 옮기고, 옮긴 파일을 `confirm`으로
 * 확인해 맞을 때만 지운다. `rename`은 이름 자체에 하는 일이라 그 자리의 링크를 따라가지 않는다. 원래 이름에 저장하는 쪽은
 * `moved`를 모르므로 그 저장은 확인한 것과 지우는 것 사이에 끼지 않는다. 그 폴더를 읽어 `moved`를 찾아 바꿔 넣는 쪽은 막지
 * 못하지만, 그런 쪽은 그 폴더의 파일을 이미 스스로 지울 수 있다. 아니면 같은 이름에 있던 것을 바꾸지 않고 되돌린다.
 *
 * 옮긴 뒤에는 파일이 어디 있는지 늘 부른 쪽에 닿는다. 되돌리지 못하거나(그 사이 새 파일이 이름을 차지함, 링크를 만들 수 없는
 * 디스크, 예상 밖의 실패) 확인한 파일의 옮긴 이름을 지우지 못하면 `Kept`로 알리고, `confirm`이 던지면 되돌린 뒤 그 오류와 결과를
 * `ConfirmFailed`로 던진다.
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
    throw new ConfirmFailed(error, await putBack(moved, file));
  }
  if (!confirmed) return putBack(moved, file);
  return (await removeMoved(moved)) ?? "removed";
}
