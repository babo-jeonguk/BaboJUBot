// The attempts of one worker call and how it ends, for run-worker.ts. Launching opencode is passed in as a function that
// returns the launched tree with its own stop (the product's shared launch, @babojubot/process), so the rules here are
// tested with stand-ins on every system (worker-run.test.ts).
//
// - A call makes at most two attempts: an attempt that never starts a session is launched once more.
// - --limit is one deadline for the whole call, retries included.
// - Every attempt ends with the result of stopping its tree: the tree's stop confirms that everything the worker started has
//   ended. Once an attempt is being stopped (start check, --limit, a signal to the runner), it ends with that stop, not with its
//   leader's exit; a worker that ends on its own is stopped too, for what it left running. A failed stop ends the call: no new
//   attempt, and the reason is kept in the result.
// - An attempt also ends with whether its brief reached the worker: a brief that could not be sent is that attempt's run
//   failure, kept in its own result, so a later attempt that sends it is not marked by it. The attempt's end never hangs on
//   the write: only a tree confirmed stopped leaves no reader, so only then does the attempt wait for the write's end
//   (`delivered`). An attempt that ends otherwise (the stop failed, the start failed) ends the write where it stands
//   (`abandonBrief`), and its stop or start failure stays first.

import type { Clock, TreeExit, TreeStart } from "@babojubot/process";

/**
 * `delivered` settles with why the brief could not be sent to this worker (an error code), or undefined once it was sent. It
 * settles on its own once nothing can read the brief any more (the tree is confirmed stopped). `abandonBrief` ends a write
 * still going (the runner closes its end of the worker's input) and returns at once how the send stands: why it failed,
 * that it was not all written yet, or undefined when it was sent.
 */
export interface WorkerTree {
  started: Promise<TreeStart>;
  exited: Promise<TreeExit>;
  stop: () => Promise<void>;
  delivered: Promise<string | undefined>;
  abandonBrief: () => string | undefined;
}

/** A signal to the runner that stops the whole call. */
export type StopSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

const signalNumbers: Record<StopSignal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

const isStopSignal = (reason: string | undefined): reason is StopSignal =>
  reason === "SIGHUP" || reason === "SIGINT" || reason === "SIGTERM";

/** Why an attempt was being stopped: the start check, --limit, its worker ending on its own, or a signal to the runner. */
export type StopReason = "start-check" | "limit" | "exit" | StopSignal;

/** How one attempt ended. */
export interface AttemptResult {
  /** What the attempt was being stopped for; absent when its worker ended on its own and the stop went through. */
  stopped?: StopReason;
  /** The worker's leader exit, if it was seen. */
  exit?: TreeExit;
  /** Why the tree could not be confirmed stopped. */
  stopFailure?: unknown;
  /** Why the worker could not start (refused or failed to start). */
  spawnError?: string;
  /** Why the brief did not all reach the worker. */
  sendFailure?: string;
}

/** A launched attempt, or why the launch was refused. */
type Launched = { tree: WorkerTree } | { refused: string };

