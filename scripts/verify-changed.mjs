// 바뀐 파일을 보고 돌릴 정적 분석 명령을 정해 실행한다. `pnpm verify:changed -- --dry-run`은 명령만 출력한다.
// 공용 설정이 바뀌면 전체 lint·typecheck·check를, 패키지 파일이 바뀌면 그 패키지와 그 패키지를 쓰는 패키지의
// typecheck(제품 코드는 전체, 시험 코드는 시험 쪽)를, 나머지는 lint와 pnpm check를 고른다.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasErrorCode,
  orIfMissing,
} from "../packages/contracts/src/failure.ts";
import { isTestFile } from "./test-files.mjs";

const sharedSettings = new Set([
  "eslint.config.js",
  "tsconfig.base.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/test-files.mjs",
  "scripts/eslint-test-rules.mjs",
  "scripts/eslint-product-rules.mjs",
  "scripts/tsconfig.json",
]);

const lintExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
]);

function isShared(file) {
  return sharedSettings.has(file) || file.startsWith("patches/");
}

export function plan(files, graph, { exists = () => true } = {}) {
  const changed = [...new Set(files)].sort();

  if (changed.some(isShared))
    return ["pnpm lint", "pnpm typecheck", "pnpm check"];

  const directories = Object.entries(graph)
    .map(([name, pkg]) => ({ name, dir: pkg.dir }))
    .sort((a, b) => b.dir.length - a.dir.length);

  const direct = new Map();
  const lintFiles = [];
  for (const file of changed) {
    if (file.endsWith(".md")) continue;

    if (lintExtensions.has(path.extname(file)) && exists(file))
      lintFiles.push(file);

    const owner = directories.find(({ dir }) => file.startsWith(`${dir}/`));
    if (!owner) continue;

    const kind = isTestFile(file) ? "test" : "full";
    if (kind === "full" || direct.get(owner.name) !== "full")
      direct.set(owner.name, kind);
  }

  const reverse = new Map(Object.keys(graph).map((name) => [name, []]));
  for (const [name, pkg] of Object.entries(graph))
    for (const dependency of pkg.deps)
      if (reverse.has(dependency)) reverse.get(dependency).push(name);

  const closure = (seeds) => {
    const seen = new Set(seeds);
    const pending = [...seeds];
    while (pending.length) {
      const name = pending.pop();
      for (const user of reverse.get(name) ?? [])
        if (!seen.has(user)) {
          seen.add(user);
          pending.push(user);
        }
    }
    return seen;
  };

  const full = closure(
    [...direct].filter(([, kind]) => kind === "full").map(([name]) => name)
  );
  const test = closure(
    [...direct].filter(([, kind]) => kind === "test").map(([name]) => name)
  );
  for (const name of full) test.delete(name);

  const quote = (file) =>
    /^[\w./@+-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`;

  const commands = [];
  if (lintFiles.length)
    commands.push(
      `pnpm exec eslint --no-warn-ignored ${lintFiles.map((file) => quote(file)).join(" ")}`
    );
  for (const name of [...new Set([...full, ...test])].sort())
    commands.push(
      `pnpm --filter ${name} run ${full.has(name) ? "typecheck" : "typecheck:test"}`
    );
  commands.push("pnpm check");
  return commands;
}

export function readGraph(root) {
  const graph = {};
  for (const group of ["apps", "packages"]) {
    const folder = path.join(root, group);
    const missing = hasErrorCode("ENOENT");
    // 그 묶음 폴더나 package.json이 없으면 패키지가 아니다. 권한·디스크 오류는 드러낸다.
    const entries = orIfMissing(
      () => fs.readdirSync(folder, { withFileTypes: true }),
      missing,
      []
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageFile = path.join(folder, entry.name, "package.json");
      const text = orIfMissing(
        () => fs.readFileSync(packageFile, "utf8"),
        missing,
        undefined
      );
      if (text === undefined) continue;
      const packageJson = JSON.parse(text);
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };
      graph[packageJson.name] = {
        dir: `${group}/${entry.name}`,
        deps: Object.entries(dependencies)
          .filter(
            ([, version]) =>
              typeof version === "string" && version.startsWith("workspace:")
          )
          .map(([name]) => name)
          .sort(),
      };
    }
  }
  return graph;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let base = "origin/main";
  let dryRun = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--base") {
      const value = process.argv[index + 1];
      if (value === undefined) fail("--base requires a value");
      base = value;
      index += 1;
      continue;
    }
    fail(`unknown option: ${argument}`);
  }

  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch (error) {
    fail(`not inside a Git repository (${error.message})`);
  }

  const git = (...args) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
  const lines = (output) =>
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  let comparison;
  try {
    comparison = git("merge-base", "HEAD", base).trim();
  } catch (error) {
    fail(`cannot compare HEAD with ${base} (${error.message})`);
  }

  const files = [
    ...new Set([
      ...lines(git("diff", "--name-only", "--no-renames", comparison)),
      ...lines(git("ls-files", "--others", "--exclude-standard")),
    ]),
  ];
  const exists = (file) => fs.existsSync(path.join(root, file));
  const commands = plan(files, readGraph(root), { exists });

  if (dryRun) {
    for (const command of commands) console.log(command);
    process.exit(0);
  }

  console.log(`바뀐 파일 ${files.length}개 → 검사 ${commands.length}개`);
  for (const command of commands) console.log(command);

  const failed = [];
  for (const command of commands) {
    // 검사 하나가 멈춰도 나머지를 돌리고 끝나도록 상한을 둔다. 전체 시험·타입 검사도 이 안에 끝난다.
    const result = spawnSync(command, {
      cwd: root,
      shell: true,
      stdio: "inherit",
      timeout: 30 * 60_000,
    });
    if (result.error) console.error(`${command}: ${result.error.message}`);
    if (result.status !== 0) failed.push(command);
  }

  if (failed.length) {
    console.log("실패한 명령:");
    for (const command of failed) console.log(command);
    process.exitCode = 1;
  } else {
    console.log("모든 검사를 통과했습니다.");
  }
}
