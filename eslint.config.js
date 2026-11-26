import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import { globSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import productRules from "./scripts/eslint-product-rules.mjs";
import testRules from "./scripts/eslint-test-rules.mjs";
import {
  codeFormats,
  testFiles,
  typeScriptFormatNames,
} from "./scripts/test-files.mjs";

// 도메인 규칙과 seam 계약은 프레임워크·DB·화면에 의존하지 않는다(docs/architecture.md 패키지 구성).
const framework = [
  "express",
  "ws",
  "pg",
  "drizzle-orm",
  "drizzle-orm/*",
  "embedded-postgres",
  "react",
  "react-dom",
  "@tanstack/*",
  "@radix-ui/*",
];

// 제품 코드: 앱·패키지의 src에서 시험 코드를 뺀 곳. 타입 정보로 검사하는 범위와 같다. 형식(화면 파일 .tsx, JS 포함)과 상관없이 같은 규칙을 받는다.
const productFiles = [
  `apps/*/src/**/*.${codeFormats}`,
  `packages/*/src/**/*.${codeFormats}`,
];
// 개발 스크립트: 사람과 CI가 돌리는 scripts 아래 파일과 agent가 직접 돌리는 도구 스크립트(.agents의 scripts)에서 시험 코드를
// 뺀 곳. 시험이 부르는 가짜 프로그램(`test-fixtures`)과 일부러 실패하는 시험 묶음(`scripts/fixtures`)은 시험 쪽이다.
// 타입 정보는 각 폴더의 tsconfig.json(allowJs)으로 얻는다.
const scriptFiles = [
  `scripts/**/*.${codeFormats}`,
  `.agents/scripts/*.${codeFormats}`,
  `.agents/skills/*/scripts/*.${codeFormats}`,
];
// 타입 정보는 디스크에 있는 파일에만 생긴다. lint 시험이 lintText로 넣는 없는 경로는 타입 정보 없는 규칙만 받는다.
const scriptsOnDisk = globSync(scriptFiles, { cwd: import.meta.dirname });
const scriptIgnores = [
  ...testFiles,
  "**/test-fixtures/**",
  "scripts/fixtures/**",
];

// 타입 정보로 검사하는 시험 코드: 디스크에 있는 시험 파일(폴더 glob이 잡는 폴더는 뺀다). 모든 형식이 그 폴더의 가장 가까운
// tsconfig.json(JS는 tsconfig.base.json의 allowJs) 프로그램에 들어 타입 정보를 얻는다(scripts/lint-scope.test.mjs가 형식마다 확인).
// globSync는 점으로 시작하는 폴더를 `**`로 찾지 않아 .agents를 따로 적는다.
const codeFile = new RegExp(
  `\\.(${codeFormats.slice(1, -1).replaceAll(",", "|")})$`
);
const typedTestFiles = globSync(
  [...testFiles, `.agents/**/*.{test,spec}.${codeFormats}`],
  {
    cwd: import.meta.dirname,
    exclude: (entry) => /(^|[\\/])node_modules$/.test(entry),
  }
).filter((file) => codeFile.test(file));
// 타입 정보를 만드는 project service는 lint 실행 하나에 하나뿐이어서 처음 만든 설정을 모두 같이 쓴다. 그래서 타입 정보를 쓰는
// 설정은 모두 이 값을 넘긴다. 어느 프로젝트에도 들지 않는 파일을 받아 줄 기본 프로젝트 목록은 두지 않는다.
const projectService = true;

// runtime에서 프로그램을 직접 띄워도 되는 파일. 그 밖의 연결 코드는 process.ts의 실행 함수(startProcess·runProbe)를 거치고,
// 그 함수들은 공용 실행(@babojubot/process의 launchTree·runTree)으로 띄운다.
const processOwners = [
  "container.ts", // docker 클라이언트 호출과 격리 확인
  "recovery.ts", // 서버 재시작 뒤 남은 프로그램 조회·정리
  "login.ts", // 사용자 터미널을 그대로 넘기는 대화형 로그인
].map((name) => `packages/runtime/src/providers/${name}`);
// 프로세스 패키지(@babojubot/process)에서 프로그램을 직접 띄워도 되는 파일. 공용 실행과, 그 위에 놓을 수 없는 실행이다.
// 그 밖의 파일(표식 조회 등)은 이 파일들의 함수로 띄운다.
const processPackageOwners = [
  "supervised.ts", // 감독 실행기 아래의 트리: 실행 시도(launch.ts)와 준비의 시험 실행(supervisor.ts)이 같이 띄우고 끈다
  "bounded-command.ts", // 공용 실행 위에 놓을 수 없는 짧은 명령: 시한에 SIGKILL과 끝 보장
  "ps.ts", // ps 한 칸 조회: "대상 없음" 계약(출력 없이 1)을 한곳에 둔다
].map((name) => `packages/process/src/${name}`);
// 제품 코드·개발 스크립트에서 오래 도는 자식을 child_process·cross-spawn으로 직접 띄워도 되는 파일. 그 밖은 공용 실행
// (@babojubot/process)으로 띄운다(product/no-direct-launch). 위 두 목록은 공용 실행 자신과 그것이 서는 실행(짧은 명령, 감독 실행기,
// 복구 보조 명령, 대화형 로그인 등)이다. 그 밖은 공용 실행의 끄기가 맞지 않는 실행만 둔다.
const launchOwners = [
  ...processOwners,
  ...processPackageOwners,
  // 내장 Postgres는 pg_ctl이 띄운 데몬이 pg_ctl보다 오래 살아야 한다. 공용 실행의 끄기는 그 데몬까지 끄므로 맞지 않는다.
  // 데몬의 끄기는 pg_ctl stop과 잠금 파일·생성 신원 확인이 맡는다. pg_ctl의 기다림은 -t로 끝을 둔다.
  "packages/db/src/embedded.ts",
];
const runtimeLaunchMessage =
  "runtime의 프로그램 실행은 providers/process.ts의 startProcess(실행 시도)·runProbe(확인 명령)로 합니다. 호출자는 providerEnvironment로 격리 실행의 환경을 만들고, 이 함수들이 공용 실행(@babojubot/process의 launchTree·runTree)으로 띄워 입력·시작 오류와 종료를 처리하고 트리 전체를 끈 것을 확인합니다. 전용 실행이 꼭 필요하면 eslint.config.js의 processOwners에 이유와 함께 올립니다.";
const processPackageLaunchMessage =
  "@babojubot/process 안의 프로그램 실행은 launch.ts의 launchTree·runTree(띄우기와 그 트리의 끄기를 한 쌍으로)나, 공용 실행 위에 놓을 수 없는 짧은 명령이면 bounded-command.ts의 runCommand·boundChild(시한에 SIGKILL과 끝 보장)로 합니다. 전용 실행이 꼭 필요하면 eslint.config.js의 processPackageOwners에 이유와 함께 올립니다.";

// process의 getBuiltinModule은 import 검사를 거치지 않고 모듈을 불러온다. 이름 그대로 가져오기·읽기·구조 분해와 계산한 이름으로 읽기를 막는다.
const getBuiltinModule = "getBuiltinModule";

/**
 * 격리 실행의 환경과 오류 처리, 띄우기와 끄기의 짝을 한 곳이 맡도록, 패키지 안에서 정해진 파일(`owners`)만 프로그램을 띄운다.
 * child_process·cross-spawn과 node:module을 가져오는 자리는 product/launch-boundary가 공용 가져오기 판정(scripts/eslint-imports.mjs)으로
 * 본다(정적 import·re-export·문자열 dynamic import·require·TS import-equals). 이 검사를 피하는 문법(계산한 경로·template literal의
 * import, process.getBuiltinModule, process의 계산한 이름)도 막는다. `message`는 그 패키지에서 띄우는 길이다.
 * @returns {import("eslint").Linter.Config}
 */
function launchBoundary(files, owners, launchMessage) {
  return {
    files,
    ignores: [...testFiles, ...owners],
    plugins: { product: productRules },
    rules: {
      // 띄우는 모듈과 node:module을 가져오는 모든 자리(공용 가져오기 판정).
      "product/launch-boundary": ["error", { message: launchMessage }],
      // 가져오기 검사를 피하는 문법.
      "no-restricted-syntax": [
        "error",
        {
          // 문자열이 아닌 경로. 문자열 경로는 product/launch-boundary가 본다.
          selector: "ImportExpression:not([source.type='Literal'])",
          message: `계산한 경로·template literal의 dynamic import는 무엇을 가져오는지 lint가 볼 수 없어 child_process 금지를 피합니다. 경로를 문자열 그대로 적으세요(\`await import("./claude.ts")\`). ${launchMessage}`,
        },
        {
          selector: [
            `ImportSpecifier[imported.name='${getBuiltinModule}']`,
            `ExportSpecifier[local.name='${getBuiltinModule}']`,
            `MemberExpression[property.name='${getBuiltinModule}']`,
            `MemberExpression[property.value='${getBuiltinModule}']`,
            `ObjectPattern > Property[key.name='${getBuiltinModule}']`,
          ].join(", "),
          message: `process.getBuiltinModule은 import 검사를 거치지 않고 모듈을 불러오므로 child_process 금지를 피합니다. 패키지는 import로 가져오세요. ${launchMessage}`,
        },
        {
          // process[name]·globalThis.process[name]. 이름을 그대로 적은 읽기와 process.env[name]은 보지 않는다.
          selector:
            "MemberExpression[computed=true]:not([property.type='Literal']):matches([object.name='process'], [object.object.name='globalThis'][object.property.name='process'])",
          message: `process의 속성을 계산한 이름으로 읽으면 getBuiltinModule 같은 모듈 불러오기를 lint가 볼 수 없습니다. 속성 이름을 그대로 적으세요(process.env[name]처럼 그 안의 값은 그대로 읽습니다). ${launchMessage}`,
        },
      ],
    },
  };
}

// 다른 영역이 runtime·프로세스 패키지에서 가져와도 되는 입구(product/package-import-scope, #266). 그룹 끄기·표식 정리 입구
// (@babojubot/process/recovery)는 어느 목록에도 없다: runtime의 재시작 복구(providers/recovery.ts)만 쓰고 그 파일은 이 규칙 밖이다.
const dbScopeWhy =
  "db(Control Plane)가 프로바이더 adapter 패키지(runtime)에 기대면 저장소가 실행 계층에 묶입니다.";
const processEntries = {
  // 제품 코드: 공용 실행·짧은 명령·시계·감독 실행기 준비와 폴더 지우기.
  product: ["@babojubot/process", "@babojubot/process/remove-folder"],
  // 개발 스크립트: 제품 코드의 입구와, 사고 재현 스크립트가 쓰는 프로세스 확인·정리.
  scripts: [
    "@babojubot/process",
    "@babojubot/process/remove-folder",
    "@babojubot/process/test-cleanup",
  ],
  // 시험 코드: 그 위에 시험 정리 도움(node:test에서도 쓰는 것과 vitest 전용), 바깥 환경 확인·시험 시계, 시험 준비.
  tests: [
    "@babojubot/process",
    "@babojubot/process/remove-folder",
    "@babojubot/process/test-cleanup",
    "@babojubot/process/lifelines",
    "@babojubot/process/testing",
    "@babojubot/process/test-support",
    "@babojubot/process/launcher-setup",
  ],
};

const standards = "CODING_STANDARDS.md#정리";
// rm·rmSync는 recursive일 때만 폴더를 지운다(파일 지우기는 허용). rmdir·rmdirSync는 옵션 없이도 빈 폴더를 지운다.
const removers = "/^(rm|rmSync|rmdir|rmdirSync)$/";
const recursiveRemovers = "/^(rm|rmSync)$/";
const folderRemovers = "/^(rmdir|rmdirSync)$/";
const removeFolderMessage = `시험의 폴더 지우기는 removeFolder(@babojubot/process/remove-folder)로 합니다. 폴더 안에서 돈 프로그램의 종료와 stdio 닫힘을 먼저 기다린 뒤 부르세요. Windows의 일시적인 잠김만 정해진 횟수 다시 시도합니다. ${standards}`;
const scriptRemoveFolderMessage = `스크립트의 폴더 지우기는 removeFolderWithin(@babojubot/process/test-cleanup)으로 합니다. 상한 안에서 지우고 Windows의 일시적인 잠김만 정해진 횟수 다시 시도합니다. 폴더 안에서 돈 프로그램의 끝을 확인한 뒤에만 부르세요. ${standards}`;
/**
 * 폴더 지우기를 막는 선택자들(시험과 스크립트가 함께 쓴다. 문구만 다르다): recursive `rm`·`rmSync`, `rmdir`·`rmdirSync`, fs에서 지우기
 * 함수를 다른 이름으로 가져오기.
 */
const folderRemovalRules = (message) => [
  {
    selector: `CallExpression[callee.name=${recursiveRemovers}] > ObjectExpression.arguments > Property[key.name='recursive']`,
    message,
  },
  {
    selector: `CallExpression[callee.property.name=${recursiveRemovers}] > ObjectExpression.arguments > Property[key.name='recursive']`,
    message,
  },
  {
    selector: `CallExpression[callee.name=${folderRemovers}], CallExpression[callee.property.name=${folderRemovers}]`,
    message,
  },
  {
    selector: `ImportDeclaration[source.value=/^(node:)?fs(\\/promises)?$/] > ImportSpecifier[imported.name=${removers}][local.name!=${removers}]`,
    message: `fs의 지우기 함수 이름을 바꿔 가져오면 폴더 지우기 검사를 피합니다. 이름 그대로 가져오세요. ${message}`,
  },
];

// 시험 데이터는 그 타입을 만족한다(CODING_STANDARDS.md#시험-데이터). 단언이 타입 검사를 끄는 두 모양을 막는다.
const assertions = ":matches(TSAsExpression, TSTypeAssertion)";
const fixtureAlternatives =
  "실제 값을 흉내 내는 데이터는 완전한 값으로 만들어 `satisfies T`나 타입 표기(`const x: T = …`)로 확인하고, 있는 가짜·builder(`fakeDeclarations`·`createScriptedRuntime` 등)를 재사용하세요. 진입점이 정말 일부 필드만 쓰면 그 매개변수 타입을 그 범위(`Pick<T, …>`)로 좁힙니다. CODING_STANDARDS.md#시험-데이터";

export default defineConfig([
  globalIgnores([
    ".babojubot/**",
    "**/node_modules/",
    "**/dist/",
    "**/test-results/",
    "**/playwright-report/",
    ".reference-cache/",
    ".worktrees/",
    ".scratch/",
    ".tmp/",
    "apps/prototype-dashboard-layout/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    // ESLint은 .js·.mjs·.cjs와 TypeScript 형식만 기본으로 검사한다. 모든 코드 형식(.jsx 포함)을 검사해, 그 형식의 시험(러너는 모은다)이
    // 규칙 밖에 남지 않게 한다.
    files: [`**/*.${codeFormats}`],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    // 주석은 lint 규칙을 바꾸지 못한다(#270). 주석 한 줄(`/* eslint 규칙: "off" */`, 끝을 닫지 않은 `/* eslint-disable */`)이면 파일 전체의
    // 위반이 사라지고, 주석의 설정은 설정 파일보다 우선해 막는 규칙까지 같은 주석으로 끌 수 있어서 주석의 설정을 아예 읽지 않는다.
    // 예외가 정말 필요하면 이 파일에 파일·규칙을 좁혀 이유와 함께 둔다. 효과 없는 지시 주석도 본보기로 베껴지지 않게 오류로 짚는다.
    linterOptions: { noInlineConfig: true },
    plugins: comments.recommended.plugins,
    rules: {
      "@eslint-community/eslint-comments/no-use": ["error", { allow: [] }],
    },
  },
  {
    // Playwright는 fixture의 첫 인자가 객체 분해여야 의존 fixture를 읽는다(`async ({}, use) => …`). 매개변수 자리의 빈 분해만 받는다.
    files: testFiles,
    rules: {
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
    },
  },
  {
    // 경로에 NUL이 없음을 뜻하는 정규식은 NUL을 일부러 담는다. 그 정규식 하나만 담은 파일에서만 no-control-regex를 끄고, 그 파일이
    // 그 선언 하나만 담는지는 product/nul-free-file-shape가 구문 트리로 막는다(예외가 다른 정규식을 덮지 않는다).
    files: ["packages/contracts/src/nul-free.ts"],
    plugins: { product: productRules },
    rules: {
      "no-control-regex": "off",
      "product/nul-free-file-shape": "error",
    },
  },
  {
    // git 경로 목록은 -z로 읽는다(#286 항목 31). 제품 코드·스크립트·agent 도구·시험 어디서든 줄 단위 목록은 특별한 이름을 다른 경로로 읽는다.
    files: [
      ...productFiles,
      ...scriptFiles,
      ...testFiles,
      `.agents/**/*.${codeFormats}`,
    ],
    plugins: { product: productRules },
    rules: { "product/git-path-list-nul": "error" },
  },
  {
    // check-test-exit-code.mjs가 vitest를 --globals로 돌려 넣는 이름(일부러 실패하는 시험).
    files: ["scripts/fixtures/test-exit-code/**"],
    languageOptions: { globals: globals.vitest },
  },
  {
    // 시험의 임시 폴더는 공용 정리 함수로만 지운다. 함수 이름을 바꿔 가져오면 이 검사를 피하므로 그것도 막는다.
    // 시험은 실제로 잰 경과 시간을 단언하지 않는다(CODING_STANDARDS.md#시간). 값이 변수를 거쳐 단언에 닿는지 따라가야 해서 규칙을 따로 둔다.
    // 시험은 정해진 시간만큼 잠들어 기다리지 않는다. 타이머 콜백이 Promise의 resolve만 부르는지 봐야 해서 규칙을 따로 둔다.
    // 시험의 finally는 정리를 기다리거나 던질 수 있는 동기 정리를 부르지 않는다(CODING_STANDARDS.md#정리). 함수 경계와 안쪽 try…catch를 봐야 해서 규칙을 따로 둔다.
    // 시험을 실패 예정으로 표시하지 않는다(CODING_STANDARDS.md#단언). 시험 함수 이름에 붙은 fail인지 봐야 해서 규칙을 따로 둔다.
    // 시험끼리 바깥 변수나 차례 묶기로 상태를 넘기지 않는다(CODING_STANDARDS.md#격리). 변수를 대입·읽는 시험 본문과 hook을 가려야 해서 규칙을 따로 둔다.
    // 공용 정리 hook은 앞 정리가 실패해도 뒤 정리를 한다(CODING_STANDARDS.md#정리). 기다림의 순서와 반복문·try를 봐야 해서 규칙을 따로 둔다.
    // process.kill의 실패는 오류 코드를 보고 넘긴다(CODING_STANDARDS.md#정리). catch가 받은 오류를 읽는지 봐야 해서 규칙을 따로 둔다.
    // Node 서버 닫기의 실패를 Promise 이행으로 버리지 않는다(CODING_STANDARDS.md#정리). close 콜백과 서버의 출처를 봐야 해서 규칙을 따로 둔다.
    // 시험은 process.env를 직접 바꾸지 않는다(CODING_STANDARDS.md#격리). 가져오기·구조 분해로 받은 env까지 출처를 따라가야 해서 규칙을 따로 둔다.
    // 시험은 기다리지 않는 Promise의 거절을 빈 처리기로 버리지 않는다(CODING_STANDARDS.md#단언). 처리기의 몸과 같은 Promise를 돌려주는지 봐야 해서 규칙을 따로 둔다.
    // awaitedLater로 표시한 Promise는 담아 두고 뒤에서 기다린다(CODING_STANDARDS.md#단언). 출처와 담은 바인딩의 기다림을 따라가야 해서 규칙을 따로 둔다.
    // 모듈 경계 대역은 시험이 바꿔 끼우는 모듈 칸(hoisted 값·모듈 let·그릇)을 불린 순간 잡는다(CODING_STANDARDS.md#정리). 칸의 별칭과 대역 함수의 await·콜백 위치를 봐야 해서 규칙을 따로 둔다.
    files: testFiles,
    plugins: { tests: testRules },
    rules: {
      "tests/no-cleanup-in-finally": "error",
      "tests/no-dropped-rejection": "error",
      "tests/no-unawaited-later": "error",
      "tests/no-elapsed-time-assertion": "error",
      "tests/no-expected-failure": "error",
      "tests/no-fixed-time-wait": "error",
      "tests/hoisted-state-at-call": "error",
      "tests/no-ignored-close-error": "error",
      "tests/no-ignored-kill-error": "error",
      "tests/no-process-env-change": "error",
      "tests/no-skipped-cleanup": "error",
      "tests/no-state-between-tests": "error",
      "no-restricted-syntax": [
        "error",
        ...folderRemovalRules(removeFolderMessage),
        {
          // `x as unknown as T`·`x as any as T`(꺾쇠 단언 포함).
          selector: `${assertions}[expression.type=/^(TSAsExpression|TSTypeAssertion)$/][expression.typeAnnotation.type=/^TS(Unknown|Any)Keyword$/]`,
          message: `unknown·any를 거친 이중 단언은 TypeScript가 두 타입이 겹치는지 보지 않게 해, T의 필수 필드가 빠지거나 T가 바뀌어도 타입 검사가 통과합니다. ${fixtureAlternatives} 있는 객체에 속성을 덧붙여 읽는 것이면 \`x as typeof x & { … }\` 한 번으로 씁니다.`,
        },
        {
          // `x as never`(꺾쇠 단언 포함). never는 어느 타입에도 들어가므로 모든 타입 검사를 끈다.
          selector: `${assertions}[typeAnnotation.type='TSNeverKeyword']`,
          message: `\`as never\`는 어느 타입 자리에도 들어가는 값을 만들어 그 자리의 타입 검사를 끕니다. 시험 경로가 쓰지 않는 의존성은 읽으면 이름과 함께 실패하는 대역(\`unused\`, apps/server/test/stand-ins.ts)으로 넣고, 타입이 막는 값을 일부러 넣는 시험은 그 필드에만 \`outsideContract\`를 쓰거나 저장된 데이터라면 SQL로 넣습니다. ${fixtureAlternatives}`,
        },
        {
          // `{ … } as T`. `as const`와 unknown·any로 바꾸는 단언은 데이터를 T로 주장하지 않으므로 보지 않는다. never는 위 규칙이 본다.
          selector: `${assertions}[expression.type='ObjectExpression']:not([typeAnnotation.type=/^TS(Unknown|Any|Never)Keyword$/]):not([typeAnnotation.typeName.name='const'])`,
          message: `객체 리터럴에 붙인 \`{ … } as T\`는 필드를 빠뜨리거나 T에 없는 필드를 넣어도 통과합니다. ${fixtureAlternatives}`,
        },
      ],
    },
  },
  {
    // E2E는 대상을 그 조직·대화·영역 안에서 찾는다(CODING_STANDARDS.md#화면). 페이지인지 타입으로 가려야 해서 타입 정보를 쓴다.
    // 화면 상태는 다시 시도하는 web-first 단언으로 확인한다(CODING_STANDARDS.md#화면). Playwright locator인지 타입으로 가린다.
    files: [`apps/web/e2e/**/*.${codeFormats}`],
    languageOptions: {
      parserOptions: {
        projectService,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tests: testRules },
    rules: {
      "tests/no-one-shot-ui-read": "error",
      "tests/no-page-wide-locator": "error",
    },
  },
  {
    // 시험 코드도 시작한 Promise를 기다리거나 받는다(CODING_STANDARDS.md#단언). 기다리지 않은 단언(Playwright의 `expect(…).toHaveText`,
    // `expect(…).resolves`)은 결과와 상관없이 통과하고, 버린 실패는 시험이 끝난 뒤 다른 시험에서 터진다. `void`로 버리는 것도 짚는다.
    // 비동기 함수를 반환값을 보지 않는 자리(이벤트 listener, `new Promise` executor)에 넘기면 그 실패가 버려지므로 그것도 막는다.
    // 타입 정보는 디스크에 있는 파일에만 생긴다. lint 시험이 lintText로 넣는 없는 경로는 이 규칙을 받지 않는다.
    // node:test의 `test`·`describe`가 돌려주는 Promise는 러너가 기다린다.
    files: typedTestFiles,
    languageOptions: {
      parserOptions: {
        projectService,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: false,
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "describe", "it", "suite"],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 계약의 union(깨우기 사유·이벤트·단계 등)에 값이 늘면 그 값을 다루지 않는 switch를 lint가 짚는다.
    files: productFiles,
    languageOptions: {
      parserOptions: {
        projectService,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    // commit 뒤 할 일(Event 알리기·취소·조직 재개·깨우기)은 저장 결과에 담아 applyAfterCommit 한 곳이 적용한다(#84).
    // 실행 시도 자체의 흐름은 dispatcher가, 저장과 상관없이 시작·끝나는 준비 확인 중 신호는 readiness가 맡는다.
    files: [`apps/server/src/**/*.${codeFormats}`],
    ignores: [
      "apps/server/src/after-commit.ts",
      "apps/server/src/dispatcher.ts",
      "apps/server/src/readiness.ts",
      ...testFiles,
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='hub'][callee.property.name=/^publish/]",
          message:
            "저장 결과의 commit 뒤 할 일로 담아 applyAfterCommit으로 알립니다.",
        },
        {
          selector:
            "CallExpression[callee.object.name='dispatcher'][callee.property.name=/^(cancel|kick|kickOrganization|kickProvider)$/]",
          message:
            "저장 결과의 commit 뒤 할 일로 담아 applyAfterCommit으로 적용합니다.",
        },
      ],
    },
  },
  {
    // 다른 쪽이 바꿀 수 있는 자리의 파일·폴더를 확인한 대상 그대로 여는 방식(O_NOFOLLOW·O_NONBLOCK 열기, dev·ino 대조)은
    // @babojubot/files만 정한다(#278). 그 패키지가 정하는 곳이라 범위에서 뺀다.
    files: productFiles,
    ignores: [...testFiles, "packages/files/src/**"],
    plugins: { product: productRules },
    rules: { "product/no-own-untrusted-open": "error" },
  },
  {
    // 바깥 데이터(JSON.parse, 외부 프로그램 출력)는 unknown으로 받아 모양을 확인하거나 스키마로 읽은 뒤 쓴다.
    // 객체 리터럴은 `as`로 타입을 우기지 않고 선언하거나 `satisfies`로 맞춘다. 느슨한 비교는 `== null`만 쓴다.
    // 이 규칙들은 `as`를 붙인 값은 보지 않는다. `as`는 라이브러리 선언이 any로 비운 값이나 저장 때 보장한 짝처럼
    // 실제 타입을 아는 자리에만 쓴다. JSON.parse·응답 본문에 바로 붙인 단정은 product 규칙이 막고,
    // 타입 없는 중간 변수를 거친 단정은 잡지 못하므로 리뷰가 본다.
    // 시작한 Promise의 실패는 기다리거나 받고, 결과를 기다리지 않을 때는 `void`로 드러낸다. 폐기 예정 기능은 쓰지 않는다.
    // 외부 프로그램을 동기로 띄우면 끝날 때까지 서버 전체가 멈추므로, 동기 실행은 옵션 객체에 timeout을 둘 때만 쓴다.
    // 오류는 받아 검사하거나 다시 던진다. 버려야 하면 왜 버리는지 이름 붙은 함수(contracts의 failure.ts)로 드러낸다.
    // `orIfUnreadable`은 동기 해석 한 단계만 감싼다. 콜백 안의 입출력은 확인 호출(`orIfProbeFailed`)이나 읽기(`orIfMissing`)로 꺼낸다.
    files: productFiles,
    ignores: testFiles,
    plugins: { product: productRules },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
      "product/no-assertion-on-parsed-data": "error",
      "product/sync-command-timeout": "error",
      "product/no-ignored-error": "error",
      "product/no-io-in-unreadable": "error",
      "product/no-silent-exit-status": "error",
      "product/no-check-then-reopen": "error",
      "product/no-server-not-running": "error",
      "product/no-absent-call-as-empty": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // 개발 스크립트도 폴더를 상한 안에서, 그 안에서 돈 프로그램의 끝을 확인한 뒤에만 지운다(CODING_STANDARDS.md#정리). 상한 없는
    // recursive rm이 매달리거나 끝을 확인하지 않은 폴더를 지우던 자리(chaos-live·chaos-run·chaos-server·boot-check, #286 PR 3b-3b-1)를
    // 고치고 막는다. 시험 파일은 위 시험 규칙이 removeFolder로 막는다.
    files: scriptFiles,
    ignores: scriptIgnores,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...folderRemovalRules(scriptRemoveFolderMessage),
      ],
    },
  },
  {
    // 개발 스크립트에도 제품 규칙 중 모양으로 판정하는 것과 타입 정보로 Promise를 보는 것을 건다(#255). 에이전트는 스크립트도
    // 본보기로 삼는다. 타입 표기가 없는 JS는 값이 모두 any라 no-unsafe-*는 뜻이 없고, 단언 규칙은 JS에 단언 문법이 없어 JS에는 걸지
    // 않는다(TypeScript로 옮긴 스크립트는 아래 설정이 건다).
    files: scriptFiles,
    ignores: scriptIgnores,
    plugins: { product: productRules },
    rules: {
      "product/sync-command-timeout": "error",
      "product/no-ignored-error": "error",
      "product/no-io-in-unreadable": "error",
      "product/no-silent-exit-status": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: scriptsOnDisk,
    ignores: scriptIgnores,
    languageOptions: {
      parserOptions: {
        projectService,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
    },
  },
  {
    // TypeScript로 옮긴 스크립트(#270 PR 3b)는 제품 코드처럼 바깥 데이터를 unknown으로 받아 모양을 확인한 뒤 쓰고, 타입을 `as`로
    // 우기지 않는다(위 제품 코드 설정과 같은 규칙).
    files: scriptsOnDisk.filter((file) =>
      typeScriptFormatNames.some((name) => file.endsWith(`.${name}`))
    ),
    ignores: scriptIgnores,
    plugins: { product: productRules },
    languageOptions: {
      parserOptions: {
        projectService,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "product/no-assertion-on-parsed-data": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
    },
  },
  {
    // 가져온 패키지는 그 코드가 속한 package.json에 선언한다. 제품 코드는 실행 의존성이어야 프로덕션 설치에서 깨지지 않는다(#264 리뷰 STD-2).
    files: productFiles,
    ignores: testFiles,
    plugins: { product: productRules },
    rules: { "product/no-undeclared-import": "error" },
  },
  {
    // 개발 스크립트와 시험은 devDependencies까지 받는다. 선언하지 않은 패키지만 막는다.
    files: [...scriptFiles, ...testFiles],
    ignores: ["**/test-fixtures/**", "scripts/fixtures/**"],
    plugins: { product: productRules },
    rules: { "product/no-undeclared-import": ["error", { allowDev: true }] },
  },
  {
    // finally·catch에서 서로 무관한 정리를 차례로 기다리면 앞 정리가 실패한 곳에서 뒤 정리를 건너뛴다(CODING_STANDARDS.md#제품-코드).
    // 시험의 공용 정리 hook 규칙과 같은 판정을 쓴다. 시험 코드는 시험 전용 정리 규칙이 본다.
    files: [...productFiles, ...scriptFiles],
    ignores: scriptIgnores,
    plugins: { product: productRules },
    rules: { "product/no-cleanup-chain": "error" },
  },
  {
    // 프로세스 그룹(음수 pid)에 신호를 보내지 않는다. 그룹을 끄는 일은 감독 실행기가, 생존 확인(신호 0)은 group.ts가 한다(CODING_STANDARDS.md#제품-코드).
    // 시험 코드는 이 범위에 아직 넣지 않았다.
    files: [...productFiles, ...scriptFiles],
    ignores: [...scriptIgnores, "packages/process/src/group.ts"],
    plugins: { product: productRules },
    rules: { "product/no-process-group-signal": "error" },
  },
  {
    // 오래 도는 자식은 띄우면서 그 트리의 끄기를 함께 돌려주는 공용 실행으로만 띄운다(CODING_STANDARDS.md#제품-코드, #262).
    // 직접 띄운 쪽이 끄기를 따로 짜면 Windows에서 아무것도 끄지 않거나 새 세션으로 나간 자식을 놓쳤다. 시험 코드는 아직 넣지 않았다.
    files: [...productFiles, ...scriptFiles],
    ignores: [...scriptIgnores, ...launchOwners],
    plugins: { product: productRules },
    rules: { "product/no-direct-launch": "error" },
  },
  {
    // 다른 workspace 패키지는 그 package.json exports의 입구로만, 패키지 이름으로 가져온다(#266). 제품 코드·개발 스크립트·시험·
    // 설정 모두. 같은 패키지 안의 상대 경로는 그대로다. 영역마다 어느 입구까지 받는지는 아래 package-import-scope가 좁힌다.
    files: [`**/*.${codeFormats}`],
    plugins: { product: productRules },
    rules: { "product/package-entry-only": "error" },
  },
  {
    // 계산한 키를 `in`으로 확인하지 않는다(#281 리뷰 REC-1). 물려받은 이름(constructor·toString)도 있다고 답해 허용 목록을
    // 지나가므로, 사전·허용 목록은 Map이나 Object.hasOwn으로 본다. 제품 코드·개발 스크립트·시험·가짜 프로그램·설정 모두.
    files: [`**/*.${codeFormats}`],
    plugins: { product: productRules },
    rules: { "product/no-computed-in": "error" },
  },
  {
    // 제품 코드는 runtime·프로세스 패키지·db에서 목록에 없는 입구를 가져오지 않는다(#266, docs/architecture.md 패키지 구성).
    // 시험 도움·개발 도구 입구도 가져오지 않는다. 입구는 대상 파일로 판정해 그 패키지 자신의 제품 코드가 자기 이름이나 상대
    // 경로로 입구 파일을 가져와도 같다(#266 리뷰 SPEC-6). db는 아래 설정이 따로 본다.
    files: productFiles,
    ignores: [
      ...testFiles,
      "packages/db/src/**",
      "packages/runtime/src/providers/recovery.ts",
    ],
    plugins: { product: productRules },
    rules: {
      "product/package-import-scope": [
        "error",
        {
          packages: {
            "@babojubot/runtime": ["@babojubot/runtime"],
            "@babojubot/process": processEntries.product,
            "@babojubot/db": ["@babojubot/db"],
            "@babojubot/files": ["@babojubot/files"],
          },
          why: "runtime·프로세스 바탕·파일 열기의 안쪽 파일이나 시험 도움에 기대면 그 패키지 안을 바꿀 때 함께 깨지고, 그 모양이 다른 영역으로 퍼집니다.",
        },
      ],
    },
  },
  {
    // db는 Control Plane이다(docs/architecture.md). 시험까지 프로바이더 adapter 패키지(runtime)에 기대지 않고, 프로세스 바탕은
    // 새 패키지에서 가져온다. 시험은 시험 정리 도움 입구까지, 제품 코드는 아래 설정이 제품 입구만 받는다.
    files: [`packages/db/**/*.${codeFormats}`],
    plugins: { product: productRules },
    rules: {
      "product/package-import-scope": [
        "error",
        {
          packages: {
            "@babojubot/runtime": [],
            "@babojubot/process": processEntries.tests,
          },
          why: dbScopeWhy,
        },
      ],
    },
  },
  {
    files: [`packages/db/src/**/*.${codeFormats}`],
    ignores: testFiles,
    plugins: { product: productRules },
    rules: {
      "product/package-import-scope": [
        "error",
        {
          packages: {
            "@babojubot/runtime": [],
            "@babojubot/process": processEntries.product,
            // 다른 제품 코드처럼 db 자신의 시험·개발 도구 입구(testing·test-cluster·admin)도 가져오지 않는다(입구 파일로 판정).
            "@babojubot/db": ["@babojubot/db"],
          },
          why: dbScopeWhy,
        },
      ],
    },
  },
  {
    // 개발 스크립트는 runtime의 제품 API(패키지 입구)와 프로세스 바탕의 입구만 가져온다.
    files: scriptFiles,
    ignores: scriptIgnores,
    plugins: { product: productRules },
    rules: {
      "product/package-import-scope": [
        "error",
        {
          packages: {
            "@babojubot/runtime": ["@babojubot/runtime"],
            "@babojubot/process": processEntries.scripts,
            // 사고 재현·실제 모델 시험은 DB를 직접 들여다본다(연결 하나 열기와 표 정의).
            "@babojubot/db": ["@babojubot/db", "@babojubot/db/admin"],
          },
          why: "runtime·프로세스 바탕의 내부 파일이나 다른 입구에 기대면 그 패키지 안을 바꿀 때 스크립트가 함께 깨지고, 그 모양이 다른 스크립트로 퍼집니다.",
        },
      ],
    },
  },
  {
    // 실패를 모으는 일은 failure.ts의 attemptAll·attemptEach·combinedFailure만 한다(CODING_STANDARDS.md#제품-코드). 제품 코드·개발 스크립트·시험 모두.
    files: [...productFiles, ...scriptFiles, ...testFiles],
    ignores: ["packages/contracts/src/failure.ts"],
    plugins: { product: productRules },
    rules: { "product/no-failure-collecting": "error" },
  },
  {
    // 실행 소유 파일의 짧은 명령도 시한에 끝을 보장한다(CODING_STANDARDS.md#제품-코드). Node의 timeout은 신호만 보내고 기다린다.
    files: launchOwners,
    plugins: { product: productRules },
    rules: { "product/bounded-command": "error" },
  },
  {
    // 번호(pid)로 신호를 보내는 일은 감독 실행기만 한다(CODING_STANDARDS.md#제품-코드, #268 PR 2). 실행기는 표식이나 시작 시각을
    // 확인한 그 프로세스에만 신호한다. 신호 0(생존 확인)은 짚지 않는다. 시험 코드와 개발 스크립트(실사용 시험 도구 포함)는 범위 밖이다.
    files: productFiles,
    ignores: testFiles,
    plugins: { product: productRules },
    rules: { "product/no-number-signal": "error" },
  },
  // runtime과 프로세스 패키지는 정해진 파일에서만 프로그램을 띄운다(위 launchBoundary).
  launchBoundary(
    [`packages/runtime/src/**/*.${codeFormats}`],
    processOwners,
    runtimeLaunchMessage
  ),
  launchBoundary(
    [`packages/process/src/**/*.${codeFormats}`],
    processPackageOwners,
    processPackageLaunchMessage
  ),
  {
    // 테스트는 응답 JSON을 그대로 다룬다.
    files: ["**/test/**", `**/*.test.${codeFormats}`],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["apps/web/src/**"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/core/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...framework, "@babojubot/db", "@babojubot/runtime"],
              message: "core는 도메인 규칙만 담습니다.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/contracts/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...framework, "@babojubot/*"],
              message:
                "contracts는 zod 스키마와 모든 패키지가 함께 쓰는 순수 함수만 담습니다.",
            },
          ],
        },
      ],
    },
  },
]);
