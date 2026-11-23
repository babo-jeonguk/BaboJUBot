// The files the code worker may not edit, defined once (docs/agents/worker.md): test files (the test scope,
// scripts/test-files.mjs), secrets, check settings by the names their tools read, and whole settings folders.
// - check-worker-change.ts judges a worker's change with protectedReason, by path pieces: a name matches the last piece
//   only, a folder matches a whole piece.
// - The check-settings block of .opencode/agents/dev-worker.md is generated from this definition
//   (`node .agents/scripts/protected-files.ts` prints it; worker-permissions.test.ts keeps them equal). OpenCode's `*`
//   crosses `/` (it turns `*` into `.*`), so that block is built to deny at least what this definition protects.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codeFormatNames, isTestFile } from "../../scripts/test-files.mjs";

/** Script formats a tool's config loader reads (no JSX): the repository's code formats without tsx and jsx. */
const scriptFormats = codeFormatNames.filter((format) => !format.endsWith("x"));

/**
 * Check settings by the file names each tool reads. Every name is exact except where the tool reads a name the
 * repository chooses (a `*` inside the name, matched within the file name only).
 */
export const settingNames: { tool: string; source: string; names: string[] }[] =
  [
    {
      tool: "ESLint",
      source:
        "https://eslint.org/docs/latest/use/configure/configuration-files",
      names: scriptFormats.map((format) => `eslint.config.${format}`),
    },
    {
      // Vitest reads vitest.config.{js,mjs,cjs,ts,mts,cts}; `--config` reads any name, and the repository names its
      // extra configs vitest.<suite>.config.<format> in every code format the test scope uses (scripts/test-files.mjs).
      tool: "Vitest",
      source: "https://vitest.dev/config/",
      names: [
        ...codeFormatNames.map((format) => `vitest.config.${format}`),
        ...codeFormatNames.map((format) => `vitest.*.config.${format}`),
        ...[...codeFormatNames, "json"].map(
          (format) => `vitest.workspace.${format}`
        ),
      ],
    },
    {
      tool: "Vite",
      source: "https://vite.dev/config/",
      names: scriptFormats.map((format) => `vite.config.${format}`),
    },
    {
      // Playwright reads playwright.config.{ts,js,mts,mjs,cts,cjs}; `--config` reads any name, named like Vitest's.
      tool: "Playwright",
      source: "https://playwright.dev/docs/test-configuration",
      names: [
        ...codeFormatNames.map((format) => `playwright.config.${format}`),
        ...codeFormatNames.map((format) => `playwright.*.config.${format}`),
      ],
    },
    {
      tool: "Prettier",
      source: "https://prettier.io/docs/configuration",
      names: [
        ".prettierrc",
        ...["json", "yml", "yaml", "json5", "toml", ...scriptFormats].map(
          (format) => `.prettierrc.${format}`
        ),
        ...scriptFormats.map((format) => `prettier.config.${format}`),
        ".prettierignore",
      ],
    },
    {
      tool: "lint-staged",
      source: "https://github.com/lint-staged/lint-staged#configuration",
      names: [
        ".lintstagedrc",
        ...["json", "yaml", "yml", ...scriptFormats].map(
          (format) => `.lintstagedrc.${format}`
        ),
        ...scriptFormats.map((format) => `lint-staged.config.${format}`),
      ],
    },
    {
      // The JS type check reads every JSON whose name holds tsconfig (scripts/typecheck-js.mjs isTypeScriptConfig).
      tool: "TypeScript",
      source: "scripts/typecheck-js.mjs",
      names: ["*tsconfig*.json"],
    },
    {
      tool: "EditorConfig",
      source: "https://editorconfig.org/",
      names: [".editorconfig"],
    },
    {
      tool: "npm and pnpm",
      source: "https://pnpm.io/settings",
      names: [
        ".npmrc",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ],
    },
    {
      tool: "Git",
      source: "https://git-scm.com/docs/gitignore",
      names: [".gitignore", ".gitattributes"],
    },
    { tool: "Paseo", source: "paseo.json", names: ["paseo.json"] },
  ];

/** Folders protected whole, by name: any path piece with that name protects what lies below it. */
export const settingFolders = [
  ".github",
  ".husky",
  ".agents",
  ".opencode",
  ".claude",
  "patches",
  "scripts",
  "test-fixtures",
  ".git",
  ".reference-cache",
];

const names = settingNames.flatMap((setting) => setting.names);
const exactNames = new Set(names.filter((name) => !name.includes("*")));
const namePatterns = names.filter((name) => name.includes("*"));
const folders = new Set(settingFolders);

/** Why the worker may not edit `file` (a repository path with `/`), or undefined when it may. */
export function protectedReason(file: string): string | undefined {
  const pieces = file.split("/");
  const name = pieces.at(-1) ?? "";
  if (isTestFile(file)) return "test file";
  if (name === ".env" || name.startsWith(".env.")) return "secret";
  const folder = pieces.slice(0, -1).find((piece) => folders.has(piece));
  if (folder !== undefined) return `inside ${folder}/`;
  if (
    exactNames.has(name) ||
    namePatterns.some((pattern) => path.posix.matchesGlob(name, pattern))
  )
    return "check setting";
  if (name.endsWith(".md")) return "document";
  return undefined;
}

/**
 * The OpenCode edit rules of the check-settings block, in order (the last match wins). A name with a `*` inside could
 * match into a folder (`vitest.helpers/run.ts`), so after its denials the folders it names are reopened; exact names,
 * the names with a `*` again below a reopened folder, and the settings folders are denied after that, so a real setting
 * below a reopened folder stays denied. Below a reopened folder two levels deep the block may deny more than the
 * definition (`vitest.a/b/vitest.c/d.config.ts`); it never denies less.
 */
export function openCodeSettingRules(): { resource: string; effect: string }[] {
  const rules: { resource: string; effect: string }[] = [];
  const both = (resource: string, effect: string) => {
    if (resource.startsWith("*")) rules.push({ resource, effect });
    else
      rules.push({ resource, effect }, { resource: `*/${resource}`, effect });
  };
  // The folder a pattern's inner `*` could reach into: the pattern up to and including its inner `*`.
  const reopened = [
    ...new Set(
      namePatterns.map((pattern) => {
        const inner = pattern.indexOf("*", pattern.startsWith("*") ? 1 : 0);
        return pattern.slice(0, inner + 1);
      })
    ),
  ];
  for (const pattern of namePatterns) both(pattern, "deny");
  for (const folder of reopened) both(`${folder}/*`, "allow");
  for (const name of exactNames) both(name, "deny");
  for (const folder of reopened)
    for (const pattern of namePatterns) both(`${folder}/*${pattern}`, "deny");
  for (const folder of settingFolders.filter(
    (each) => ![".git", ".reference-cache", "test-fixtures"].includes(each)
  ))
    both(`${folder}/*`, "deny");
  return rules;
}

/** The generated block as it stands in dev-worker.md, between its two marker comments. */
export function openCodeSettingBlock() {
  return openCodeSettingRules()
    .map(
      ({ resource, effect }) =>
        `  - action: edit\n    resource: "${resource}"\n    effect: ${effect}\n`
    )
    .join("");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.stdout.write(openCodeSettingBlock());
