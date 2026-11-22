// 저장소의 모든 JS가 타입 검사를 받는지(#270 PR 3a). JS 검사(checkJs)를 켠 tsconfig 중 하나에 들지 않은 JS는 lint만 받고, 공용 함수에
// 인수를 잘못 넘겨도 실행해야 드러난다(#272).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import {
  diagnosticsOf,
  isJavaScript,
  javaScriptConfigs,
} from "./typecheck-js.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
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
  const checked = new Set(
    javaScriptConfigs().flatMap(({ parsed }) =>
      parsed.fileNames.map((file) =>
        path.relative(root, file).replaceAll("\\", "/")
      )
    )
  );
  assert.deepEqual(
    javaScript.filter((file) => !checked.has(file)),
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

test("pnpm typecheck runs the JS check", () => {
  const { scripts } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  assert.equal(scripts["typecheck:js"], "node scripts/typecheck-js.mjs");
  assert.equal(
    scripts.typecheck,
    "pnpm -r --if-present run typecheck && pnpm run typecheck:js"
  );
});
