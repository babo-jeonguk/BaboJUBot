import { rm as fsRm } from "node:fs/promises";

/**
 * 잠깐 지나가는 잠김의 오류. Node `fs.rm`이 `maxRetries`로 다시 시도하는 코드와 같다.
 * Windows는 핸들이 늦게 닫히거나 검사 프로그램이 파일을 잠시 붙잡아 이렇게 실패한다.
 */
const transient = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);
/** 다시 시도하는 횟수와 첫 기다림. Node 자체 시험 도구(`test/common/tmpdir.js`)와 같은 값이다. */
const removeRetries = 3;
const removeRetryDelayMs = 100;

type Remove = (
  folder: string,
  options: { recursive: true; force: true }
) => Promise<void>;

/**
 * 시험 폴더를 지운다. 폴더를 쓰던 프로그램의 종료와 진행 중인 쓰기의 완료를 확인한 뒤에 부른다.
 * 일시적인 오류만 정해진 횟수 안에서 다시 시도하고(기다림은 Node `fs.rm`처럼 시도마다 늘어난다),
 * 소진하면 마지막 오류로 실패한다. 그 밖의 오류는 바로 실패하고, 이미 없는 폴더는 지운 것으로 본다.
 * Node `fs.rm`의 `maxRetries`와 같은 규칙이지만, 그 다시 시도는 Node 안에서 일어나 오류를 끼워 시험할 수 없어 직접 둔다.
 */
export async function removeFolder(
  folder: string,
  {
    rm = fsRm as Remove,
    wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: { rm?: Remove; wait?: (ms: number) => Promise<void> } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (!transient.has(code ?? "") || attempt >= removeRetries) throw error;
      await wait(removeRetryDelayMs * (attempt + 1));
    }
  }
}
