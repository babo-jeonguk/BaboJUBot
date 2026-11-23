// package.json `exports`의 입구를 Node 자신의 해석기로 푼다. 코드 지도 검사(scripts/check-code-map.mjs)와 lint의 가져오기 대상 판정
// (scripts/eslint-imports.mjs)이 함께 쓴다. 해석 규칙(조건, `*` 무늬와 더 긴 키의 우선, 막힌 입구, `..`·`node_modules` 대상 거부)을
// 다시 짜면 Node와 어긋나므로(#289 외부 리뷰 SPEC-1·2) 다시 짜지 않는다: 패키지 폴더를 작업 폴더로 둔 Node가 자기 참조
// (`import.meta.resolve("<이름>/<입구>")`)로 풀고, 풀지 못하면 그 오류 코드를 돌려준다(ERR_PACKAGE_PATH_NOT_EXPORTED: 내보내지 않음·
// null로 막음·조건 불일치, ERR_INVALID_PACKAGE_TARGET: 잘못된 대상). Node는 대상 파일이 있는지 보지 않으므로 그것은 부르는 쪽이 본다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 입구 하나의 풀이: 대상 파일의 절대 경로, 또는 Node가 거부한 오류 코드. */
export type EntryResolution = { file: string } | { refused: string };

const resolver = `
const results = process.argv.slice(1).map((specifier) => {
  try {
    return { url: import.meta.resolve(specifier) };
  } catch (error) {
    return { refused: error && typeof error === "object" && "code" in error ? String(error.code) : String(error) };
  }
});
process.stdout.write(JSON.stringify(results));
`;

const cache = new Map<string, EntryResolution>();

/**
 * 패키지(`folder`는 package.json이 있는 절대 경로, `name`은 그 이름)의 입구들(`.`·`./testing`)을 Node로 푼다. 같은 패키지·입구는 한
 * 번만 푼다. Node를 띄우지 못하거나 답을 읽지 못하면 던진다(풀지 못한 것을 "없음"으로 접지 않는다).
 */
export function resolvePackageEntries(
  folder: string,
  name: string,
  entries: string[]
): Map<string, EntryResolution> {
  const key = (entry: string) => `${folder}\0${name}\0${entry}`;
  const missing = [...new Set(entries)].filter(
    (entry) => !cache.has(key(entry))
  );
  if (missing.length > 0) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        resolver,
        ...missing.map((entry) =>
          entry === "." ? name : `${name}${entry.slice(1)}`
        ),
      ],
      {
        cwd: folder,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `could not resolve the entries of ${name} in ${folder}: ${result.error?.message ?? `exit ${result.status ?? result.signal}`} ${result.stderr}`
      );
    const answers: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(answers) || answers.length !== missing.length)
      throw new Error(
        `could not read the entries of ${name}: ${result.stdout}`
      );
    missing.forEach((entry, index) => {
      const answer: unknown = answers[index];
      if (
        answer &&
        typeof answer === "object" &&
        "url" in answer &&
        typeof answer.url === "string"
      )
        cache.set(key(entry), { file: fileURLToPath(answer.url) });
      else if (
        answer &&
        typeof answer === "object" &&
        "refused" in answer &&
        typeof answer.refused === "string"
      )
        cache.set(key(entry), { refused: answer.refused });
      else
        throw new Error(
          `could not read the entry ${entry} of ${name}: ${JSON.stringify(answer)}`
        );
    });
  }
  return new Map(
    entries.map((entry) => {
      const found = cache.get(key(entry));
      if (!found) throw new Error(`entry ${entry} of ${name} was not resolved`);
      return [entry, found];
    })
  );
}

/** 하나의 입구를 푼다(resolvePackageEntries의 한 개짜리). */
export function resolvePackageEntry(
  folder: string,
  name: string,
  entry: string
): EntryResolution {
  const found = resolvePackageEntries(folder, name, [entry]).get(entry);
  if (!found) throw new Error(`entry ${entry} of ${name} was not resolved`);
  return found;
}

/** 메시지에 적을 입구 이름(`exports`의 키, 입구 표가 아니면 `.`). 해석에는 쓰지 않는다. */
export function exportKeys(exports: unknown): string[] {
  if (
    exports !== null &&
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((entry) => entry.startsWith("."))
  )
    return Object.keys(exports);
  return ["."];
}

/** 저장소 기준 `/` 경로. */
export const repositoryRelative = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join("/");
