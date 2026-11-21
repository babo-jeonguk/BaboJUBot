import { removeFolder } from "@babojubot/process/remove-folder";

/**
 * 실행 시도가 만든 폴더를 지운다. 폴더를 쓰던 프로그램이 끝난 뒤에 부른다.
 * 지우기는 `removeFolder`가 하므로 잠깐 잠긴 오류는 정해진 횟수만큼 다시 시도한다.
 * 그래도 지우지 못하면 폴더는 그대로 두고 이 경고가 기록이 된다(자동으로 거두는 곳은 없고, 그 폴더가 쥐고 있던 토큰은 이미 무효다).
 * 지우지 못해도 실행 결과는 바꾸지 않는다.
 */
export async function removeAttemptFolder(
  folder: string,
  about: {
    kind: "attempt folder" | "log folder";
    connection: string;
    runId?: string;
  }
): Promise<void> {
  try {
    await removeFolder(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.warn(
      `[provider] could not remove the ${about.kind} of run ${about.runId ?? "(none)"} on connection ${about.connection}; it is left at ${folder} (${typeof code === "string" ? code : "unknown"})`
    );
  }
}
