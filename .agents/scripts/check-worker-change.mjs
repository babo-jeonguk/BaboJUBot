#!/usr/bin/env node
// Checks a code worker's uncommitted change so the parent can decide whether to accept it. The files a worker may
// not edit come from .opencode/agents/dev-worker.md, so the permission and this check cannot drift.
// Contract: docs/agents/worker.md.
//
// usage: node .agents/scripts/check-worker-change.mjs --base <sha> --allow <pattern>...
//          --reported <file>... --test <command>...
//
// `*` in a pattern matches any characters, `/` included, as in OpenCode permissions.
// Exit codes: 0 no problem found; 1 problem found; 2 usage.
import { execFileSync, spawnSync } from "node:child_process";
import { editRules, isProtected, matcher } from "./worker-permissions.mjs";

const USAGE =
  "usage: check-worker-change.mjs --base <sha> --allow <pattern>... --reported <file>... --test <command>...";
const OUTPUT_LINES = 40;
// A stuck test command must not hold the parent forever. The repository's full check fits well inside this.
const TEST_LIMIT_MS = 30 * 60_000;

function parseArgs(argv) {
  /** @type {{ base: string, allow: string[], reported: string[], test: string[] }} */
  const options = { base: "", allow: [], reported: [], test: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (
      value === undefined ||
      !["base", "allow", "reported", "test"].includes(name)
    )
      usage(`bad argument: ${argv[index]}`);
    if (name === "base") options.base = value;
    else options[name].push(value);
  }
  if (
    !options.base ||
    !options.allow.length ||
    !options.reported.length ||
    !options.test.length
  )
    usage("--base, --allow, --reported and --test are required");
  return options;
}

function usage(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function fail(reasons) {
  console.error(reasons.map((reason) => `problem: ${reason}`).join("\n"));
  process.exit(1);
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
}

function changedFiles(root, base) {
  const list = (...args) =>
    git(root, ...args)
      .split("\0")
      .filter(Boolean);
  return [
    ...new Set([
      ...list("diff", "--name-only", "--no-renames", "-z", base),
      ...list("diff", "--cached", "--name-only", "--no-renames", "-z", base),
      ...list("ls-files", "--others", "--exclude-standard", "-z"),
    ]),
  ].sort();
}

// Read from the base commit: the change under review must not decide what it may change.
function baseEditRules(root, base) {
  const rules = editRules(
    git(root, "show", `${base}:.opencode/agents/dev-worker.md`)
  );
  if (!rules) fail(["dev-worker.md has no frontmatter"]);
  return rules;
}

function runTest(root, command) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: TEST_LIMIT_MS,
    killSignal: "SIGKILL",
  });
  if (result.status === 0) return;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .trimEnd()
    .split("\n")
    .slice(-OUTPUT_LINES)
    .join("\n");
  const ending = result.error?.message ?? `exit ${result.status}`;
  fail([`test command failed (${ending}): ${command}\n${output}`]);
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const options = parseArgs(process.argv.slice(2));
const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
const head = git(root, "rev-parse", "HEAD").trim();
const base = git(root, "rev-parse", `${options.base}^{commit}`).trim();
if (head !== base) fail([`HEAD moved from ${base} to ${head}`]);

const rules = baseEditRules(root, base);
const allowed = options.allow.map(matcher);
const reported = new Set(options.reported);

function checkChange() {
  const files = changedFiles(root, base);
  if (files.length === 0) fail(["no files changed"]);
  const reasons = files.flatMap((file) => {
    /** @type {string[]} */
    const found = [];
    if (isProtected(rules, file)) found.push(`protected file changed: ${file}`);
    else if (!allowed.some((pattern) => pattern.test(file)))
      found.push(`outside the brief: ${file}`);
    if (!reported.has(file)) found.push(`changed but not reported: ${file}`);
    return found;
  });
  for (const file of reported)
    if (!files.includes(file))
      reasons.push(`reported but not changed: ${file}`);
  if (reasons.length > 0) fail(reasons);
  return files;
}

checkChange();
for (const command of options.test) runTest(root, command);
const files = checkChange();
console.log(
  `ok: ${plural(files.length, "file")}, ${plural(options.test.length, "test command")} passed`
);
