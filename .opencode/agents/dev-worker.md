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
    resource: "*apps/server/test/*"
    effect: deny
  - action: edit
    resource: "*apps/web/test/*"
    effect: deny
  - action: edit
    resource: "*apps/web/e2e/*"
    effect: deny
  - action: edit
    resource: "*/test-fixtures/*"
    effect: deny
  - action: edit
    resource: "*eslint.config.*"
    effect: deny
  - action: edit
    resource: "*vitest*config*"
    effect: deny
  - action: edit
    resource: "*vite.config.*"
    effect: deny
  - action: edit
    resource: "*.prettierrc*"
    effect: deny
  - action: edit
    resource: "*.prettierignore"
    effect: deny
  - action: edit
    resource: "*.lintstagedrc*"
    effect: deny
  - action: edit
    resource: "*.editorconfig"
    effect: deny
  - action: edit
    resource: "*.npmrc"
    effect: deny
  - action: edit
    resource: "*.gitignore"
    effect: deny
  - action: edit
    resource: "*.gitattributes"
    effect: deny
  - action: edit
    resource: "*.claude/*"
    effect: deny
  - action: edit
    resource: "patches/*"
    effect: deny
  - action: edit
    resource: "*/patches/*"
    effect: deny
  - action: edit
    resource: "*vitest.workspace.*"
    effect: deny
  - action: edit
    resource: "*playwright*config*"
    effect: deny
  - action: edit
    resource: "*tsconfig*.json"
    effect: deny
  - action: edit
    resource: "*package.json"
    effect: deny
  - action: edit
    resource: "*pnpm-lock.yaml"
    effect: deny
  - action: edit
    resource: "*pnpm-workspace.yaml"
    effect: deny
  - action: edit
    resource: "*paseo.json"
    effect: deny
  - action: edit
    resource: "*.github/*"
    effect: deny
  - action: edit
    resource: "*.husky/*"
    effect: deny
  - action: edit
    resource: "*.agents/*"
    effect: deny
  - action: edit
    resource: "*.opencode/*"
    effect: deny
  - action: edit
    resource: "scripts/*"
    effect: deny
  - action: edit
    resource: "*/scripts/*"
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
