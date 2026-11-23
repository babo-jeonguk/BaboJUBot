// CI `changes` job이 바뀐 파일 목록(`git diff -z --name-only`, NUL 구분, 표준 입력)으로 어떤 검사를 돌릴지 정한다. 결과는 GITHUB_OUTPUT 형식이다.
// - code: Markdown이 아닌 파일이 바뀌었다. 테스트 job 전체를 돈다.
// - files: 조직 경계의 파일 읽기·그 계약·시험·환경 준비·의존성·CI 설정이 바뀌었다. 파일 시스템별 전체 검증(`files / …`)을 돈다.
// `--full`은 비교할 기준이 없을 때(첫 push, 수동 실행)다. 영향을 모르므로 모두 돈다.
import { pathToFileURL } from "node:url";
import { codeFormatPattern } from "./test-files.mjs";

/**
 * 파일 읽기 경계에 닿는 경로. 영향이 불명확한 공용 설정(의존성·CI)도 넣는다. 전체 검증은 읽는 프로세스와
 * `Workspaces.readArtifact`만 돌리므로, `record_artifact` 도구 처리(apps/server/src/tools.ts)와 DB 저장은 일반 서버 시험
 * (file-artifacts.test.ts)이 맡고 여기에 넣지 않는다.
 */
export const fileBoundaryPaths = [
  // 서버의 산출물 읽기와 그 별도 프로세스(workspace-reader.ts)·둘이 함께 쓰는 값.
  new RegExp(`^apps/server/src/workspace[^/]*\\.${codeFormatPattern}$`),
  new RegExp(
    `^apps/server/test/(workspace[^/]*|files-volume)\\.${codeFormatPattern}$`
  ),
  /^apps\/server\/vitest\.files\.config\.ts$/,
  /^apps\/server\/package\.json$/,
  // 산출물 파일 읽기의 거부 이유·크기 한도 계약.
  /^packages\/contracts\/src\/task\.ts$/,
  // 읽는 프로세스가 파일·폴더를 여는 바탕(@babojubot/files)과 그 실패 판정.
  /^packages\/files\//,
  /^packages\/contracts\/src\/failure\.ts$/,
  new RegExp(
    `^scripts/(ci-changes|check-ci-test-gate|ci-test-gate|file-boundary-[^/]+)(\\.test)?\\.${codeFormatPattern}$`
  ),
  /^scripts\/files\//,
  /^\.github\/workflows\/scaffold\.yml$/,
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version)$/,
];

export function classify(files, { full = false } = {}) {
  if (full) return { code: true, files: true };
  return {
    code: files.some((file) => !file.endsWith(".md")),
    files: files.some((file) =>
      fileBoundaryPaths.some((pattern) => pattern.test(file))
    ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const full = process.argv.includes("--full");
  let input = "";
  if (!full) for await (const chunk of process.stdin) input += chunk;
  // `git diff -z --name-only`의 NUL 구분 목록이다. 줄 단위 목록은 줄바꿈·따옴표가 든 이름을 따옴표로 감싸 다른 경로로 만든다.
  const files = input.split("\0").filter(Boolean);
  const result = classify(files, { full });
  process.stdout.write(`code=${result.code}\nfiles=${result.files}\n`);
}
