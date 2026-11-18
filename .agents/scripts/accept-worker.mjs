#!/usr/bin/env node
// Checks a code worker's uncommitted change before the parent accepts it. The files a worker may
// not edit come from .opencode/agents/dev-worker.md, so the permission and this check cannot drift.
// Contract: docs/agents/worker.md.
//
// usage: node .agents/scripts/accept-worker.mjs --base <sha> --allow <pattern>...
//          [--test <command>]...
//
// `*` in a pattern matches any characters, `/` included, as in OpenCode permissions.
// Exit codes: 0 accepted; 1 rejected; 2 usage.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const USAGE =
  "usage: accept-worker.mjs --base <sha> --allow <pattern>... [--test <command>]...";
const OUTPUT_LINES = 40;

function parseArgs(argv) {
  const options = { base: "", allow: [], test: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (value === undefined || !["base", "allow", "test"].includes(name))
      usage(`bad argument: ${argv[index]}`);
    if (name === "base") options.base = value;
    else options[name].push(value);
  }
  if (!options.base || options.allow.length === 0)
    usage("--base and --allow are required");
  return options;
}

function usage(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function reject(reasons) {
  console.error(reasons.map((reason) => `rejected: ${reason}`).join("\n"));
  process.exit(1);
}

function matcher(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`, "s");
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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
      ...list("ls-files", "--others", "--exclude-standard", "-z"),
    ]),
  ].sort();
}

// OpenCode applies the last rule that matches, so a later allow can reopen a denied path.
function editRules(root) {
  const definition = readFileSync(
    join(root, ".opencode/agents/dev-worker.md"),
    "utf8"
  );
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) reject(["dev-worker.md has no frontmatter"]);
  return parse(frontmatter)
    .permissions.filter((rule) => rule.action === "edit")
    .map((rule) => ({ ...rule, matches: matcher(rule.resource) }));
}

function isProtected(rules, file) {
  return rules.findLast((rule) => rule.matches.test(file))?.effect === "deny";
}

function runTest(root, command) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .trimEnd()
    .split("\n")
    .slice(-OUTPUT_LINES)
    .join("\n");
  const ending = result.error?.message ?? `exit ${result.status}`;
  reject([`test command failed (${ending}): ${command}\n${output}`]);
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const options = parseArgs(process.argv.slice(2));
const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
const head = git(root, "rev-parse", "HEAD").trim();
const base = git(root, "rev-parse", `${options.base}^{commit}`).trim();
if (head !== base) reject([`HEAD moved from ${base} to ${head}`]);

const files = changedFiles(root, base);
if (files.length === 0) reject(["no files changed"]);
const rules = editRules(root);
const allowed = options.allow.map(matcher);
const reasons = files.flatMap((file) => {
  if (isProtected(rules, file)) return [`protected file changed: ${file}`];
  if (!allowed.some((pattern) => pattern.test(file)))
    return [`outside the brief: ${file}`];
  return [];
});
if (reasons.length > 0) reject(reasons);

for (const command of options.test) runTest(root, command);
console.log(
  `accepted: ${plural(files.length, "file")}, ${plural(options.test.length, "test command")} passed`
);
