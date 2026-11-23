// 저장소의 모든 JS가 타입 검사를 받는지(#270 PR 3a). JS 검사(checkJs)를 켠 tsconfig 중 하나에 들지 않은 JS는 lint만 받고, 공용 함수에
// 인수를 잘못 넘겨도 실행해야 드러난다(#272).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import {
  diagnosticsOf,
  isJavaScript,
  javaScriptConfigs,
  ownershipProblems,
  readConfig,
} from "./typecheck-js.mjs";
import { codeFormatNames } from "./test-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });

// 검사는 pnpm typecheck에 들어 있어야 CI(ci / typecheck)와 완료 검사가 돌린다. 따로 두면 아무것도 막지 않는다(#270 PR 3a-1이 그랬다).
test("pnpm typecheck runs the JS check after the package type checks", () => {
  const { scripts } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  assert.deepEqual(scripts.typecheck.split(" && "), [
    "pnpm -r --if-present run typecheck",
    "pnpm run typecheck:tools",
    "pnpm run typecheck:js",
  ]);
  assert.equal(scripts["typecheck:tools"], "tsc -p tsconfig.tools.json");
  assert.equal(scripts["typecheck:js"], "node scripts/typecheck-js.mjs");
});

// TypeScript로 옮긴 영역(#270 PR 3b). 다시 JS로 돌아가지 못한다. 새 JS 파일은 어디서든 받지 않는다(scripts/javascript-files.ts).
const typeScriptAreas = [".agents/"];

test("an area moved to TypeScript has no JS file", () => {
  const javaScript = git(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z"
  )
    .split("\0")
    .filter((file) => file && isJavaScript(file));
  assert.deepEqual(
    javaScript.filter((file) =>
      typeScriptAreas.some((area) => file.startsWith(area))
    ),
    []
  );
});

// 패키지 밖의 TypeScript(agent 도구, 개발 스크립트의 .ts)는 패키지 typecheck가 보지 않는다. tsconfig.tools.json이 제품 코드와 같은
// 엄격 설정으로 모두 검사한다(pnpm typecheck:tools). 각 폴더의 tsconfig.json은 lint가 타입 정보를 얻는 설정이다. 옮긴 영역의 설정은
// 느슨하게 두지 않는다. 아직 옮기지 않은 scripts의 설정은 그 JS 때문에 느슨하므로, 그 안의 .ts는 tools 설정이 엄격하게 본다.
test("every TypeScript file outside the packages is type-checked strictly", () => {
  const tools = readConfig(path.join(root, "tsconfig.tools.json"));
  assert.equal(tools.options.strict, true);
  assert.notEqual(tools.options.noImplicitAny, false);
  assert.notEqual(tools.options.checkJs, true);
  const checked = new Set(
    tools.fileNames.map((file) =>
      path.relative(root, file).replaceAll("\\", "/")
    )
  );
  // 그 폴더 설정(.agents/tsconfig.json, scripts/tsconfig.json)에 드는 TypeScript다. 자기 설정을 가진 시험 묶음(scripts/fixtures의
  // 실패 확인용 vitest 전역)은 그 설정이 맡는다.
  const typeScript = [
    ...typeScriptAreas.map((area) => `${area}tsconfig.json`),
    "scripts/tsconfig.json",
  ]
    .flatMap((config) =>
      readConfig(path.join(root, config)).fileNames.map((file) =>
        path.relative(root, file).replaceAll("\\", "/")
      )
    )
    .filter((file) => /\.[cm]?tsx?$/.test(file));
  assert.ok(
    typeScript.some((file) => file.startsWith(".agents/")),
    "no TypeScript in the agent tools"
  );
  assert.deepEqual(
    typeScript.filter((file) => !checked.has(file)),
    []
  );
  for (const area of typeScriptAreas) {
    const config = readConfig(path.join(root, `${area}tsconfig.json`));
    assert.equal(config.options.strict, true, area);
    assert.notEqual(config.options.noImplicitAny, false, area);
    assert.notEqual(config.options.checkJs, true, area);
  }
});

test("every JS file in the repository is type-checked", () => {
  const javaScript = git(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z"
  )
    .split("\0")
    .filter((file) => file && isJavaScript(file));
  assert.ok(javaScript.length > 0, "no JS file found");
  assert.deepEqual(ownershipProblems(), []);
});

