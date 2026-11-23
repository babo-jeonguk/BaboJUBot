#!/usr/bin/env node
// Checks a code worker's uncommitted change so the parent can decide whether to accept it. The files a worker may
// not edit come from their definition (protected-files.ts), judged by path pieces. It does not reuse the OpenCode
// permissions: OpenCode's `*` crosses `/`, and a check that read the same rules would miss what they let through.
// Contract: docs/agents/worker.md.
//
// usage: node .agents/scripts/check-worker-change.ts --base <sha> --allow <pattern>...
//          --reported <file>... --test <command>...
//
// `*` in an --allow pattern matches any characters, `/` included, as in OpenCode permissions.
// Exit codes: 0 no problem found; 1 problem found; 2 usage.
import { execFileSync, spawnSync } from "node:child_process";
import { protectedReason } from "./protected-files.ts";
import { matcher } from "./worker-permissions.ts";

const USAGE =
  "usage: check-worker-change.ts --base <sha> --allow <pattern>... --reported <file>... --test <command>...";
const OUTPUT_LINES = 40;
// A stuck test command must not hold the parent forever. The repository's full check fits well inside this.
const TEST_LIMIT_MS = 30 * 60_000;

interface Options {
  base: string;
  allow: string[];
  reported: string[];
  test: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { base: "", allow: [], reported: [], test: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (value === undefined) usage(`bad argument: ${argv[index]}`);
    if (name === "base") options.base = value;
    else if (name === "allow" || name === "reported" || name === "test")
      options[name].push(value);
    else usage(`bad argument: ${argv[index]}`);
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

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function fail(reasons: string[]): never {
  console.error(reasons.map((reason) => `problem: ${reason}`).join("\n"));
  process.exit(1);
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
}

function changedFiles(root: string, base: string) {
  const list = (...args: string[]) =>
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

function runTest(root: string, command: string) {
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
  // A command that a signal ended has no exit code; name the signal instead.
  const ending =
    result.error?.message ??
    (result.status === null ? result.signal : `exit ${result.status}`);
  fail([`test command failed (${ending}): ${command}\n${output}`]);
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const options = parseArgs(process.argv.slice(2));
const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
const head = git(root, "rev-parse", "HEAD").trim();
const base = git(root, "rev-parse", `${options.base}^{commit}`).trim();
if (head !== base) fail([`HEAD moved from ${base} to ${head}`]);

const allowed = options.allow.map(matcher);
const reported = new Set(options.reported);

function checkChange() {
  const files = changedFiles(root, base);
  if (files.length === 0) fail(["no files changed"]);
  const reasons = files.flatMap((file) => {
    const found: string[] = [];
    const reason = protectedReason(file);
    if (reason) found.push(`protected file changed: ${file} (${reason})`);
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
