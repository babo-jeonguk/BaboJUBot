import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import productRules from "./scripts/eslint-product-rules.mjs";
import testRules from "./scripts/eslint-test-rules.mjs";
import { testFiles } from "./scripts/test-files.mjs";

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

// 제품 코드: 앱·패키지의 src에서 시험 코드를 뺀 곳. 타입 정보로 검사하는 범위와 같다. 화면 파일(.tsx)도 같은 규칙을 받는다.
const productFiles = [
  "apps/*/src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
];

// runtime에서 프로그램을 직접 띄워도 되는 파일. 그 밖의 연결 코드는 process.ts의 실행 함수를 거친다.
const processOwners = [
  "process.ts", // startProcess·runProbe: 환경 작성과 입력·시작 오류·종료를 맡는 공용 실행
  "container.ts", // docker 클라이언트 호출과 격리 확인
  "job-object.ts", // Windows 묶음 실행기
  "recovery.ts", // 서버 재시작 뒤 남은 프로그램 조회·정리
  "lease.ts", // 실행 칸을 쥔 프로그램 조회
  "antigravity-config.ts", // 빈 환경으로 도는 Antigravity 설정 스크립트
  "login.ts", // 사용자 터미널을 그대로 넘기는 대화형 로그인
].map((name) => `packages/runtime/src/providers/${name}`);
const launchers = ["child_process", "node:child_process", "cross-spawn"];
const launchMessage =
  "runtime의 프로그램 실행은 providers/process.ts의 startProcess(실행 시도)·runProbe(확인 명령)로 합니다. 이 함수들이 providerEnvironment로 격리 실행의 환경을 만들고, 입력·시작 오류와 종료를 처리합니다. 전용 실행이 꼭 필요하면 eslint.config.js의 processOwners에 이유와 함께 올립니다.";

// import 검사를 거치지 않고 모듈을 불러오는 길. 이름 그대로 가져오기·바꿔 가져오기·모듈 객체에서 읽기·구조 분해를 모두 본다.
const moduleLoaders = "/^(createRequire|getBuiltinModule)$/";
const loaderMessage = `createRequire·process.getBuiltinModule은 import 검사를 거치지 않고 모듈을 불러오므로 child_process 금지를 피합니다. 패키지는 import로 가져오세요. ${launchMessage}`;
const computedImportMessage = `계산한 경로·template literal의 dynamic import는 무엇을 가져오는지 lint가 볼 수 없어 child_process 금지를 피합니다. 경로를 문자열 그대로 적으세요(\`await import("./claude.ts")\`). ${launchMessage}`;

