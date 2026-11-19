import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// .gitignore의 점 폴더(로컬 조사 캐시·실행 데이터 등)는 checkout에 없으므로 문서·게시문이 경로로 가리키지 않는다.
export function loadIgnoredDotFolders(root) {
  return fs
    .readFileSync(path.join(root, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\/?\.[^/*!]+\/$/.test(line))
    .map((line) => line.replace(/^\//, "").slice(0, -1));
}

// 줄 시작·공백·따옴표·괄호 뒤에 오는 점 폴더 이름을 찾는다. `~/.venv`·`foo.scratch`처럼 다른 경로의 일부는 제외한다.
export function ignoredDotFolderPattern(names, flags = "") {
  return new RegExp(
    `(?:^|[\\s\`'"(])(?:\\./)?(?:${names
      .map((name) => name.replace(/[.]/g, "\\."))
      .join("|")})(?![\\w.-])`,
    flags
  );
}

/** Git이 무시하는 경로인가. check-ignore는 무시하면 0, 아니면 1로 끝난다. 그 밖의 실패는 "아니다"가 아니라 오류다. */
export function gitIgnores(root, location) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "-q", location],
    { cwd: root, encoding: "utf8", timeout: 30_000 }
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git check-ignore failed for ${location} (exit ${result.status ?? result.signal}): ${result.stderr.trim()}`
  );
}
