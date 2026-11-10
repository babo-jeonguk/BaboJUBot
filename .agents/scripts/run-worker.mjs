#!/usr/bin/env node
// Runs one code-edit worker turn under .agents/opencode-worker.json and waits for it, so the
// parent wakes once: it relaunches a run that never starts a session, then prints a short summary
// of the result. Contract: docs/agents/review-fixes.md 「코드 수정 worker」.
//
// usage: node .agents/scripts/run-worker.mjs --model <provider/model> --title <title>
//          --out <file.jsonl> (--brief <file> | --message <text>)
//          [--session <sessionID>] [--start-check <seconds>]
//
// Exit codes: 0 finished without an error event; 2 error event (move to the next model);
// 3 no session started twice (parent takes over); 4 opencode failed without an error event;
// 1 usage.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: run-worker.mjs --model <provider/model> --title <title> --out <file.jsonl>
  (--brief <file> | --message <text>) [--session <sessionID>] [--start-check <seconds>]`;

function parseArgs(argv) {
  const known = new Set([
    "model",
    "title",
    "out",
    "brief",
    "message",
    "session",
    "start-check",
  ]);
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");
    if (!known.has(name) || argv[i + 1] === undefined)
      fail(`bad argument: ${argv[i]}`);
    opts[name] = argv[i + 1];
  }
  if (!opts.model || !opts.title || !opts.out)
    fail("--model, --title and --out are required");
  if (!opts.brief === !opts.message)
    fail("give exactly one of --brief and --message");
  if (opts.brief && !existsSync(opts.brief))
    fail(`brief not found: ${opts.brief}`);
  const startCheck = Number(opts["start-check"] ?? 180);
  if (!(startCheck > 0))
    fail("--start-check must be a positive number of seconds");
  return { ...opts, startCheckMs: startCheck * 1000 };
}

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const config = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../opencode-worker.json"
);
const message = opts.brief ? readFileSync(opts.brief, "utf8") : opts.message;
const errFile = `${opts.out.replace(/\.jsonl$/, "")}.err`;
const args = [
  "run",
  "--agent",
  "dev-worker",
  "--standalone",
  "--auto",
  "--format",
  "json",
  "-m",
  opts.model,
  "--title",
  opts.title,
];
if (opts.session) args.push("-s", opts.session);
args.push(message);

let child = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stop(child);
    process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]);
  });
}

// The worker runs in its own process group so a stalled run can be stopped with everything it started.
function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // The process group may already be gone.
  }
  setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The process group may already be gone.
    }
  }, 5000).unref();
}

function readEvents() {
  if (!existsSync(opts.out)) return [];
  return readFileSync(opts.out, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const sessionOf = (events) => events.find((e) => e.sessionID)?.sessionID ?? "";

function runOnce() {
  const out = openSync(opts.out, "w");
  const err = openSync(errFile, "w");
  child = spawn("opencode", args, {
    env: { ...process.env, OPENCODE_CONFIG: config },
    stdio: ["ignore", out, err],
    detached: true,
  });
  closeSync(out);
  closeSync(err);
  const proc = child;
  let stalled = false;
  const check = setTimeout(() => {
    if (!sessionOf(readEvents())) {
      stalled = true;
      stop(proc);
    }
  }, opts.startCheckMs);
  return new Promise((done) => {
    proc.on("error", (error) => {
      clearTimeout(check);
      done({ code: 127, stalled: false, spawnError: error.message });
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(check);
      done({ code: code ?? 128, signal, stalled });
    });
  });
}

const started = Date.now();
let attempts = 0;
let result;
let events;
do {
  attempts += 1;
  result = await runOnce();
  events = readEvents();
} while (attempts < 2 && !result.spawnError && !sessionOf(events));

const session = sessionOf(events);
const errors = events
  .filter((e) => e.type === "error")
  .map((e) => e.error?.message ?? JSON.stringify(e.error));
const tools = events
  .filter((e) => e.type === "tool_use")
  .map((e) => e.part ?? {});
const written = [
  ...new Set(
    tools
      .filter(
        (t) =>
          ["edit", "write", "patch", "multiedit"].includes(t.tool) &&
          t.state?.status === "completed"
      )
      .map((t) => t.state.input?.filePath ?? t.state.input?.path)
      .filter(Boolean)
      .map((path) => path.replace(`${process.cwd()}/`, ""))
  ),
];
const denied = tools
  .filter((t) => /Permission denied|rejected/i.test(t.state?.error ?? ""))
  .map(
    (t) =>
      `${t.tool}: ${
        t.state.input?.command ??
        t.state.input?.filePath ??
        t.state.input?.path ??
        ""
      }`
  );
const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
for (const e of events.filter((e) => e.type === "step_finish")) {
  const t = e.part?.tokens ?? {};
  tokens.input += t.input ?? 0;
  tokens.output += t.output ?? 0;
  tokens.reasoning += t.reasoning ?? 0;
  tokens.cacheRead += t.cache?.read ?? 0;
}
const report = events.filter((e) => e.type === "text").at(-1)?.part?.text ?? "";

let status;
let exitCode;
if (result.spawnError)
  [status, exitCode] = [`spawn failed: ${result.spawnError}`, 4];
else if (errors.length) [status, exitCode] = ["error", 2];
else if (!session) [status, exitCode] = ["no session started", 3];
else if (result.code !== 0)
  [status, exitCode] = [`opencode exited ${result.signal ?? result.code}`, 4];
else [status, exitCode] = ["finished", 0];

const seconds = Math.round((Date.now() - started) / 1000);
const lines = [
  `status: ${status}`,
  `model: ${opts.model}`,
  `session: ${session || "-"}`,
  `attempts: ${attempts}`,
  `duration: ${Math.floor(seconds / 60)}m${seconds % 60}s`,
  `steps: ${events.filter((e) => e.type === "step_finish").length}  tokens: in ${
    tokens.input
  } out ${tokens.output} reasoning ${tokens.reasoning} cache-read ${
    tokens.cacheRead
  }`,
  `written: ${written.join(", ") || "-"}`,
  `denied: ${denied.join(" | ") || "-"}`,
  `errors: ${errors.join(" | ") || "-"}`,
  `output: ${opts.out} (stderr: ${errFile})`,
  "--- final report ---",
  report || "(none)",
];
console.log(lines.join("\n"));
process.exit(exitCode);
