#!/usr/bin/env node
// Runs one code-edit worker turn under .agents/opencode-worker.json and waits for it, so the
// parent wakes once: it relaunches a run that never starts a session, then prints a short summary
// of the result. Contract: docs/agents/review-fixes.md 「코드 수정 worker」.
//
// usage: node .agents/scripts/run-worker.mjs --model <provider/model> --title <title>
//          --out <file.jsonl> (--brief <file> | --message <text>)
//          [--session <sessionID>] [--start-check <seconds>] [--limit <minutes>]
//
// Exit codes: 0 finished without an error event; 2 error event (move to the next model);
// 3 no session started twice (parent takes over); 4 opencode failed without an error event or
// the call reached --limit (a limit on the whole call, retries included; default 110 minutes, inside
// the parent's 2-hour background limit); 1 usage.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { killUnlessGone, processAlive } from "@babojubot/runtime/test-cleanup";
import {
  continueAfterFailure,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
  settled,
} from "../../packages/contracts/src/failure.ts";

const USAGE = `usage: run-worker.mjs --model <provider/model> --title <title> --out <file.jsonl>
  (--brief <file> | --message <text>) [--session <sessionID>] [--start-check <seconds>]
  [--limit <minutes>]`;

function parseArgs(argv) {
  const known = new Set([
    "model",
    "title",
    "out",
    "brief",
    "message",
    "session",
    "start-check",
    "limit",
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
  // Read the brief once here, so the file checked is the file sent.
  const brief =
    opts.brief &&
    orIfMissing(
      () => readFileSync(opts.brief, "utf8"),
      hasErrorCode("ENOENT"),
      undefined
    );
  if (opts.brief && brief === undefined) fail(`brief not found: ${opts.brief}`);
  const startCheck = Number(opts["start-check"] ?? 180);
  if (!(startCheck > 0))
    fail("--start-check must be a positive number of seconds");
  const limit = Number(opts.limit ?? 110);
  if (!(limit > 0)) fail("--limit must be a positive number of minutes");
  return {
    ...opts,
    text: opts.brief ? brief : opts.message,
    startCheckMs: startCheck * 1000,
    limitMs: limit * 60_000,
  };
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
const message = opts.text;
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
// A signal to the runner stops the worker the same way as the limit, and the runner ends only after the group is gone.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => void stopThenExit(signal));
}

// How long the group gets to end after SIGTERM, and after SIGKILL, before the runner gives up on it.
const termGraceMs = 5_000;
const killWaitMs = 10_000;

/**
 * Stops the worker's process group (the worker runs in its own group so it can be stopped with everything it started)
 * and resolves once the whole group is gone: SIGTERM, then SIGKILL if anything is left after the grace, then a bounded
 * wait. A group that is already gone (ESRCH) is fine; any other failure to signal or check it rejects with its cause,
 * since the group may still run. Every stop goes through here, and one call per worker is shared.
 */
const stopping = new WeakMap();
function stop(proc) {
  if (!stopping.has(proc)) stopping.set(proc, stopGroup(proc.pid));
  return stopping.get(proc);
}

async function stopGroup(pgid) {
  if (!killUnlessGone(-pgid, "SIGTERM")) return;
  if (await groupEnds(pgid, termGraceMs)) return;
  killUnlessGone(-pgid, "SIGKILL");
  if (!(await groupEnds(pgid, killWaitMs)))
    throw new Error(
      `the worker process group ${pgid} was still running ${killWaitMs / 1000}s after SIGKILL`
    );
}

/** Whether the group is gone within `withinMs`. A member is alive until it is reaped (signal 0 answers for zombies too). */
async function groupEnds(pgid, withinMs) {
  const deadline = Date.now() + withinMs;
  while (processAlive(-pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

async function stopThenExit(signal) {
  if (child) await continueAfterFailure(() => stop(child), reportStopFailure);
  process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]);
}

const reportStopFailure = (error) =>
  console.error(
    `could not confirm the worker process group stopped: ${error.cause?.message ?? error.message}`
  );

// Events written so far. No output file yet means no events; a line that is not JSON (a partly written last line) is skipped.
function readEvents() {
  return orIfMissing(
    () => readFileSync(opts.out, "utf8"),
    hasErrorCode("ENOENT"),
    ""
  )
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => orIfUnreadable(() => [JSON.parse(line)], []));
}

const sessionOf = (events) => events.find((e) => e.sessionID)?.sessionID ?? "";

/** One launch of opencode. It is stopped at the call's deadline (`deadlineAt`, shared by every attempt). */
function runOnce(deadlineAt) {
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
  let overLimit = false;
  const check = setTimeout(() => {
    if (!sessionOf(readEvents())) {
      stalled = true;
      // The exit handler below waits for this stop and receives its failure.
      void settled(stop(proc));
    }
  }, opts.startCheckMs);
  const limit = setTimeout(
    () => {
      overLimit = true;
      // The exit handler below waits for this stop and receives its failure.
      void settled(stop(proc));
    },
    Math.max(0, deadlineAt - Date.now())
  );
  return new Promise((done) => {
    proc.on("error", (error) => {
      clearTimeout(check);
      clearTimeout(limit);
      done({ code: 127, stalled: false, spawnError: error.message });
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(check);
      clearTimeout(limit);
      const ended = { code: code ?? 128, signal, stalled, overLimit };
      // A stopped worker's leader can end while the rest of its group is still running. Wait for the whole group
      // before this attempt counts as over, and report a group that could not be confirmed gone.
      if (!stalled && !overLimit) return done(ended);
      stop(proc).then(
        () => done(ended),
        (error) => done({ ...ended, stopFailure: error })
      );
    });
  });
}

const started = Date.now();
// --limit bounds the whole call, retries included: one deadline from the start, and no new attempt once it is reached.
const deadlineAt = started + opts.limitMs;
let attempts = 0;
let result;
let events;
do {
  attempts += 1;
  result = await runOnce(deadlineAt);
  events = readEvents();
} while (
  attempts < 2 &&
  !result.spawnError &&
  !result.overLimit &&
  Date.now() < deadlineAt &&
  !sessionOf(events)
);

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
else if (result.stopFailure)
  [status, exitCode] = [
    `stopped, but ${result.stopFailure.cause?.message ?? result.stopFailure.message}`,
    4,
  ];
else if (errors.length) [status, exitCode] = ["error", 2];
else if (result.overLimit || (!session && Date.now() >= deadlineAt))
  [status, exitCode] = [
    `stopped after the ${opts.limitMs / 60_000}-minute limit`,
    4,
  ];
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
