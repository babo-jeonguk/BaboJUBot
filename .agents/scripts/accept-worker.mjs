#!/usr/bin/env node
// Checks a code worker's uncommitted change before the parent accepts it. The files a worker may
// not edit come from .opencode/agents/dev-worker.md, so the permission and this check cannot drift.
// Contract: docs/agents/worker.md.
//
// usage: node .agents/scripts/accept-worker.mjs --base <sha> --allow <pattern>...
//          --reported <file>... --test <command>... [--test-timeout <seconds>]
//
// `*` in a pattern matches any characters, `/` included, as in OpenCode permissions.
// Exit codes: 0 accepted; 1 rejected; 2 usage.
import { execFileSync, spawn } from "node:child_process";
import { parse } from "yaml";

const USAGE =
  "usage: accept-worker.mjs --base <sha> --allow <pattern>... --reported <file>... --test <command>... [--test-timeout <seconds>]";
const OUTPUT_LINES = 40;
const OUTPUT_CHARS = 1024 * 1024;
const STOP_GRACE_MS = 5_000;

function parseArgs(argv) {
  const options = {
    base: "",
    allow: [],
    reported: [],
    test: [],
    testTimeout: 600,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (
      value === undefined ||
      !["base", "allow", "reported", "test", "test-timeout"].includes(name)
    )
      usage(`bad argument: ${argv[index]}`);
    if (name === "base") options.base = value;
    else if (name === "test-timeout") options.testTimeout = Number(value);
    else options[name].push(value);
  }
  if (
    !options.base ||
    !options.allow.length ||
    !options.reported.length ||
    !options.test.length
  )
    usage("--base, --allow, --reported and --test are required");
  if (!(options.testTimeout > 0))
    usage("--test-timeout must be a positive number of seconds");
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
      ...list("diff", "--cached", "--name-only", "--no-renames", "-z", base),
      ...list("ls-files", "--others", "--exclude-standard", "-z"),
    ]),
  ].sort();
}

// Read from the base commit: the change under review must not decide what it may change.
// OpenCode applies the last rule that matches, so a later allow can reopen a denied path.
function editRules(root, base) {
  const definition = git(
    root,
    "show",
    `${base}:.opencode/agents/dev-worker.md`
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

// Each command runs in its own process group so a stuck run can be stopped with what it started.
function stopGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The process group may already be gone.
  }
}

function runCommand(root, command, timeoutSeconds) {
  return new Promise((done) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let killTimer;
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-OUTPUT_CHARS);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const forward = (signal) => {
      stopGroup(child, signal);
      process.exit(1);
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    const limit = setTimeout(() => {
      timedOut = true;
      stopGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        stopGroup(child, "SIGKILL");
        finish(`exit ${child.exitCode ?? child.signalCode}`);
      }, STOP_GRACE_MS);
    }, timeoutSeconds * 1000);
    let finished = false;
    function finish(ending) {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      clearTimeout(killTimer);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      child.stdout.destroy();
      child.stderr.destroy();
      done({
        ending: timedOut ? `timed out after ${timeoutSeconds}s` : ending,
        output,
      });
    }
    child.on("error", (error) => finish(error.message));
    child.on("close", (code, signal) =>
      finish(code === 0 ? null : `exit ${code ?? signal}`)
    );
  });
}

async function runTest(root, command, timeoutSeconds) {
  const { ending, output } = await runCommand(root, command, timeoutSeconds);
  if (!ending) return;
  const tail = output.trimEnd().split("\n").slice(-OUTPUT_LINES).join("\n");
  reject([`test command failed (${ending}): ${command}\n${tail}`]);
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const options = parseArgs(process.argv.slice(2));
const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
const head = git(root, "rev-parse", "HEAD").trim();
const base = git(root, "rev-parse", `${options.base}^{commit}`).trim();
if (head !== base) reject([`HEAD moved from ${base} to ${head}`]);

const rules = editRules(root, base);
const allowed = options.allow.map(matcher);
const reported = new Set(options.reported);

function checkChange() {
  const files = changedFiles(root, base);
  if (files.length === 0) reject(["no files changed"]);
  const reasons = files.flatMap((file) => {
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
  if (reasons.length > 0) reject(reasons);
  return files;
}

checkChange();
for (const command of options.test)
  await runTest(root, command, options.testTimeout);
const files = checkChange();
console.log(
  `accepted: ${plural(files.length, "file")}, ${plural(options.test.length, "test command")} passed`
);