export function createWorkerRun({
  launch,
  hasSession,
  startCheckMs,
  limitMs,
}: {
  launch: () => WorkerTree;
  hasSession: () => boolean;
  startCheckMs: number;
  limitMs: number;
  /** The clock the start check and --limit are measured on (the real clock in run-worker.ts). */
  clock: Clock;
}) {
  /** What asked the whole call to stop (a signal name), if anything. */
  let requested: StopSignal | undefined;
  /** Stops the running attempt, if one is running. */
  let stopCurrent: ((reason: StopReason) => void) | undefined;

  /** Launches one attempt. A launch that throws (refused, could not start) is the attempt's start failure. */
  function start(): Launched {
    try {
      return { tree: launch() };
    } catch (error) {
      return {
        refused: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function attempt(launched: Launched, deadlineAt: number) {
    if ("refused" in launched)
      return Promise.resolve<AttemptResult>({ spawnError: launched.refused });
    const { tree } = launched;
    return new Promise<AttemptResult>((done) => {
      let stopping: StopReason | undefined;
      let exit: TreeExit | undefined;
      let finished = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      // The attempt's result also says whether its brief reached the worker. A tree confirmed stopped has no reader left, so
      // its write ends (sent, or failed because the worker's input closed) and the attempt waits for that. A failed stop or
      // start leaves that unknown: a live worker that never reads would hold the write forever, so the attempt ends it now.
      const finish = (result: AttemptResult) => {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        stopCurrent = undefined;
        const withSend = (sendFailure: string | undefined) =>
          sendFailure === undefined ? result : { ...result, sendFailure };
        if (result.stopFailure || result.spawnError)
          done(withSend(tree.abandonBrief()));
        else void tree.delivered.then((sent) => done(withSend(sent)));
      };
      // From here on the attempt waits for the stop only: its leader may end long before the rest of its tree.
      const stopFor = (reason: StopReason) => {
        if (stopping || finished) return;
        stopping = reason;
        for (const timer of timers) clearTimeout(timer);
        tree.stop().then(
          () => finish({ stopped: reason, exit }),
          (error: unknown) =>
            finish({ stopped: reason, exit, stopFailure: error })
        );
      };
      stopCurrent = stopFor;
      timers.push(
        setTimeout(() => {
          if (!hasSession()) stopFor("start-check");
        }, startCheckMs),
        setTimeout(() => stopFor("limit"), Math.max(0, deadlineAt - Date.now()))
      );
      void tree.started.then((started) => {
        if (started.kind === "failed" && !stopping)
          finish({ spawnError: started.reason });
      });
      void tree.exited.then((ended) => {
        exit = ended;
        if (stopping || finished) return;
        // The worker ended on its own. Stop what it left running; the attempt ends with that stop.
        stopping = "exit";
        for (const timer of timers) clearTimeout(timer);
        tree.stop().then(
          () => finish({ exit }),
          (error: unknown) =>
            finish({ stopped: "exit", exit, stopFailure: error })
        );
      });
      if (requested) stopFor(requested);
    });
  }

  return {
    /** Ask the call to stop (a signal to the runner): the running attempt is stopped and no new one starts. */
    requestStop(signal: StopSignal) {
      requested ??= signal;
      stopCurrent?.(signal);
    },
    /** Runs the attempts. Resolves with how many were made, the last attempt's result and the call's deadline. */
    async run() {
      const deadlineAt = Date.now() + limitMs;
      let attempts = 0;
      let result: AttemptResult;
      do {
        attempts += 1;
        result = await attempt(start(), deadlineAt);
      } while (
        attempts < 2 &&
        !requested &&
        !result.spawnError &&
        !result.stopFailure &&
        result.stopped !== "limit" &&
        Date.now() < deadlineAt &&
        !hasSession()
      );
      return { attempts, result, deadlineAt, requested };
    },
  };
}

/** The message of a failed stop: its cause when it has one (the supervisor's reason), else its own. */
function stopReasonOf(failure: unknown) {
  if (!(failure instanceof Error)) return String(failure);
  return failure.cause instanceof Error
    ? failure.cause.message
    : failure.message;
}

/**
 * The status line and exit code of a finished call. Exit codes: 0 finished; 2 error event; 3 no session started;
 * 4 spawn failed or refused, the tree could not be confirmed stopped, the brief could not be sent to the worker, the call reached
 * --limit, or opencode failed without an error event; 128+n stopped by signal n. A brief that could not be sent is a run
 * failure, not an error event: exit code 2 tells the caller to move to the next model, which would not help.
 */
export function outcome({
  result,
  requested,
  deadlineAt,
  limitMs,
  session,
  errors,
  now = Date.now(),
}: {
  result: AttemptResult;
  requested?: StopSignal | undefined;
  deadlineAt: number;
  limitMs: number;
  session: string;
  errors: string[];
  now?: number;
}): [status: string, exitCode: number] {
  if (result.spawnError) return [`spawn failed: ${result.spawnError}`, 4];
  if (result.stopFailure) {
    const when = result.stopped === "exit" ? "after it ended" : result.stopped;
    return [
      `could not confirm the worker process tree stopped (${when}): ${stopReasonOf(result.stopFailure)}`,
      4,
    ];
  }
  const signal =
    requested ?? (isStopSignal(result.stopped) ? result.stopped : undefined);
  if (signal) return [`stopped by ${signal}`, 128 + signalNumbers[signal]];
  if (result.sendFailure)
    return [`could not send the brief: ${result.sendFailure}`, 4];
  if (errors.length) return ["error", 2];
  if (result.stopped === "limit" || (!session && now >= deadlineAt))
    return [`stopped after the ${limitMs / 60_000}-minute limit`, 4];
  if (!session) return ["no session started", 3];
  if (result.exit?.code !== 0)
    return [
      `opencode exited ${result.exit?.signal ?? result.exit?.code ?? "unknown"}`,
      4,
    ];
  return ["finished", 0];
}