// 패키지·앱 안 어디에 새 JS를 두어도 검사 설정 하나가 맡는다. 손 목록이나 폴더별 설정에 기대면 새 폴더의 JS가 빠진다: #274가 더한
// packages/process/supervisor/build.mjs가 어느 설정에도 들지 않아, #281과 연달아 병합된 main에서 위 시험이 실패했다. 두 설정에 들면
// 같은 오류를 두 번 알리므로 정확히 하나여야 한다. 저장소 tsconfig를 같은 자리에 옮긴 임시 저장소에 형식마다 표본을 둔다.
test("a JS file added anywhere in a package or app is type-checked by exactly one config", (context) => {
  const mirror = mkdtempSync(path.join(tmpdir(), "typecheck-js-places-"));
  context.after(() => removeFolder(mirror));
  git(mirror, "init", "-q");
  // 검사기(javaScriptConfigs)처럼 아직 커밋하지 않은 설정도 옮긴다.
  for (const config of git(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*tsconfig*.json"
  )
    .split("\0")
    .filter(Boolean)) {
    mkdirSync(path.join(mirror, path.dirname(config)), { recursive: true });
    copyFileSync(path.join(root, config), path.join(mirror, config));
  }
  const workspaces = globSync("{apps,packages}/*/package.json", {
    cwd: root,
  }).map((file) => path.dirname(file).replaceAll("\\", "/"));
  assert.ok(workspaces.length > 0, "no workspace package found");
  const formats = codeFormatNames.filter((format) =>
    isJavaScript(`sample.${format}`)
  );
  assert.ok(formats.length > 0, "no JS format found");
  const samples = workspaces
    .flatMap((folder) =>
      ["", "src/", "new-place/", "test-fixtures/new-place/"].map(
        (place) => `${folder}/${place}sample`
      )
    )
    // TypeScript는 한 폴더에서 확장자만 다른 같은 이름을 하나만 넣으므로 형식마다 이름을 달리한다.
    .flatMap((place) =>
      formats.map((format) => `${place}-${format}.${format}`)
    );
  for (const sample of samples) {
    mkdirSync(path.join(mirror, path.dirname(sample)), { recursive: true });
    writeFileSync(path.join(mirror, sample), "export const a = 1;\n");
  }
  /** @type {Map<string, string[]>} 표본마다 그 표본을 고른 설정 */
  const owners = new Map(samples.map((sample) => [sample, []]));
  for (const { file, parsed } of javaScriptConfigs(mirror))
    for (const name of parsed.fileNames)
      owners.get(path.relative(mirror, name).replaceAll("\\", "/"))?.push(file);
  assert.deepEqual(
    [...owners].filter(([, configs]) => configs.length !== 1),
    []
  );
});

test("the JS check finds JS checking configs, reports the mistakes of their JS files and leaves TypeScript to its own check", (context) => {
  const folder = mkdtempSync(path.join(tmpdir(), "typecheck-js-"));
  context.after(() => removeFolder(folder));
  git(folder, "init", "-q");
  writeFileSync(
    path.join(folder, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        allowJs: true,
        checkJs: true,
        noImplicitAny: false,
        noEmit: true,
        module: "NodeNext",
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ["**/*"],
    })
  );
  writeFileSync(
    path.join(folder, "tsconfig.unchecked.json"),
    JSON.stringify({ compilerOptions: { checkJs: false } })
  );
  // TypeScript 함수에 인수 수를 틀린 JS 호출(#272의 실수)은 잡는다. 같은 프로그램의 TypeScript 파일은 엄격 설정의 자기 검사가 맡아
  // 보지 않는다(암시적 any를 끄면 빈 배열이 never[]로 읽혀 거기서 오류가 난다).
  writeFileSync(
    path.join(folder, "typed.mts"),
    "export function pick(value: number, fallback: number, isMissing: (value: number) => boolean) {\n  return isMissing(value) ? fallback : value;\n}\nconst values = [];\nvalues.push(1);\nexport { values };\n"
  );
  writeFileSync(
    path.join(folder, "caller.mjs"),
    'import { pick } from "./typed.mts";\npick(1, 2);\n'
  );
  const results = diagnosticsOf(folder);
  assert.deepEqual(
    results.map(({ file }) => file),
    ["tsconfig.json"]
  );
  const [checked] = results;
  assert.ok(checked);
  assert.deepEqual(
    checked.diagnostics.map((diagnostic) => [
      path.basename(diagnostic.file?.fileName ?? ""),
      diagnostic.code,
    ]),
    [["caller.mjs", 2554]]
  );
});

/** JS 검사 설정을 둔 표본 저장소. `configs`는 { 설정 경로: include }, `files`는 표본 JS 경로다. */
function sampleRepository(context, configs, files) {
  const folder = mkdtempSync(path.join(tmpdir(), "typecheck-js-owners-"));
  context.after(() => removeFolder(folder));
  git(folder, "init", "-q");
  for (const [config, include] of Object.entries(configs)) {
    mkdirSync(path.join(folder, path.dirname(config)), { recursive: true });
    writeFileSync(
      path.join(folder, config),
      JSON.stringify({
        compilerOptions: { allowJs: true, checkJs: true, noEmit: true },
        include,
      })
    );
  }
  for (const file of files) {
    mkdirSync(path.join(folder, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(folder, file), "export const a = 1;\n");
  }
  return folder;
}

// 파일마다 소속 설정 수를 센다. 두 설정에 든 파일을 한 집합으로 합치면 "들었음"으로 통과하지만, 같은 오류를 두 번 알리고 두 설정 중
// 어느 쪽 옵션으로 검사되는지 정해지지 않는다(#286 항목 28).
test("reports a JS file that two JS checking configs both include", (context) => {
  const folder = sampleRepository(
    context,
    { "tsconfig.json": ["**/*"], "tools/tsconfig.json": ["**/*"] },
    ["tools/shared.mjs", "alone.mjs"]
  );
  assert.deepEqual(ownershipProblems(folder), [
    "tools/shared.mjs: 2 JS checking tsconfigs include it (tools/tsconfig.json, tsconfig.json)",
  ]);
});

// TypeScript는 한 폴더에서 확장자만 다른 같은 이름의 JS 중 하나만 프로그램에 넣는다. 빠진 쪽은 어느 설정에도 들지 않은 파일로 잡는다.
test("reports the JS file TypeScript leaves out beside a same-named JS file of another format", (context) => {
  const folder = sampleRepository(context, { "tsconfig.json": ["**/*"] }, [
    "ui/sample.js",
    "ui/sample.jsx",
  ]);
  const problems = ownershipProblems(folder);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(
    problems[0] ?? "",
    /^ui\/sample\.jsx?: no JS checking tsconfig includes it \(TypeScript keeps one of ui\/sample\.js, ui\/sample\.jsx\)$/
  );
});
