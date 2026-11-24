// The files the code worker may not edit, defined once (docs/agents/worker.md): test files (the test scope,
// scripts/test-files.mjs), secrets, check settings by the names their tools read, and whole settings folders.
// - check-worker-change.ts judges a worker's change with protectedReason, by path pieces: a name matches the last piece
//   only, a folder matches a whole piece.
// - The check-settings block of .opencode/agents/dev-worker.md is generated from this definition
//   (`node .agents/scripts/protected-files.ts` prints it; worker-permissions.test.ts keeps them equal). OpenCode's `*`
//   crosses `/` (it turns `*` into `.*`), so that block is built to deny at least what this definition protects.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  repositoryRelative,
  resolvePackageEntry,
} from "../../scripts/package-exports.ts";
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

/** Is `name` (a file name) a check setting by the names the tools read? */
function isSettingName(name: string) {
  return (
    exactNames.has(name) ||
    namePatterns.some((pattern) => path.posix.matchesGlob(name, pattern))
  );
}

/** Product code: the source of an app or package outside the test scope. */
export function isProductCode(file: string) {
  return /^(?:apps|packages)\/[^/]+\/src\//.test(file) && !isTestFile(file);
}

const codeFile = new RegExp(`\\.(?:${codeFormatNames.join("|")})$`);

/** The module specifiers a code file imports: static imports and re-exports, and import() with a literal. */
function importedSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The repository modules the check settings import, closed over their own imports: a setting's code decides what the checks
 * do (vitest.reports.ts sets every Vitest config's files and reports), so it is protected like the setting. A relative
 * specifier resolves as ESM does (a URL against the importing file); a workspace package name resolves with Node's own
 * resolver (scripts/package-exports.ts); other packages are not in the repository. The closure stops at product code,
 * which the checks test and the worker changes (isProductCode). Maps each module to the setting that first reached it.
 */
export function settingModules(
  root: string,
  files: string[]
): Map<string, string> {
  const present = new Set(files);
  const packages = new Map<string, string>();
  for (const file of files.filter((each) =>
    /^(?:(?:apps|packages)\/[^/]+\/)?package\.json$/.test(each)
  )) {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, file), "utf8")
    );
    if (
      manifest &&
      typeof manifest === "object" &&
      "name" in manifest &&
      typeof manifest.name === "string"
    )
      packages.set(manifest.name, path.posix.dirname(file));
  }
  const resolve = (from: string, specifier: string): string | undefined => {
    if (specifier.startsWith(".")) {
      const url = new URL(specifier, pathToFileURL(path.join(root, from)));
      const file = repositoryRelative(root, fileURLToPath(url));
      return present.has(file) ? file : undefined;
    }
    const name = [...packages.keys()].find(
      (each) => specifier === each || specifier.startsWith(`${each}/`)
    );
    if (name === undefined) return undefined;
    const folder = packages.get(name) ?? ".";
    const entry = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const resolved = resolvePackageEntry(path.join(root, folder), name, entry);
    if ("refused" in resolved) return undefined;
    const file = repositoryRelative(root, resolved.file);
    return present.has(file) ? file : undefined;
  };
  const modules = new Map<string, string>();
  const settings = files.filter(
    (file) => codeFile.test(file) && isSettingName(path.posix.basename(file))
  );
  const pending = settings.map((file) => ({ file, by: file }));
  for (let next = pending.shift(); next; next = pending.shift()) {
    const text = readFileSync(path.join(root, next.file), "utf8");
    for (const specifier of importedSpecifiers(next.file, text)) {
      const module = resolve(next.file, specifier);
      // Product code (apps/*/src, packages/*/src outside the test scope) is what the checks test, not how they are set
      // up: the worker must be able to change it, so the closure stops there.
      if (
        module === undefined ||
        modules.has(module) ||
        settings.includes(module) ||
        !codeFile.test(module) ||
        isProductCode(module)
      )
        continue;
      modules.set(module, next.by);
      pending.push({ file: module, by: next.by });
    }
  }
  return modules;
}

const repository = path.resolve(import.meta.dirname, "../..");
let repositoryModules: Map<string, string> | undefined;
/** settingModules of this repository (Git's file list), read once. */
export function repositorySettingModules() {
  repositoryModules ??= settingModules(
    repository,
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
      }
    )
      .split("\0")
      .filter(Boolean)
  );
  return repositoryModules;
}

/** Why the worker may not edit `file` (a repository path with `/`), or undefined when it may. */
export function protectedReason(file: string): string | undefined {
  const pieces = file.split("/");
  const name = pieces.at(-1) ?? "";
  if (isTestFile(file)) return "test file";
  if (name === ".env" || name.startsWith(".env.")) return "secret";
  const folder = pieces.slice(0, -1).find((piece) => folders.has(piece));
  if (folder !== undefined) return `inside ${folder}/`;
  if (isSettingName(name)) return "check setting";
  const setting = repositorySettingModules().get(file);
  if (setting !== undefined) return `imported by the check setting ${setting}`;
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
  // The repository modules the settings import, by their exact paths (settingModules).
  for (const module of [...repositorySettingModules().keys()].sort())
    both(module, "deny");
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
