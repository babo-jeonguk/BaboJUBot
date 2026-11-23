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
// 3 no session started twice (parent takes over); 4 opencode failed without an error event, could not start (also when
// the supervisor is not available: the runner refuses to start a worker it could not stop), the call reached
// --limit (a limit on the whole call, retries included; default 110 minutes, inside the parent's 2-hour background limit), or
// the worker's process tree could not be confirmed stopped (no retry after that); 128+n stopped by signal n; 1 usage.
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, prepareSupervisor } from "@babojubot/process";
import {
  continueAfterFailure,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts";
import { createWorkerRun, outcome } from "./worker-run.mjs";

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
  /** @type {Map<string, string>} 인수 이름 → 값 */
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (name === undefined || !known.has(name) || value === undefined)
      fail(`bad argument: ${argv[i]}`);
    values.set(name, value);
  }
  const model = values.get("model");
  const title = values.get("title");
  const out = values.get("out");
  if (!model || !title || !out) fail("--model, --title and --out are required");
  const briefFile = values.get("brief");
  const message = values.get("message");
  let text;
  if (briefFile && !message) {
    // Read the brief once here, so the file checked is the file sent.
    text = orIfMissing(
      () => readFileSync(briefFile, "utf8"),
      hasErrorCode("ENOENT"),
      undefined
    );
    if (text === undefined) fail(`brief not found: ${briefFile}`);
  } else if (message && !briefFile) text = message;
  else fail("give exactly one of --brief and --message");
  const startCheck = Number(values.get("start-check") ?? 180);
  if (!(startCheck > 0))
    fail("--start-check must be a positive number of seconds");
  const limit = Number(values.get("limit") ?? 110);
  if (!(limit > 0)) fail("--limit must be a positive number of minutes");
  return {
    model,
    title,
    out,
    session: values.get("session"),
    text,
    startCheckMs: startCheck * 1000,
    limitMs: limit * 60_000,
  };
}

/** @returns {never} */
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

/**
 * Launches opencode through the product's shared launch, which returns the tree with the stop that matches how it was
 * launched: its own process group and a marker (Linux, macOS; commands that leave for a new session carry the marker), or
 * a Windows job object. The stop confirms the whole tree ended and rejects when it cannot. On Windows a worker is not
 * started without the job object (the launch throws, and the call ends with the reason).
 */
function launch() {
  const out = openSync(opts.out, "w");
  const err = openSync(errFile, "w");
  try {
    return launchTree({
      command: ["opencode"],
      args,
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_CONFIG: config },
      stdio: ["ignore", out, err],
    });
  } finally {
    // opencode holds its own copies. A file that cannot be closed only stays open until the runner ends.
    continueAfterFailure(
      () => closeSync(out),
      (error) => console.error(`could not close ${opts.out}: ${error}`)
    );
    continueAfterFailure(
      () => closeSync(err),
      (error) => console.error(`could not close ${errFile}: ${error}`)
    );
  }
}

// Every system starts the worker under the supervisor built from this checkout. If it cannot be prepared, the launch refuses with
// the reason.
await prepareSupervisor();
const started = Date.now();
// The start check, --limit and a signal to the runner all stop through the tree's own stop, and the attempt ends with its
// result (worker-run.mjs). A worker that ends on its own is stopped too, for what it left running.
const workerRun = createWorkerRun({
  launch,
  hasSession: () => Boolean(sessionOf(readEvents())),
  startCheckMs: opts.startCheckMs,
  limitMs: opts.limitMs,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => workerRun.requestStop(signal));
const { attempts, result, deadlineAt, requested } = await workerRun.run();
const events = readEvents();

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

const [status, exitCode] = outcome({
  result,
  requested,
  deadlineAt,
  limitMs: opts.limitMs,
  session,
  errors,
});

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
