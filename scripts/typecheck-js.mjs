// 저장소의 JS(개발 스크립트·agent 도구·가짜 프로그램·시험의 JS·뿌리 설정)를 타입 검사한다(#270 PR 3a). 대상은 JS 검사(checkJs)를 켠
// tsconfig이고 저장소의 tsconfig(isTypeScriptConfig)에서 찾는다: 목록을 손으로 두지 않아 새 tsconfig도 빠지지 않는다. 저장소의 JS가
// 파일마다 정확히 그중 하나에 드는지도 이 검사가 본다(ownershipProblems). 패키지·앱은 tsconfig.js.json 하나가 폴더를 고르지 않고 전체를
// 덮어, 새 폴더의 JS도 빠지지 않는다.
// JS를 .ts로 옮기면 그 영역은 엄격 설정을 받는다(패키지는 패키지 typecheck, 패키지 밖은 tsconfig.tools.json의 pnpm typecheck:tools).
// pnpm typecheck가 패키지 typecheck 뒤에 부르므로 CI(ci / typecheck)와 완료 검사가 돌리고, verify:changed는 코드 파일이나 이 검사가 읽는
// 설정(configInputs)이 바뀌면 돌린다(#270 PR 3a-2).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { isJavaScript } from "./javascript-files.ts";

const repository = path.resolve(import.meta.dirname, "..");

/** tsconfig를 tsc -p와 같이 읽는다. */
export function readConfig(file) {
  const parsed = ts.getParsedCommandLineOfConfigFile(file, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      );
    },
  });
  if (!parsed) throw new Error(`${file}: not read`);
  return parsed;
}

/**
 * 이 검사가 tsconfig로 읽는 파일인가: 파일 이름에 `tsconfig`가 들고 `.json`으로 끝난다(`tsconfig.js.json`, `alternate-tsconfig.json`).
 * verify:changed가 JS 검사를 계획할 때도 이 판정을 쓴다.
 */
export function isTypeScriptConfig(file) {
  return path.posix.matchesGlob(path.posix.basename(file), "*tsconfig*.json");
}

/** 저장소 기준 `/` 경로. */
const relative = (root, file) =>
  path.relative(root, file).replaceAll("\\", "/");

/** git이 보는 저장소 파일(추적한 파일과 무시하지 않은 새 파일, 저장소 기준 경로). */
function repositoryFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    }
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * JS 검사를 켠 저장소의 tsconfig(저장소 기준 경로)와 그 설정. 설정은 패키지 전체를 덮으므로, 설정이 고른 파일 중 git이
 * 무시하는 파일(빌드 결과 `dist`, Rust `target`, 내려받은 모듈)은 뺀다. 폴더를 하나씩 적어 빼면 새 빌드 폴더가 다시 들어온다.
 */
export function javaScriptConfigs(root = repository) {
  const files = repositoryFiles(root);
  const visible = new Set(files);
  return files
    .filter(isTypeScriptConfig)
    .map((file) => ({ file, parsed: readConfig(path.join(root, file)) }))
    .filter(({ parsed }) => parsed.options.checkJs === true)
    .map(({ file, parsed }) => ({
      file,
      parsed: {
        ...parsed,
        fileNames: parsed.fileNames.filter((name) =>
          visible.has(relative(root, name))
        ),
      },
    }));
}

/** TypeScript가 JS로 읽는 형식인가. 새 JS 금지(scripts/javascript-files.ts)와 같은 판정이다. */
export { isJavaScript };

/**
 * 이 검사가 읽는 설정 파일(저장소 기준 경로): 저장소의 tsconfig와 그 설정이 `extends`로 읽는 파일. 이 중 하나가 바뀌면 JS 검사 결과가
 * 달라질 수 있다(verify:changed).
 */
export function configInputs(root = repository) {
  const inputs = new Set();
  for (const file of repositoryFiles(root).filter(isTypeScriptConfig)) {
    inputs.add(file);
    // tsc -p처럼 읽은 설정은 그 JSON 구문 트리를 configFile에 두고, 거기에 extends로 읽은 파일이 적힌다.
    const source = /** @type {ts.TsConfigSourceFile | undefined} */ (
      readConfig(path.join(root, file)).options.configFile
    );
    for (const extended of source?.extendedSourceFiles ?? [])
      inputs.add(relative(root, extended));
  }
  return inputs;
}

/**
 * 저장소의 JS 파일마다 JS 검사를 켠 설정이 정확히 하나 맡는지. 어느 설정에도 들지 않은 파일(TypeScript가 같은 폴더의 같은 이름
 * 다른 형식 JS와 함께 두지 않아 뺀 파일 포함)과 둘 이상에 든 파일마다 문제 한 줄을 돌려준다. 파일마다 센다: 한 집합으로 합치면 두
 * 설정에 든 파일도 "들었음"으로 통과한다.
 */
export function ownershipProblems(root = repository) {
  const javaScript = repositoryFiles(root).filter(isJavaScript);
  /** @type {Map<string, string[]>} JS 파일마다 그 파일을 고른 설정 */
  const owners = new Map(javaScript.map((file) => [file, []]));
  for (const { file, parsed } of javaScriptConfigs(root))
    for (const name of parsed.fileNames)
      owners.get(relative(root, name))?.push(file);
  const stem = (file) => file.slice(0, -path.posix.extname(file).length);
  return [...owners].flatMap(([file, configs]) => {
    if (configs.length === 1) return [];
    if (configs.length > 1)
      return [
        `${file}: ${configs.length} JS checking tsconfigs include it (${configs.sort().join(", ")})`,
      ];
    const namesakes = javaScript.filter((other) => stem(other) === stem(file));
    return [
      `${file}: no JS checking tsconfig includes it${namesakes.length > 1 ? ` (TypeScript keeps one of ${namesakes.sort().join(", ")})` : ""}`,
    ];
  });
}

/**
 * 설정마다 그 설정에 든 JS 파일의 타입 검사 진단. 같은 프로그램의 TypeScript 파일은 패키지 typecheck가 엄격 설정으로 검사하므로 여기서는
 * 보지 않는다(암시적 any를 끄면 TypeScript의 빈 배열 추론이 달라져, 엄격 설정에서 맞는 코드도 다르게 읽힌다).
 */
export function diagnosticsOf(root = repository) {
  return javaScriptConfigs(root).map(({ file, parsed }) => {
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, incremental: false },
      configFileParsingDiagnostics: parsed.errors,
    });
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...parsed.fileNames.filter(isJavaScript).flatMap((name) => {
        const source = program.getSourceFile(name);
        if (!source) throw new Error(`${name}: not in the program of ${file}`);
        return [
          ...program.getSyntacticDiagnostics(source),
          ...program.getSemanticDiagnostics(source),
        ];
      }),
    ];
    return { file, diagnostics };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const host = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => repository,
    getNewLine: () => "\n",
  };
  const ownership = ownershipProblems();
  for (const problem of ownership) console.error(problem);
  let total = 0;
  for (const { file, diagnostics } of diagnosticsOf()) {
    total += diagnostics.length;
    if (diagnostics.length)
      process.stdout.write(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
      );
    console.log(`${file}: ${diagnostics.length} errors`);
  }
  if (total > 0 || ownership.length > 0) {
    console.error(
      `JS type check: ${total} errors, ${ownership.length} JS files not in exactly one JS checking tsconfig`
    );
    process.exitCode = 1;
  }
}
