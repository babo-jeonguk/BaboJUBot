#!/usr/bin/env node
// Runs one code-edit worker turn under .agents/opencode-worker.json and waits for it, so the
// parent wakes once: it relaunches a run that never starts a session, then prints a short summary
// of the result. Contract: docs/agents/review-fixes.md 「코드 수정 worker」.
//
// usage: node .agents/scripts/run-worker.ts --model <provider/model> --title <title>
//          --out <file.jsonl> (--brief <file> | --message <text>)
//          [--session <sessionID>] [--start-check <seconds>] [--limit <minutes>]
//
// The brief (the --brief file's text as read once, or --message) goes to opencode on its standard input, never as a command
// argument: opencode run reads a message from standard input when none is given as an argument, and on Windows an
// npm-installed opencode is a .cmd that cmd.exe starts, which cuts an argument at its first line break (#284).
//
// Exit codes: 0 finished without an error event; 2 error event (move to the next model);
// 3 no session started twice (parent takes over); 4 opencode failed without an error event, could not start (also when
// the supervisor is not available: the runner refuses to start a worker it could not stop), the brief could not be sent to the
// worker (a run failure, not a model's error event), the call reached
// --limit (a limit on the whole call, retries included; default 110 minutes, inside the parent's 2-hour background limit), or
// the worker's process tree could not be confirmed stopped (no retry after that); 128+n stopped by signal n; 1 usage.
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, prepareSupervisor } from "@babojubot/process";
import type { Writable } from "node:stream";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts";
import { field, numberField, textField } from "./json-field.ts";
import {
  createWorkerRun,
  outcome,
  type StopSignal,
  type WorkerTree,
} from "./worker-run.ts";

const USAGE = `usage: run-worker.ts --model <provider/model> --title <title> --out <file.jsonl>
  (--brief <file> | --message <text>) [--session <sessionID>] [--start-check <seconds>]
  [--limit <minutes>]`;

function parseArgs(argv: string[]) {
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
  /** 인수 이름 → 값 */
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (name === undefined || !known.has(name) || value === undefined)
      fail(`bad argument: ${argv[i]}`);
    // 두 번 주면 어느 값을 쓸지 정하지 않는다(전에는 뒤 값이 조용히 이겼다).
    if (values.has(name)) fail(`--${name} given twice`);
    values.set(name, value);
  }
  const model = values.get("model");
  const title = values.get("title");
  const out = values.get("out");
  if (!model || !title || !out) fail("--model, --title and --out are required");
  const briefFile = values.get("brief");
  const message = values.get("message");
  let text: string | undefined;
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
  // 위 갈래는 지침을 읽었거나 끝났다(fail은 돌아오지 않는다). 빈 파일도 지침이다.
  if (text === undefined) fail("give exactly one of --brief and --message");
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

function fail(message: string): never {
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

/** The send result of a brief the runner stopped writing before it was all written (`abandonBrief`). */
const unfinished = "not all written when the attempt ended";

/**
 * Writes the brief to one worker's standard input and closes it, so opencode reads the whole brief and knows it ended. The
 * result belongs to that worker's attempt (worker-run.ts `delivered`, `abandonBrief`): `delivered` settles with why it could
 * not be sent (an error code, e.g. EPIPE when the worker ended without reading), or undefined once sent. `abandonBrief` ends a
 * write still going by closing the runner's end of the input (a live worker that never reads holds it otherwise), and returns
 * how the send stands.
 */
function sendBrief(
  stdin: Writable | null
): Pick<WorkerTree, "delivered" | "abandonBrief"> {
  if (!stdin)
    return {
      delivered: Promise.resolve("no standard input"),
      abandonBrief: () => "no standard input",
    };
  const send = Promise.withResolvers<string | undefined>();
  let sending = true;
  let failure: string | undefined;
  const settle = (result: string | undefined) => {
    if (!sending) return;
    sending = false;
    failure = result;
    send.resolve(result);
  };
  // Node passes the end callback the write's error (its type declaration leaves the argument out); the listener keeps a later
  // error from being unhandled.
  stdin.on("error", (error: Error) => settle(failureCode(error)));
  stdin.end(message, (error?: Error | null) =>
    settle(error ? failureCode(error) : undefined)
  );
  return {
    delivered: send.promise,
    abandonBrief: () => {
      if (sending) {
        settle(unfinished);
        stdin.destroy();
      }
      return failure;
    },
  };
}

/** What the summary reads from one of opencode's JSON event lines. Lines it does not know read as empty. */
interface WorkerEvent {
  type: string | undefined;
  sessionID: string | undefined;
  /** The `error` of an error event. */
  error: unknown;
  /** The `part` of a tool, step or text event. */
  part: unknown;
}

const toEvent = (line: unknown): WorkerEvent => ({
  type: textField(line, "type"),
  sessionID: textField(line, "sessionID"),
  error: field(line, "error"),
  part: field(line, "part"),
});

// Events written so far. No output file yet means no events; a line that is not JSON (a partly written last line) is skipped.
function readEvents(): WorkerEvent[] {
  return orIfMissing(
    () => readFileSync(opts.out, "utf8"),
    hasErrorCode("ENOENT"),
    ""
  )
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => orIfUnreadable((): unknown[] => [JSON.parse(line)], []))
    .map(toEvent);
}

