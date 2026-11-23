// 새 JS 파일을 받지 않는다(#270 PR 3b-1). 스크립트·시험·도구는 TypeScript로 쓰고, Node 24가 타입을 지우고 바로 돌린다. 남은 JS는
// 영역별로 TypeScript로 옮긴다(옮긴 영역은 scripts/typecheck-js.test.mjs가 다시 JS로 돌아가지 못하게 본다).
// 바뀐 파일 목록은 `git diff -z --name-status --find-renames <merge-base>`의 출력이다. CI의 changes job과 verify:changed가 같은 기준으로
// 부른다. 새로 더한 JS, 복사한 JS, 다른 형식에서 JS로 이름을 바꾼 파일이 새 JS다. JS를 TypeScript로 옮기기와 기존 JS의 수정·이동·삭제는
// 받는다. 예외 목록은 두지 않는다.
// 사용: git diff -z --name-status --find-renames <base>...HEAD | node scripts/javascript-files.ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { javaScriptFormatNames } from "./test-files.mjs";

/** TypeScript가 JS로 읽는 형식(scripts/test-files.mjs의 형식 목록에서 고른다). */
const javaScriptExtensions = new Set(
  javaScriptFormatNames.map((name) => `.${name}`)
);

export const isJavaScript = (file: string) =>
  javaScriptExtensions.has(path.extname(file));

/** 바뀐 파일 목록(`git diff -z --name-status --find-renames`)에서 새로 생긴 JS 파일. */
export function addedJavaScript(diff: string): string[] {
  const fields = diff.split("\0");
  const added: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index] ?? "";
    index += 1;
    if (!status) continue;
    // 이름 바꾸기(R)와 복사(C)는 원래 경로와 새 경로, 나머지는 경로 하나가 따른다.
    const from = /^[RC]/.test(status) ? fields[index++] : undefined;
    const file = fields[index++];
    if (file === undefined || !isJavaScript(file)) continue;
    if (status.startsWith("A") || status.startsWith("C")) added.push(file);
    else if (
      status.startsWith("R") &&
      from !== undefined &&
      !isJavaScript(from)
    )
      added.push(file);
  }
  return added;
}

/** 새 JS 파일마다 읽는 사람에게 남길 문구. */
export const refusal = (file: string) =>
  `${file}: a new JavaScript file. Write scripts, tests and tools in TypeScript; Node runs .ts directly (CODING_STANDARDS.md).`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let diff = "";
  for await (const chunk of process.stdin) diff += String(chunk);
  const added = addedJavaScript(diff);
  // GitHub Actions가 파일에 붙여 보여 주는 형식이다. 로컬에서도 그대로 읽힌다.
  for (const file of added)
    console.log(`::error file=${file}::${refusal(file)}`);
  if (added.length) process.exitCode = 1;
}
