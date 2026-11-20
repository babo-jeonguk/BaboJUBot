// 바뀐 파일을 보고 돌릴 정적 분석 명령을 정해 실행한다. `pnpm verify:changed -- --dry-run`은 명령만 출력한다.
// 공용 설정이 바뀌면 전체 lint·typecheck·check를, 패키지 파일이 바뀌면 그 패키지와 그 패키지를 쓰는 패키지의
// typecheck(제품 코드는 전체, 시험 코드는 시험 쪽)를 고른다. pnpm check는 묶음으로 나눠, 문서 검사는 늘 돌리고
// 나머지 묶음은 그 묶음의 시험이 보는 파일이나 저장소 뿌리(scripts·.agents)가 쓰는 패키지가 바뀌었을 때만 돌린다.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hasErrorCode, orIfMissing } from "@babojubot/contracts";
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
  ".agents/tsconfig.json",
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

/**
 * pnpm check의 묶음(package.json의 check:*)과 그 묶음의 시험이 보는 파일. 모든 묶음은 뿌리가 쓰는 패키지가 바뀌었을 때도 돈다
 * (lint 규칙 시험도 workspace 패키지의 package.json·파일 자리로 판정하고 @babojubot/process를 쓴다).
 */
const checkGroups = [
  {
    name: "rules",
    owns: (file) =>
      /^scripts\/(eslint-|lint-|[\w-]+-lint-rules\.test\.mjs$)/.test(file),
  },
  {
    name: "agents",
    owns: (file) =>
      file.startsWith(".agents/") || file.startsWith(".opencode/"),
  },
  {
    name: "scripts",
    owns: (file) => file.startsWith("scripts/") || file.startsWith(".github/"),
  },
];

export function plan(files, graph, { exists = () => true } = {}) {
  const changed = [...new Set(files)].sort();

  if (changed.some(isShared))
    return ["pnpm lint", "pnpm typecheck", "pnpm check"];

  // 뿌리 패키지(dir ".")는 파일 주인이 아니다. 그 패키지가 쓰는 패키지가 바뀌면 scripts·.agents의 시험이 영향을 받는다.
  const root = Object.keys(graph).find((name) => graph[name].dir === ".");
  const directories = Object.entries(graph)
    .filter(([name]) => name !== root)
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
  const affected = new Set([...full, ...test]);
  for (const name of [...affected].sort())
    if (name !== root)
      commands.push(
        `pnpm --filter ${name} run ${full.has(name) ? "typecheck" : "typecheck:test"}`
      );
  commands.push("pnpm check:docs");
  // 묶음마다 한 파일은 앞 묶음이 가져가 두 번 세지 않는다(lint 규칙 파일은 scripts 묶음을 부르지 않는다).
  const owner = (file) => checkGroups.find((group) => group.owns(file));
  for (const group of checkGroups)
    if (
      changed.some((file) => owner(file) === group) ||
      (root !== undefined && affected.has(root))
    )
      commands.push(`pnpm check:${group.name}`);
  return commands;
}

export function readGraph(root) {
  // 뿌리 package.json은 scripts·.agents가 쓰는 workspace 패키지를 적는다.
  const rootJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const graph = {
    [rootJson.name]: { dir: ".", deps: workspaceDeps(rootJson) },
  };
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
      graph[packageJson.name] = {
        dir: `${group}/${entry.name}`,
        deps: workspaceDeps(packageJson),
      };
    }
  }
  return graph;
}

/** package.json이 workspace에서 가져오는 패키지 이름. */
function workspaceDeps(packageJson) {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  return Object.entries(dependencies)
    .filter(
      ([, version]) =>
        typeof version === "string" && version.startsWith("workspace:")
    )
    .map(([name]) => name)
    .sort();
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
      killSignal: "SIGKILL",
    }).trim();
  } catch (error) {
    fail(`not inside a Git repository (${error.message})`);
  }

  const git = (...args) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
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
      killSignal: "SIGKILL",
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
