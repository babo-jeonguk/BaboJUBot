// run-worker 요약의 "고친 파일" 표시(worker-summary.ts). opencode는 도구가 고친 파일을 그 시스템의 경로로 알린다(Windows는
// `C:\…\src\a.ts`). 작업 폴더 안이면 작업 폴더 기준 상대 경로를 `/`로 보이고, 밖이면 알린 그대로 둔다. 경로 규칙(path.win32·
// path.posix)을 넣어 어느 시스템에서든 두 규칙을 모두 본다.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { shownPath } from "./worker-summary.ts";

test("shows a Windows path inside the working folder relative to it with slashes", () => {
  const folder = "C:\\work\\repo";
  assert.equal(
    shownPath("C:\\work\\repo\\src\\a.ts", folder, path.win32),
    "src/a.ts"
  );
  // Windows 경로는 대소문자와 구분자 모양을 가리지 않는다.
  assert.equal(
    shownPath("c:/WORK/repo/src/b.ts", folder, path.win32),
    "src/b.ts"
  );
});

test("shows a POSIX path inside the working folder relative to it", () => {
  assert.equal(
    shownPath("/work/repo/src/a.ts", "/work/repo", path.posix),
    "src/a.ts"
  );
  assert.equal(shownPath("/work/repo", "/work/repo", path.posix), ".");
});

test("keeps a path outside the working folder as it was reported", () => {
  const cases: [file: string, folder: string, paths: path.PlatformPath][] = [
    ["C:\\work\\other\\a.ts", "C:\\work\\repo", path.win32],
    ["D:\\repo\\src\\a.ts", "C:\\work\\repo", path.win32],
    ["C:\\work\\repository\\a.ts", "C:\\work\\repo", path.win32],
    ["/work/other/a.ts", "/work/repo", path.posix],
    ["/work/repository/a.ts", "/work/repo", path.posix],
    ["/work/a.ts", "/work/repo", path.posix],
  ];
  for (const [file, folder, paths] of cases)
    assert.equal(shownPath(file, folder, paths), file, file);
});

test("shows a path the tool reported relative to the working folder with slashes", () => {
  assert.equal(
    shownPath("src\\a.ts", "C:\\work\\repo", path.win32),
    "src/a.ts"
  );
  assert.equal(shownPath("src/a.ts", "/work/repo", path.posix), "src/a.ts");
});
