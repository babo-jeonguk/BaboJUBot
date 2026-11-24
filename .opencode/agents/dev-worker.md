---
description: Makes the parent's committed tests pass by changing the product code a written brief allows. Never edits tests or check settings, plans, reviews, commits, pushes, merges, or spawns agents.
mode: all
model: opencode-go/deepseek-v4.1-flash
steps: 60
permissions:
  - action: read
    resource: "*"
    effect: allow
  - action: read
    resource: ".env*"
    effect: deny
  - action: read
    resource: "**/.env*"
    effect: deny
  - action: edit
    resource: "*"
    effect: allow
  # Test helpers the test scope (scripts/test-files.mjs testFiles) names in a package's src. `*` also crosses `/`,
  # so after each folder's helper denials an allow reopens everything below that folder (`<folder>/*/*`): files in sub
  # folders, and folders whose names start with a helper's name (`runtime-contract.schema/index.ts`), are product code.
  # A sub folder's own helper denials come after that allow. The denials below (secrets, test files, settings) come
  # later and still win everywhere.
  - action: edit
    resource: "*packages/runtime/src/testing.*"
    effect: deny
  - action: edit
    resource: "*packages/runtime/src/runtime-contract.*"
    effect: deny
  - action: edit
    resource: "*packages/runtime/src/*/*"
    effect: allow
  - action: edit
    resource: "*packages/runtime/src/providers/test-folders.*"
    effect: deny
  - action: edit
    resource: "*packages/runtime/src/providers/*-support.*"
    effect: deny
  - action: edit
    resource: "*packages/runtime/src/providers/*/*"
    effect: allow
  - action: edit
    resource: "*packages/process/src/testing.*"
    effect: deny
  - action: edit
    resource: "*packages/process/src/test-cleanup.*"
    effect: deny
  - action: edit
    resource: "*packages/process/src/test-folders.*"
    effect: deny
  - action: edit
    resource: "*packages/process/src/*-support.*"
    effect: deny
  - action: edit
    resource: "*packages/process/src/*/*"
    effect: allow
  - action: edit
    resource: "*packages/db/src/testing.*"
    effect: deny
  - action: edit
    resource: "*packages/db/src/test-cluster.*"
    effect: deny
  - action: edit
    resource: "*packages/db/src/*/*"
    effect: allow
  # Check settings by the names their tools read, and whole settings folders. Generated from the definition in
  # .agents/scripts/protected-files.ts (`node .agents/scripts/protected-files.ts`); worker-permissions.test.ts keeps it
  # equal. OpenCode's `*` crosses `/`, so names are exact where the tools read exact names, and where a name holds a `*`
  # the folders it could reach into are reopened and the real settings below them denied again. Secrets and test files
  # are denied after this block and still win below a reopened folder.
  # BEGIN generated check settings
  - action: edit
    resource: "vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*/vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*/playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*tsconfig*.json"
    effect: deny
  - action: edit
    resource: "vitest.*/*"
    effect: allow
  - action: edit
    resource: "*/vitest.*/*"
    effect: allow
  - action: edit
    resource: "playwright.*/*"
    effect: allow
  - action: edit
    resource: "*/playwright.*/*"
    effect: allow
  - action: edit
    resource: "*tsconfig*/*"
    effect: allow
  - action: edit
    resource: "eslint.config.ts"
    effect: deny
  - action: edit
    resource: "*/eslint.config.ts"
    effect: deny
  - action: edit
    resource: "eslint.config.mts"
    effect: deny
  - action: edit
    resource: "*/eslint.config.mts"
    effect: deny
  - action: edit
    resource: "eslint.config.cts"
    effect: deny
  - action: edit
    resource: "*/eslint.config.cts"
    effect: deny
  - action: edit
    resource: "eslint.config.js"
    effect: deny
  - action: edit
    resource: "*/eslint.config.js"
    effect: deny
  - action: edit
    resource: "eslint.config.mjs"
    effect: deny
  - action: edit
    resource: "*/eslint.config.mjs"
    effect: deny
  - action: edit
    resource: "eslint.config.cjs"
    effect: deny
  - action: edit
    resource: "*/eslint.config.cjs"
    effect: deny
  - action: edit
    resource: "vitest.config.ts"
    effect: deny
  - action: edit
    resource: "*/vitest.config.ts"
    effect: deny
  - action: edit
    resource: "vitest.config.tsx"
    effect: deny
  - action: edit
    resource: "*/vitest.config.tsx"
    effect: deny
  - action: edit
    resource: "vitest.config.mts"
    effect: deny
  - action: edit
    resource: "*/vitest.config.mts"
    effect: deny
  - action: edit
    resource: "vitest.config.cts"
    effect: deny
  - action: edit
    resource: "*/vitest.config.cts"
    effect: deny
  - action: edit
    resource: "vitest.config.js"
    effect: deny
  - action: edit
    resource: "*/vitest.config.js"
    effect: deny
  - action: edit
    resource: "vitest.config.jsx"
    effect: deny
  - action: edit
    resource: "*/vitest.config.jsx"
    effect: deny
  - action: edit
    resource: "vitest.config.mjs"
    effect: deny
  - action: edit
    resource: "*/vitest.config.mjs"
    effect: deny
  - action: edit
    resource: "vitest.config.cjs"
    effect: deny
  - action: edit
    resource: "*/vitest.config.cjs"
    effect: deny
  - action: edit
    resource: "vitest.workspace.ts"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.ts"
    effect: deny
  - action: edit
    resource: "vitest.workspace.tsx"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.tsx"
    effect: deny
  - action: edit
    resource: "vitest.workspace.mts"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.mts"
    effect: deny
  - action: edit
    resource: "vitest.workspace.cts"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.cts"
    effect: deny
  - action: edit
    resource: "vitest.workspace.js"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.js"
    effect: deny
  - action: edit
    resource: "vitest.workspace.jsx"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.jsx"
    effect: deny
  - action: edit
    resource: "vitest.workspace.mjs"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.mjs"
    effect: deny
  - action: edit
    resource: "vitest.workspace.cjs"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.cjs"
    effect: deny
  - action: edit
    resource: "vitest.workspace.json"
    effect: deny
  - action: edit
    resource: "*/vitest.workspace.json"
    effect: deny
  - action: edit
    resource: "vite.config.ts"
    effect: deny
  - action: edit
    resource: "*/vite.config.ts"
    effect: deny
  - action: edit
    resource: "vite.config.mts"
    effect: deny
  - action: edit
    resource: "*/vite.config.mts"
    effect: deny
  - action: edit
    resource: "vite.config.cts"
    effect: deny
  - action: edit
    resource: "*/vite.config.cts"
    effect: deny
  - action: edit
    resource: "vite.config.js"
    effect: deny
  - action: edit
    resource: "*/vite.config.js"
    effect: deny
  - action: edit
    resource: "vite.config.mjs"
    effect: deny
  - action: edit
    resource: "*/vite.config.mjs"
    effect: deny
  - action: edit
    resource: "vite.config.cjs"
    effect: deny
  - action: edit
    resource: "*/vite.config.cjs"
    effect: deny
  - action: edit
    resource: "playwright.config.ts"
    effect: deny
  - action: edit
    resource: "*/playwright.config.ts"
    effect: deny
  - action: edit
    resource: "playwright.config.tsx"
    effect: deny
  - action: edit
    resource: "*/playwright.config.tsx"
    effect: deny
  - action: edit
    resource: "playwright.config.mts"
    effect: deny
  - action: edit
    resource: "*/playwright.config.mts"
    effect: deny
  - action: edit
    resource: "playwright.config.cts"
    effect: deny
  - action: edit
    resource: "*/playwright.config.cts"
    effect: deny
  - action: edit
    resource: "playwright.config.js"
    effect: deny
  - action: edit
    resource: "*/playwright.config.js"
    effect: deny
  - action: edit
    resource: "playwright.config.jsx"
    effect: deny
  - action: edit
    resource: "*/playwright.config.jsx"
    effect: deny
  - action: edit
    resource: "playwright.config.mjs"
    effect: deny
  - action: edit
    resource: "*/playwright.config.mjs"
    effect: deny
  - action: edit
    resource: "playwright.config.cjs"
    effect: deny
  - action: edit
    resource: "*/playwright.config.cjs"
    effect: deny
  - action: edit
    resource: ".prettierrc"
    effect: deny
  - action: edit
    resource: "*/.prettierrc"
    effect: deny
  - action: edit
    resource: ".prettierrc.json"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.json"
    effect: deny
  - action: edit
    resource: ".prettierrc.yml"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.yml"
    effect: deny
  - action: edit
    resource: ".prettierrc.yaml"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.yaml"
    effect: deny
  - action: edit
    resource: ".prettierrc.json5"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.json5"
    effect: deny
  - action: edit
    resource: ".prettierrc.toml"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.toml"
    effect: deny
  - action: edit
    resource: ".prettierrc.ts"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.ts"
    effect: deny
  - action: edit
    resource: ".prettierrc.mts"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.mts"
    effect: deny
  - action: edit
    resource: ".prettierrc.cts"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.cts"
    effect: deny
  - action: edit
    resource: ".prettierrc.js"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.js"
    effect: deny
  - action: edit
    resource: ".prettierrc.mjs"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.mjs"
    effect: deny
  - action: edit
    resource: ".prettierrc.cjs"
    effect: deny
  - action: edit
    resource: "*/.prettierrc.cjs"
    effect: deny
  - action: edit
    resource: "prettier.config.ts"
    effect: deny
  - action: edit
    resource: "*/prettier.config.ts"
    effect: deny
  - action: edit
    resource: "prettier.config.mts"
    effect: deny
  - action: edit
    resource: "*/prettier.config.mts"
    effect: deny
  - action: edit
    resource: "prettier.config.cts"
    effect: deny
  - action: edit
    resource: "*/prettier.config.cts"
    effect: deny
  - action: edit
    resource: "prettier.config.js"
    effect: deny
  - action: edit
    resource: "*/prettier.config.js"
    effect: deny
  - action: edit
    resource: "prettier.config.mjs"
    effect: deny
  - action: edit
    resource: "*/prettier.config.mjs"
    effect: deny
  - action: edit
    resource: "prettier.config.cjs"
    effect: deny
  - action: edit
    resource: "*/prettier.config.cjs"
    effect: deny
  - action: edit
    resource: ".prettierignore"
    effect: deny
  - action: edit
    resource: "*/.prettierignore"
    effect: deny
  - action: edit
    resource: ".lintstagedrc"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.json"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.json"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.yaml"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.yaml"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.yml"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.yml"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.ts"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.ts"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.mts"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.mts"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.cts"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.cts"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.js"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.js"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.mjs"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.mjs"
    effect: deny
  - action: edit
    resource: ".lintstagedrc.cjs"
    effect: deny
  - action: edit
    resource: "*/.lintstagedrc.cjs"
    effect: deny
  - action: edit
    resource: "lint-staged.config.ts"
    effect: deny
  - action: edit
    resource: "*/lint-staged.config.ts"
    effect: deny
  - action: edit
    resource: "lint-staged.config.mts"
    effect: deny
  - action: edit
    resource: "*/lint-staged.config.mts"
    effect: deny
  - action: edit
    resource: "lint-staged.config.cts"
    effect: deny
  - action: edit
    resource: "*/lint-staged.config.cts"
    effect: deny
  - action: edit
    resource: "lint-staged.config.js"
    effect: deny
  - action: edit
    resource: "*/lint-staged.config.js"
    effect: deny
  - action: edit
    resource: "lint-staged.config.mjs"
    effect: deny
  - action: edit
    resource: "*/lint-staged.config.mjs"
    effect: deny
  - action: edit
    resource: "lint-staged.config.cjs"
    effect: deny
  - action: edit
    resource: "*/lint-staged.config.cjs"
    effect: deny
  - action: edit
    resource: ".editorconfig"
    effect: deny
  - action: edit
    resource: "*/.editorconfig"
    effect: deny
  - action: edit
    resource: ".npmrc"
    effect: deny
  - action: edit
    resource: "*/.npmrc"
    effect: deny
  - action: edit
    resource: "package.json"
    effect: deny
  - action: edit
    resource: "*/package.json"
    effect: deny
  - action: edit
    resource: "pnpm-lock.yaml"
    effect: deny
  - action: edit
    resource: "*/pnpm-lock.yaml"
    effect: deny
  - action: edit
    resource: "pnpm-workspace.yaml"
    effect: deny
  - action: edit
    resource: "*/pnpm-workspace.yaml"
    effect: deny
  - action: edit
    resource: ".gitignore"
    effect: deny
  - action: edit
    resource: "*/.gitignore"
    effect: deny
  - action: edit
    resource: ".gitattributes"
    effect: deny
  - action: edit
    resource: "*/.gitattributes"
    effect: deny
  - action: edit
    resource: "paseo.json"
    effect: deny
  - action: edit
    resource: "*/paseo.json"
    effect: deny
  - action: edit
    resource: "apps/web/e2e/global-setup.ts"
    effect: deny
  - action: edit
    resource: "*/apps/web/e2e/global-setup.ts"
    effect: deny
  - action: edit
    resource: "apps/web/e2e/support/server-process.ts"
    effect: deny
  - action: edit
    resource: "*/apps/web/e2e/support/server-process.ts"
    effect: deny
  - action: edit
    resource: "packages/process/src/test-cleanup.ts"
    effect: deny
  - action: edit
    resource: "*/packages/process/src/test-cleanup.ts"
    effect: deny
  - action: edit
    resource: "packages/process/src/test-support.ts"
    effect: deny
  - action: edit
    resource: "*/packages/process/src/test-support.ts"
    effect: deny
  - action: edit
    resource: "scripts/eslint-imports.mjs"
    effect: deny
  - action: edit
    resource: "*/scripts/eslint-imports.mjs"
    effect: deny
  - action: edit
    resource: "scripts/eslint-product-rules.mjs"
    effect: deny
  - action: edit
    resource: "*/scripts/eslint-product-rules.mjs"
    effect: deny
  - action: edit
    resource: "scripts/eslint-test-rules.mjs"
    effect: deny
  - action: edit
    resource: "*/scripts/eslint-test-rules.mjs"
    effect: deny
  - action: edit
    resource: "scripts/package-exports.ts"
    effect: deny
  - action: edit
    resource: "*/scripts/package-exports.ts"
    effect: deny
  - action: edit
    resource: "scripts/test-files.mjs"
    effect: deny
  - action: edit
    resource: "*/scripts/test-files.mjs"
    effect: deny
  - action: edit
    resource: "scripts/test-suites.ts"
    effect: deny
  - action: edit
    resource: "*/scripts/test-suites.ts"
    effect: deny
  - action: edit
    resource: "vitest.reports.ts"
    effect: deny
  - action: edit
    resource: "*/vitest.reports.ts"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "vitest.*/*vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "vitest.*/*playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*/vitest.*/*playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "vitest.*/**tsconfig*.json"
    effect: deny
  - action: edit
    resource: "*/vitest.*/**tsconfig*.json"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "playwright.*/*vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "playwright.*/*playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*/playwright.*/*playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "playwright.*/**tsconfig*.json"
    effect: deny
  - action: edit
    resource: "*/playwright.*/**tsconfig*.json"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.ts"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.mts"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.cts"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.js"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*vitest.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.ts"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.tsx"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.mts"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.cts"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.js"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.jsx"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.mjs"
    effect: deny
  - action: edit
    resource: "*tsconfig*/*playwright.*.config.cjs"
    effect: deny
  - action: edit
    resource: "*tsconfig*/**tsconfig*.json"
    effect: deny
  - action: edit
    resource: ".github/*"
    effect: deny
  - action: edit
    resource: "*/.github/*"
    effect: deny
  - action: edit
    resource: ".husky/*"
    effect: deny
  - action: edit
    resource: "*/.husky/*"
    effect: deny
  - action: edit
    resource: ".agents/*"
    effect: deny
  - action: edit
    resource: "*/.agents/*"
    effect: deny
  - action: edit
    resource: ".opencode/*"
    effect: deny
  - action: edit
    resource: "*/.opencode/*"
    effect: deny
  - action: edit
    resource: ".claude/*"
    effect: deny
  - action: edit
    resource: "*/.claude/*"
    effect: deny
  - action: edit
    resource: "patches/*"
    effect: deny
  - action: edit
    resource: "*/patches/*"
    effect: deny
  - action: edit
    resource: "scripts/*"
    effect: deny
  - action: edit
    resource: "*/scripts/*"
    effect: deny
  # END generated check settings
  - action: edit
    resource: ".env*"
    effect: deny
  - action: edit
    resource: "**/.env*"
    effect: deny
  - action: edit
    resource: ".git/**"
    effect: deny
  - action: edit
    resource: ".reference-cache/**"
    effect: deny
  # Test files and test folders anywhere, and the test folders the test scope names.
  - action: edit
    resource: "*.test.*"
    effect: deny
  - action: edit
    resource: "*.spec.*"
    effect: deny
  - action: edit
    resource: "apps/server/test/*"
    effect: deny
  - action: edit
    resource: "*/apps/server/test/*"
    effect: deny
  - action: edit
    resource: "apps/web/test/*"
    effect: deny
  - action: edit
    resource: "*/apps/web/test/*"
    effect: deny
  - action: edit
    resource: "apps/web/e2e/*"
    effect: deny
  - action: edit
    resource: "*/apps/web/e2e/*"
    effect: deny
  - action: edit
    resource: "*/test-fixtures/*"
    effect: deny
  - action: edit
    resource: "*.md"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: shell
    resource: "pnpm --filter * exec vitest run *"
    effect: allow
  - action: shell
    resource: "pnpm --filter * run typecheck"
    effect: allow
  - action: shell
    resource: "pnpm --filter * run typecheck:src"
    effect: allow
  - action: shell
    resource: "pnpm --filter * run typecheck:test"
    effect: allow
  - action: shell
    resource: "pnpm verify:changed*"
    effect: allow
  - action: shell
    resource: "pnpm exec eslint *"
    effect: allow
  - action: shell
    resource: "pnpm exec eslint *--fix*"
    effect: deny
  - action: shell
    resource: "pnpm --filter * exec vitest run *--passWithNoTests*"
    effect: deny
  - action: shell
    resource: "pnpm --filter * exec vitest run *--config*"
    effect: deny
  - action: shell
    resource: "pnpm --filter * exec vitest run * -c *"
    effect: deny
  - action: shell
    resource: "pnpm --filter * exec vitest run *--exclude*"
    effect: deny
  - action: shell
    resource: "pnpm exec eslint *--config*"
    effect: deny
  - action: shell
    resource: "pnpm exec eslint * -c *"
    effect: deny
  - action: shell
    resource: "pnpm exec eslint *--no-config-lookup*"
    effect: deny
  - action: shell
    resource: "pnpm exec eslint *--rule*"
    effect: deny
  - action: shell
    resource: "pnpm exec eslint *--ignore-pattern*"
    effect: deny
  - action: shell
    resource: "pnpm exec eslint *--no-ignore*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: deny
  - action: websearch
    resource: "*"
    effect: deny
  - action: external_directory
    resource: "*"
    effect: deny
  - action: execute
    resource: "*"
    effect: deny
  - action: "opencode*"
    resource: "*"
    effect: deny
---

You are the development code worker for BaboJUBot.
Follow docs/agents/worker.md and the brief in the prompt.

- Edit only product files the brief allows. Never edit tests, check settings, docs, or dependencies, and do not choose design.
- Run the brief's test, typecheck, and lint commands yourself and keep fixing until they pass. Never weaken, skip, or disable a check.
- If a test looks wrong or passing needs a change outside the brief, stop and report.
- Run only those commands, exactly as written in the brief. Do not add pipes, redirects, or other commands; `pwd`, `ls`, and `git` are not allowed.
- Never commit, push, open a PR, merge, or spawn another agent.
- If the brief is ambiguous, a command is not allowed, or you are blocked, stop and report.
- Finish with: status, files changed, commands and results, unverified items, blockers.
