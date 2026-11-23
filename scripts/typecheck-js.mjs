// 저장소의 JS(개발 스크립트·agent 도구·가짜 프로그램·시험의 JS·뿌리 설정)를 타입 검사한다(#270 PR 3a). 대상은 JS 검사(checkJs)를 켠
// tsconfig이고 저장소의 tsconfig에서 찾는다: 목록을 손으로 두지 않아 새 tsconfig도 빠지지 않는다. 모든 JS가 그중 하나에 드는지는
// scripts/typecheck-js.test.mjs가 본다. 패키지·앱은 tsconfig.js.json 하나가 폴더를 고르지 않고 전체를 덮어, 새 폴더의 JS도 빠지지 않는다.
// JS를 .ts로 옮기면 그 영역은 패키지 typecheck의 엄격 설정을 받는다.
// 아직 pnpm typecheck·CI·verify:changed에 연결하지 않았다: #274·#280이 고치는 파일에 오류가 남아(#270 PR 3a-1) 그 PR들이 병합된 뒤
// PR 3a-2가 남은 오류를 고치고 연결한다. 그 전까지는 이 검사가 아무것도 막지 않는다.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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

/** git이 보는 저장소 파일(추적한 파일과 무시하지 않은 새 파일, 저장소 기준 경로). `pattern`으로 좁힌다. */
function repositoryFiles(root, pattern) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      ...(pattern ? ["--", pattern] : []),
    ],
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
  const visible = new Set(repositoryFiles(root));
  return repositoryFiles(root, "*tsconfig*.json")
    .map((file) => ({ file, parsed: readConfig(path.join(root, file)) }))
    .filter(({ parsed }) => parsed.options.checkJs === true)
    .map(({ file, parsed }) => ({
      file,
      parsed: {
        ...parsed,
        fileNames: parsed.fileNames.filter((name) =>
          visible.has(path.relative(root, name).replaceAll("\\", "/"))
        ),
      },
    }));
}

/**
 * TypeScript가 JS로 읽는 형식.
 * @type {Set<string>}
 */
const javaScriptExtensions = new Set([
  ts.Extension.Js,
  ts.Extension.Jsx,
  ts.Extension.Mjs,
  ts.Extension.Cjs,
]);
export const isJavaScript = (file) =>
  javaScriptExtensions.has(path.extname(file));

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
  let total = 0;
  for (const { file, diagnostics } of diagnosticsOf()) {
    total += diagnostics.length;
    if (diagnostics.length)
      process.stdout.write(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
      );
    console.log(`${file}: ${diagnostics.length} errors`);
  }
  if (total > 0) {
    console.error(`JS type check: ${total} errors`);
    process.exitCode = 1;
  }
}
