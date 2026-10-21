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