const standards = "CODING_STANDARDS.md#정리";
// rm·rmSync는 recursive일 때만 폴더를 지운다(파일 지우기는 허용). rmdir·rmdirSync는 옵션 없이도 빈 폴더를 지운다.
const removers = "/^(rm|rmSync|rmdir|rmdirSync)$/";
const recursiveRemovers = "/^(rm|rmSync)$/";
const folderRemovers = "/^(rmdir|rmdirSync)$/";
const removeFolderMessage = `시험의 폴더 지우기는 removeFolder(@babojubot/runtime/remove-folder)로 합니다. 폴더 안에서 돈 프로그램의 종료와 stdio 닫힘을 먼저 기다린 뒤 부르세요. Windows의 일시적인 잠김만 정해진 횟수 다시 시도합니다. ${standards}`;

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
    // lint 예외는 이유를 적고(`-- 이유`), 규칙을 이름으로 고르며, 더는 필요 없으면 지운다.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    plugins: comments.recommended.plugins,
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
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
    files: testFiles,
    plugins: { tests: testRules },
    rules: {
      "tests/no-cleanup-in-finally": "error",
      "tests/no-elapsed-time-assertion": "error",
      "tests/no-expected-failure": "error",
      "tests/no-fixed-time-wait": "error",
      "tests/no-ignored-close-error": "error",
      "tests/no-ignored-kill-error": "error",
      "tests/no-skipped-cleanup": "error",
      "tests/no-state-between-tests": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: `CallExpression[callee.name=${recursiveRemovers}] > ObjectExpression.arguments > Property[key.name='recursive']`,
          message: removeFolderMessage,
        },
        {
          selector: `CallExpression[callee.property.name=${recursiveRemovers}] > ObjectExpression.arguments > Property[key.name='recursive']`,
          message: removeFolderMessage,
        },
        {
          selector: `CallExpression[callee.name=${folderRemovers}], CallExpression[callee.property.name=${folderRemovers}]`,
          message: removeFolderMessage,
        },
        {
          selector: `ImportDeclaration[source.value=/^(node:)?fs(\\/promises)?$/] > ImportSpecifier[imported.name=${removers}][local.name!=${removers}]`,
          message: `fs의 지우기 함수 이름을 바꿔 가져오면 폴더 지우기 검사를 피합니다. 이름 그대로 가져오세요. ${removeFolderMessage}`,
        },
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
    files: ["apps/web/e2e/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tests: testRules },
    rules: { "tests/no-page-wide-locator": "error" },
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
        projectService: true,
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
    files: ["apps/server/src/**/*.{ts,tsx}"],
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
    // 바깥 데이터(JSON.parse, 외부 프로그램 출력)는 unknown으로 받아 모양을 확인하거나 스키마로 읽은 뒤 쓴다.
    // 객체 리터럴은 `as`로 타입을 우기지 않고 선언하거나 `satisfies`로 맞춘다. 느슨한 비교는 `== null`만 쓴다.
    // 이 규칙들은 `as`를 붙인 값은 보지 않는다. `as`는 라이브러리 선언이 any로 비운 값이나 저장 때 보장한 짝처럼
    // 실제 타입을 아는 자리에만 쓴다. JSON.parse·응답 본문에 바로 붙인 단정은 product 규칙이 막고,
    // 타입 없는 중간 변수를 거친 단정은 잡지 못하므로 리뷰가 본다.
    // 시작한 Promise의 실패는 기다리거나 받고, 결과를 기다리지 않을 때는 `void`로 드러낸다. 폐기 예정 기능은 쓰지 않는다.
    // 외부 프로그램을 동기로 띄우면 끝날 때까지 서버 전체가 멈추므로, 동기 실행은 옵션 객체에 timeout을 둘 때만 쓴다.
    // 오류는 받아 검사하거나 다시 던진다. 버려야 하면 왜 버리는지 이름 붙은 함수(contracts의 failure.ts)로 드러낸다.
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
    // 격리 실행의 환경과 오류 처리를 한 곳이 맡도록, runtime은 정해진 파일에서만 프로그램을 띄운다.
    // child_process와 runtime이 의존하는 cross-spawn의 정적 import·re-export·문자열 dynamic import를 막는다.
    // 이 검사를 피하는 길(계산한 경로·template literal의 import, createRequire, process.getBuiltinModule)도 막는다.
    files: ["packages/runtime/src/**/*.{ts,tsx}"],
    ignores: [...testFiles, ...processOwners],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: launchers.map((name) => ({
            name,
            allowTypeImports: true,
            message: launchMessage,
          })),
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.value=/^((node:)?child_process|cross-spawn)$/]",
          message: launchMessage,
        },
        {
          // 문자열이 아닌 경로. 문자열 경로는 위 규칙과 no-restricted-imports가 본다.
          selector: "ImportExpression:not([source.type='Literal'])",
          message: computedImportMessage,
        },
        {
          selector: [
            `ImportSpecifier[imported.name=${moduleLoaders}]`,
            `ExportSpecifier[local.name=${moduleLoaders}]`,
            `MemberExpression[property.name=${moduleLoaders}]`,
            `MemberExpression[property.value=${moduleLoaders}]`,
            `ObjectPattern > Property[key.name=${moduleLoaders}]`,
          ].join(", "),
          message: loaderMessage,
        },
      ],
    },
  },
  {
    // 테스트는 응답 JSON을 그대로 다룬다.
    files: ["**/test/**", "**/*.test.ts"],
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
