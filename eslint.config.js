import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

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

// 시험 코드: 시험 파일과 시험 폴더, src 안의 시험 도움 파일. 시험 전용 규칙은 이 범위에 건다.
// 외부 프로그램을 흉내 내는 가짜 CLI(`*/test-fixtures/`)와 손으로 돌리는 스크립트(`scripts/live/` 등)는 시험 코드가 아니다.
const testFiles = [
  "**/*.test.{ts,tsx,mts,mjs,js}",
  "**/*.spec.{ts,tsx}",
  "apps/web/e2e/**",
  "apps/web/test/**",
  "apps/server/test/**",
  "packages/runtime/src/testing.ts",
  "packages/runtime/src/providers/{test-support,test-folders,*-support}.ts",
  "packages/db/src/{testing,test-cluster}.ts",
];

const standards = "CODING_STANDARDS.md#정리";
// rm·rmSync는 recursive일 때만 폴더를 지운다(파일 지우기는 허용). rmdir·rmdirSync는 옵션 없이도 빈 폴더를 지운다.
const removers = "/^(rm|rmSync|rmdir|rmdirSync)$/";
const recursiveRemovers = "/^(rm|rmSync)$/";
const folderRemovers = "/^(rmdir|rmdirSync)$/";
const removeFolderMessage = `시험의 폴더 지우기는 removeFolder(@babojubot/runtime/remove-folder)로 합니다. 폴더 안에서 돈 프로그램의 종료와 stdio 닫힘을 먼저 기다린 뒤 부르세요. Windows의 일시적인 잠김만 정해진 횟수 다시 시도합니다. ${standards}`;

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
    files: testFiles,
    rules: {
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
      ],
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
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
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
    files: ["apps/server/src/**/*.ts"],
    ignores: [
      "apps/server/src/after-commit.ts",
      "apps/server/src/dispatcher.ts",
      "apps/server/src/readiness.ts",
      "**/*.test.ts",
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
              message: "contracts는 zod 스키마만 담습니다.",
            },
          ],
        },
      ],
    },
  },
]);
