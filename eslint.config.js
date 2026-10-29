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

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/test-results/",
    "**/playwright-report/",
    ".reference-cache/",
    "apps/prototype-dashboard-layout/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
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
    // 실행 시도 자체의 흐름은 dispatcher가 맡는다.
    files: ["apps/server/src/**/*.ts"],
    ignores: [
      "apps/server/src/after-commit.ts",
      "apps/server/src/dispatcher.ts",
      "**/*.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='hub'][callee.property.name='publish']",
          message:
            "저장 결과의 commit 뒤 할 일로 담아 applyAfterCommit으로 알립니다.",
        },
        {
          selector:
            "CallExpression[callee.object.name='dispatcher'][callee.property.name=/^(cancel|kick|kickOrganization)$/]",
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
