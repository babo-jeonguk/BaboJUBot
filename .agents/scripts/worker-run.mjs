// The attempts of one worker call and how it ends, for run-worker.mjs. Launching opencode and stopping its process
// group are passed in, so the rules here are tested with stand-ins on every system (worker-run.test.mjs).
//
// - A call makes at most two attempts: an attempt that never starts a session is launched once more.
// - --limit is one deadline for the whole call, retries included.
// - Once an attempt is being stopped (start check, --limit, a signal to the runner), that attempt ends with the
//   result of stopping its group, not with its leader's exit. A failed stop ends the call: no new attempt, and the
//   reason is kept in the result.

/**
 * @param {{
 *   launch: () => import("node:child_process").ChildProcess,
 *   stop: (proc: import("node:child_process").ChildProcess) => Promise<void>,
 *   hasSession: () => boolean,
 *   startCheckMs: number,
 *   limitMs: number,
 * }} options
 */
export function createWorkerRun({
  launch,
  stop,
  hasSession,
  startCheckMs,
  limitMs,
}) {
  /** What asked the whole call to stop (a signal name), if anything. */
  let requested;
  /** Stops the running attempt, if one is running. */
  let stopCurrent;

  function attempt(proc, deadlineAt) {
    return new Promise((done) => {
      let stopping;
      let exit;
      let finished = false;
      const timers = [];
      const finish = (result) => {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        stopCurrent = undefined;
        done(result);
      };
      // From here on the attempt waits for the stop only: its leader may end long before the rest of its group.
      const stopFor = (reason) => {
        if (stopping || finished) return;
        stopping = reason;
        for (const timer of timers) clearTimeout(timer);
        stop(proc).then(
          () => finish({ stopped: reason, exit }),
          (error) => finish({ stopped: reason, exit, stopFailure: error })
        );
      };
      stopCurrent = stopFor;
      timers.push(
        setTimeout(() => {
          if (!hasSession()) stopFor("start-check");
        }, startCheckMs),
        setTimeout(() => stopFor("limit"), Math.max(0, deadlineAt - Date.now()))
      );
      proc.on("error", (error) => {
        if (!stopping) finish({ spawnError: error.message });
      });
      proc.on("exit", (code, signal) => {
        exit = { code, signal };
        if (!stopping) finish({ exit });
      });
      if (requested) stopFor(requested);
    });
  }

  return {
    /** Ask the call to stop (a signal to the runner): the running attempt is stopped and no new one starts. */
    requestStop(signal) {
      requested ??= signal;
      stopCurrent?.(signal);
    },
    /** Runs the attempts. Resolves with how many were made, the last attempt's result and the call's deadline. */
    async run() {
      const deadlineAt = Date.now() + limitMs;
      let attempts = 0;
      let result;
      do {
        attempts += 1;
        result = await attempt(launch(), deadlineAt);
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

const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * The status line and exit code of a finished call. Exit codes: 0 finished; 2 error event; 3 no session started;
 * 4 spawn failed, the group could not be confirmed stopped, the call reached --limit, or opencode failed without an
 * error event; 128+n stopped by signal n.
 */
export function outcome({
  result,
  requested,
  deadlineAt,
  limitMs,
  session,
  errors,
  now = Date.now(),
}) {
  if (result.spawnError) return [`spawn failed: ${result.spawnError}`, 4];
  if (result.stopFailure) {
    const why = result.stopFailure.cause?.message ?? result.stopFailure.message;
    return [
      `could not confirm the worker process group stopped (${result.stopped}): ${why}`,
      4,
    ];
  }
  const signal =
    requested ?? (result.stopped in signalNumbers ? result.stopped : undefined);
  if (signal) return [`stopped by ${signal}`, 128 + signalNumbers[signal]];
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
