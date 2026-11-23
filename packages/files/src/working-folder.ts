import { stat } from "node:fs/promises";
import { sameEntry, type EntryIdentity } from "./regular-file.ts";

/**
 * 작업 폴더를 확인한 폴더로 옮긴다. 작업 폴더는 프로세스에 하나이므로, 폴더를 붙들려고 띄운 별도 프로세스(서버의 산출물 읽기,
 * Antigravity 설정 정리)만 쓴다. 서버 안에서 폴더 안을 다룰 때는 `inFolder`를 쓴다.
 * 커널은 작업 폴더를 경로가 아니라 폴더 자체로 붙들므로, 들어간 뒤 바깥 경로가 바뀌어도 상대 경로는 그 폴더 안을 연다. Node에는
 * openat이 없어(nodejs/node#31110) 모든 시스템에서 폴더를 붙드는 길이 이것이다. `expected`는 들어가기 전에 그 이름을 `lstat`으로
 * 본 항목(위로 갈 때는 전에 들어 있던 폴더)이다. 들어간 폴더가 그것이 아니면(그 사이 바뀜) false다. 들어가기 오류는 그대로
 * 던진다(없음·권한 같은 원인은 부르는 쪽이 가른다).
 */
export async function enterFolder(
  name: string,
  expected: EntryIdentity
): Promise<boolean> {
  process.chdir(name);
  return sameEntry(expected, await stat(".", { bigint: true }));
}