const sessionOf = (events: WorkerEvent[]) =>
  events.find((e) => e.sessionID)?.sessionID ?? "";

/**
 * Launches opencode through the product's shared launch, which returns the tree with the stop that matches how it was
 * launched: its own process group and a marker (Linux, macOS; commands that leave for a new session carry the marker), or
 * a Windows job object. The stop confirms the whole tree ended and rejects when it cannot. On Windows a worker is not
 * started without the job object (the launch throws, and the call ends with the reason).
 */
function launch(): WorkerTree {
  const out = openSync(opts.out, "w");
  const err = openSync(errFile, "w");
  try {
    const tree = launchTree({
      command: ["opencode"],
      args,
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_CONFIG: config },
      stdio: ["pipe", out, err],
    });
    return {
      started: tree.started,
      exited: tree.exited,
      stop: () => tree.stop(),
      ...sendBrief(tree.stdin),
    };
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
// result (worker-run.ts). A worker that ends on its own is stopped too, for what it left running.
const workerRun = createWorkerRun({
  launch,
  hasSession: () => Boolean(sessionOf(readEvents())),
  startCheckMs: opts.startCheckMs,
  limitMs: opts.limitMs,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] satisfies StopSignal[])
  process.on(signal, () => workerRun.requestStop(signal));
const { attempts, result, deadlineAt, requested } = await workerRun.run();
const events = readEvents();

const session = sessionOf(events);
const errors = events
  .filter((e) => e.type === "error")
  .map((e) => textField(e.error, "message") ?? JSON.stringify(e.error));
/** A tool call: the tool, its state and the input it was given. */
const tools = events
  .filter((e) => e.type === "tool_use")
  .map(({ part }) => {
    const state = field(part, "state");
    const input = field(state, "input");
    return {
      tool: textField(part, "tool"),
      status: textField(state, "status"),
      error: textField(state, "error"),
      command: textField(input, "command"),
      file: textField(input, "filePath") ?? textField(input, "path"),
    };
  });
const written = [
  ...new Set(
    tools
      .filter(
        (t) =>
          ["edit", "write", "patch", "multiedit"].includes(t.tool ?? "") &&
          t.status === "completed"
      )
      .flatMap((t) => (t.file ? [t.file.replace(`${process.cwd()}/`, "")] : []))
  ),
];
const denied = tools
  .filter((t) => /Permission denied|rejected/i.test(t.error ?? ""))
  .map((t) => `${t.tool}: ${t.command ?? t.file ?? ""}`);
const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
for (const e of events.filter((e) => e.type === "step_finish")) {
  const t = field(e.part, "tokens");
  tokens.input += numberField(t, "input") ?? 0;
  tokens.output += numberField(t, "output") ?? 0;
  tokens.reasoning += numberField(t, "reasoning") ?? 0;
  tokens.cacheRead += numberField(field(t, "cache"), "read") ?? 0;
}
const report =
  textField(events.filter((e) => e.type === "text").at(-1)?.part, "text") ?? "";

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
