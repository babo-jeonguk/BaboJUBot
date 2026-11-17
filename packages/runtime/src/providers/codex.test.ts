import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexProvider, type CodexOptions } from "./codex.ts";
import { request } from "./test-support.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it("initializes an app-server, runs a turn, and keeps unreported usage null", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-test-"));
  try {
    const provider = createCodexProvider({
      dataDir,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        path.resolve("test-fixtures/codex-finish.synthetic.json"),
      ],
    });
    const result = await provider.adapter.execute(request(), {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toBe("thread-one");
    expect(result.usage).toEqual({
      inputTokens: 9,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      costUsd: null,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("accepts steering only after the expected turn acknowledgment", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-steer-"));
  try {
    const provider = createCodexProvider({
      dataDir,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        path.resolve("test-fixtures/codex-steer.synthetic.json"),
      ],
    });
    const input = request();
    const message = {
      runId: input.identity.runId,
      messageId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      body: "추가 검증",
    };
    expect(provider.adapter.capabilities.steer).toBe(true);
    const result = await provider.adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {
        expect(await provider.adapter.steer!(message)).toBe("accepted");
      },
    });
    expect(result.stopReason).toBe("completed");
    expect(await provider.adapter.steer!(message)).toBe("rejected");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("resumes the requested thread and reports only this attempt usage", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-resume-"));
  try {
    const provider = createCodexProvider({
      dataDir,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        path.resolve("test-fixtures/codex-resume.synthetic.json"),
      ],
    });
    const input = request();
    input.previousSession = {
      id: "thread-one",
      tokens: { inputTokens: 8, outputTokens: 1, cachedInputTokens: 2 },
    };
    const result = await provider.adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheWriteTokens: null,
      costUsd: null,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("checks version and product login without starting a model turn", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-readiness-"));
  try {
    const provider = createCodexProvider({
      dataDir,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        path.resolve("test-fixtures/codex-finish.synthetic.json"),
      ],
    });
    expect(
      await provider.adapter.checkReadiness(new AbortController().signal)
    ).toEqual({ status: "unknown", reason: "credentials_unverified" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("runs the exec alternative with steering explicitly unsupported", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-exec-"));
  try {
    const provider = createCodexProvider({
      dataDir,
      mode: "exec",
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        path.resolve("test-fixtures/codex-exec.synthetic.json"),
      ],
    });
    expect(provider.adapter.capabilities.steer).toBe(false);
    expect(provider.adapter.steer).toBeUndefined();
    const result = await provider.adapter.execute(request(), {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toBe("exec-thread");
    expect(result.usage).toEqual({
      inputTokens: 9,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      costUsd: null,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("reads the app-server model catalog without starting a model turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-catalog-"));
  roots.push(root);
  const fixture = path.join(root, "catalog.json");
  await writeFile(
    fixture,
    JSON.stringify({
      version: "codex-cli 9.9.9",
      steps: [
        { input: { id: 1, method: "initialize" } },
        { frame: { id: 1, result: {} } },
        { input: { method: "initialized" } },
        { input: { id: 2, method: "model/list" } },
        {
          frame: {
            id: 2,
            result: {
              data: [
                {
                  id: "model-one",
                  model: "model-one",
                  displayName: "Model One",
                },
              ],
              nextCursor: null,
            },
          },
        },
        { exit: 0 },
      ],
    })
  );
  const provider = createCodexProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ],
  });
  expect(await provider.listModels!(new AbortController().signal)).toEqual([
    { id: "model-one", label: "Model One" },
  ]);
});

type Saved = Record<string, number | string | null>;
describe("usage numbers outside the contract (#140)", () => {
  /** The synthetic exchange with Codex's cumulative totals replaced, run on the saved session `thread-one`. */
  async function run(
    mode: "app-server" | "exec",
    totals: Record<string, unknown>,
    saved: Saved
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
    roots.push(root);
    const source = path.resolve(
      mode === "exec"
        ? "test-fixtures/codex-exec.synthetic.json"
        : "test-fixtures/codex-resume.synthetic.json"
    );
    const fixture = JSON.parse(await readFile(source, "utf8"));
    for (const step of fixture.steps) {
      if (step.frame?.method === "thread/tokenUsage/updated")
        step.frame.params.tokenUsage.total = totals;
      if (step.frame?.type === "turn.completed") step.frame.usage = totals;
    }
    const file = path.join(root, "fixture.json");
    await writeFile(file, JSON.stringify(fixture));
    const input = request();
    input.previousSession = { id: "thread-one", tokens: saved };
    return createCodexProvider({
      dataDir: root,
      mode,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        file,
      ],
    }).adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {},
    });
  }
  const warnings = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return {
      lines: () => warn.mock.calls.map((call) => call.join(" ")),
      [Symbol.dispose]: () => warn.mockRestore(),
    };
  };

  it("does not take a decreased total as zero and keeps a cache larger than the input", async () => {
    using warn = warnings();
    const result = await run(
      "app-server",
      { inputTokens: 100, outputTokens: 90, cachedInputTokens: 120 },
      { outputTokens: 100 }
    );
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toBe("thread-one");
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 120,
      cacheWriteTokens: null,
      costUsd: null,
    });
    expect(warn.lines()).toEqual([
      expect.stringMatching(/inputTokens.*negative_result/),
      expect.stringMatching(/outputTokens.*negative_result/),
    ]);
  });

  it("leaves a bad cache and the input that needs it unreported, and the next run does not read the bad total as unreported", async () => {
    using warn = warnings();
    const first = await run(
      "app-server",
      { inputTokens: 10, outputTokens: 4, cachedInputTokens: 1.5 },
      {}
    );
    expect(first.stopReason).toBe("completed");
    expect(first.usage).toEqual({
      inputTokens: null,
      outputTokens: 4,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
    expect(warn.lines()).toEqual([
      expect.stringMatching(/inputTokens.*invalid_operand/),
      expect.stringMatching(/cacheReadTokens.*invalid_value/),
    ]);
    const second = await run(
      "app-server",
      { inputTokens: 20, outputTokens: 9, cachedInputTokens: 6 },
      first.nextSession!.tokens as Saved
    );
    expect(second.usage).toEqual({
      inputTokens: null,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });

  it("keeps reading an unreported baseline as zero, and a total as unreported when it was not reported", async () => {
    const result = await run(
      "app-server",
      { inputTokens: 12, outputTokens: 5 },
      { inputTokens: 2, outputTokens: null }
    );
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });

  it("applies the same rules to the exec alternative", async () => {
    using _ = warnings();
    const result = await run(
      "exec",
      {
        input_tokens: 100,
        cached_input_tokens: 120,
        output_tokens: Number.MAX_SAFE_INTEGER + 1,
        cache_write_input_tokens: 3,
      },
      { input_tokens: 0, cache_write_input_tokens: 5 }
    );
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toBe("exec-thread");
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 120,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });

  /** The resumed exchange that reports a total and then stops before the turn completes. */
  async function unfinished(
    ending: "cancel" | "exit",
    totals: Record<string, unknown>
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
    roots.push(root);
    const fixture = JSON.parse(
      await readFile(
        path.resolve("test-fixtures/codex-resume.synthetic.json"),
        "utf8"
      )
    );
    const steps: Record<string, any>[] = fixture.steps;
    const usage = steps.find(
      (step) => step.frame?.method === "thread/tokenUsage/updated"
    )!;
    usage.frame.params.tokenUsage.total = totals;
    const started = steps.findIndex((step) => step.frame?.id === 3);
    const rest = steps.filter(
      (step) => step !== usage && step.frame?.method !== "turn/completed"
    );
    rest.splice(rest.indexOf(steps[started]!), 0, usage);
    // Cancel: the run is cancelled once it reports that work began (after the total). Exit: the program ends without a result.
    fixture.steps = rest.filter(
      (step) => ending === "exit" || step.exit === undefined
    );
    if (ending === "exit") fixture.steps.push({ exit: 1 });
    const file = path.join(root, "fixture.json");
    await writeFile(file, JSON.stringify(fixture));
    const input = request();
    input.previousSession = { id: "thread-one", tokens: { inputTokens: 2 } };
    const controller = new AbortController();
    return createCodexProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        file,
      ],
    }).adapter.execute(input, {
      signal: controller.signal,
      emit: async () => {
        if (ending === "cancel") controller.abort();
      },
    });
  }

  it("keeps the total already reported when the run is cancelled before the turn completes", async () => {
    using _ = warnings();
    const result = await unfinished("cancel", {
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 0.5,
    });
    expect(result.stopReason).toBe("cancelled");
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });

  it("keeps the total already reported when the program ends without completing the turn", async () => {
    const result = await unfinished("exit", {
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 3,
    });
    expect(result.stopReason).toBe("failed");
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });
});

describe("one app-server connection per call (#145)", () => {
  type Step = {
    delayMs?: number;
    result?: unknown;
    error?: unknown;
    silent?: boolean;
    frames?: unknown[];
    exit?: number;
  };
  /** A provider whose program is the scripted peer. `sent()` lists the frames the program received, in order. */
  async function scripted(
    steps: Record<string, Step[]>,
    timeouts?: CodexOptions["timeouts"]
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "codex-lifetime-"));
    roots.push(root);
    const log = path.join(root, "received.jsonl");
    const script = path.join(root, "script.json");
    await writeFile(script, JSON.stringify({ log, steps }));
    const provider = createCodexProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/codex-peer.synthetic.mjs"),
        script,
      ],
      ...(timeouts ? { timeouts } : {}),
    });
    const lines = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>);
    const sent = async () =>
      (await lines()).filter((line) => line.pid === undefined);
    const methods = async () => (await sent()).map((line) => line.method);
    /** Whether any program this provider started is still running. */
    const running = async () =>
      (await lines())
        .filter((line) => line.pid !== undefined)
        .some((line) => {
          try {
            process.kill(line.pid, 0);
            return true;
          } catch {
            return false;
          }
        });
    return { provider, sent, methods, running };
  }
  const page = (models: string[], nextCursor: string | null) => ({
    result: {
      data: models.map((model) => ({
        model,
        displayName: model.toUpperCase(),
      })),
      nextCursor,
    },
  });

  describe("the model list", () => {
    it("follows every page and starts no model turn", async () => {
      const t = await scripted({
        "model/list": [page(["one"], "next"), page(["two"], null)],
      });
      expect(
        await t.provider.listModels!(new AbortController().signal)
      ).toEqual([
        { id: "one", label: "ONE" },
        { id: "two", label: "TWO" },
      ]);
      const sent = await t.sent();
      expect(sent.map((frame) => frame.method)).toEqual([
        "initialize",
        "initialized",
        "model/list",
        "model/list",
      ]);
      expect(sent[3]!.params.cursor).toBe("next");
      expect(await t.running()).toBe(false);
    });

    it.each([
      ["an error", { error: { code: -32000, message: "no" } }],
      ["the program ending", { silent: true, exit: 1 }],
    ])(
      "returns nothing, not the pages it got, when the next page ends with %s",
      async (_case, ending) => {
        const t = await scripted({
          "model/list": [page(["one"], "next"), ending],
        });
        expect(
          await t.provider.listModels!(new AbortController().signal)
        ).toEqual([]);
        expect(await t.methods()).toEqual([
          "initialize",
          "initialized",
          "model/list",
          "model/list",
        ]);
        expect(await t.running()).toBe(false);
      }
    );

    it("keeps one deadline for the whole list instead of starting it again for each page", async () => {
      // Each answer comes well within the deadline, but all of them together do not.
      const t = await scripted(
        {
          "model/list": [
            { ...page(["one"], "next"), delayMs: 2_500 },
            { ...page(["two"], null), delayMs: 2_500 },
          ],
        },
        // Each page is well inside the limit and leaves the program 1.5 s to start; the two pages together are not.
        { modelList: 4_000 }
      );
      expect(
        await t.provider.listModels!(new AbortController().signal)
      ).toEqual([]);
      expect(await t.methods()).toEqual([
        "initialize",
        "initialized",
        "model/list",
        "model/list",
      ]);
      expect(await t.running()).toBe(false);
    });

    it("stops at once when cancelled while waiting for a page", async () => {
      const t = await scripted({
        "model/list": [page(["one"], "next"), { silent: true }],
      });
      const cancel = new AbortController();
      const listed = t.provider.listModels!(cancel.signal);
      await expect
        .poll(async () => (await t.methods()).length, { timeout: 5_000 })
        .toBe(4);
      cancel.abort();
      expect(await listed).toEqual([]);
      expect(await t.running()).toBe(false);
    }, 10_000);
  });

  describe("a run", () => {
    const thread = { result: { thread: { id: "thread-new" } } };
    const turnThatCompletes = (threadId: string) => ({
      result: { turn: { id: "turn-one" } },
      frames: [
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            tokenUsage: { total: { inputTokens: 4, outputTokens: 2 } },
          },
        },
        {
          method: "turn/completed",
          params: { threadId, turn: { id: "turn-one", status: "completed" } },
        },
      ],
    });
    const resumed = () => {
      const input = request();
      input.previousSession = {
        id: "thread-old",
        tokens: { inputTokens: 10, outputTokens: 10 },
      };
      return input;
    };
    const watch = () => {
      const progress: string[] = [];
      let returned = false,
        late = 0;
      return {
        progress,
        control: (signal = new AbortController().signal) => ({
          signal,
          emit: async (activity: unknown) => {
            if (returned) late++;
            const { type, text } = activity as { type: string; text?: string };
            if (type === "progress") progress.push(text!);
          },
        }),
        returned: () => {
          returned = true;
        },
        late: () => late,
      };
    };

    it("fails when an ordinary request goes unanswered, without sending it again", async () => {
      const t = await scripted(
        { "thread/start": [{ silent: true }] },
        { request: 2_000 }
      );
      const result = await t.provider.adapter.execute(request(), {
        signal: new AbortController().signal,
        emit: async () => {},
      });
      expect(result.stopReason).toBe("failed");
      expect(await t.methods()).toEqual([
        "initialize",
        "initialized",
        "thread/start",
      ]);
      expect(await t.running()).toBe(false);
    });

    it("fails at once, not after the request limit, when the program dies while a request waits", async () => {
      const t = await scripted({
        "thread/start": [{ silent: true, exit: 1 }],
      });
      const result = await t.provider.adapter.execute(request(), {
        signal: new AbortController().signal,
        emit: async () => {},
      });
      expect(result.stopReason).toBe("failed");
      expect(await t.running()).toBe(false);
    }, 10_000);

    it("keeps the run when a steer goes unanswered, and does not send the steer again", async () => {
      const t = await scripted(
        {
          "thread/start": [thread],
          "turn/start": [{ result: { turn: { id: "turn-one" } } }],
          "turn/steer": [
            {
              silent: true,
              delayMs: 500,
              frames: turnThatCompletes("thread-new").frames,
            },
          ],
        },
        { steer: 200 }
      );
      const input = request();
      let steered: Promise<unknown> | undefined;
      const result = await t.provider.adapter.execute(input, {
        signal: new AbortController().signal,
        emit: async () => {
          steered ??= t.provider.adapter.steer!({
            runId: input.identity.runId,
            messageId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            body: "추가",
          }).then(
            (outcome) => ({ outcome }),
            (error: unknown) => ({ error })
          );
        },
      });
      // Not answered is neither accepted nor refused: the delivery is unknown.
      expect(await steered).toEqual({ error: expect.any(Error) });
      expect(result.stopReason).toBe("completed");
      expect(
        (await t.methods()).filter((m) => m === "turn/steer")
      ).toHaveLength(1);
    });

    describe("when a steer goes unanswered", () => {
      const messageId = "message-206";
      const recordWith = (...clientIds: (string | null)[]) => ({
        result: {
          thread: {
            id: "thread-new",
            turns: [
              {
                id: "turn-one",
                status: "inProgress",
                items: [
                  ...clientIds.map((clientId, i) => ({
                    type: "userMessage",
                    id: `item-${i}`,
                    clientId,
                    content: [],
                  })),
                  { type: "agentMessage", id: "item-agent", text: "" },
                ],
              },
            ],
          },
        },
      });
      /**
       * A run whose steer is never answered and whose turn completes `completeAfterMs` after the steer.
       * `steered()` settles to `{ outcome }` or `{ error }` with how long the steer took.
       */
      async function unansweredSteer(
        read: Step[],
        completeAfterMs: number,
        timeouts: CodexOptions["timeouts"] = { steer: 200, steerRecord: 300 },
        cancel?: AbortController
      ) {
        const t = await scripted(
          {
            "thread/start": [thread],
            "turn/start": [{ result: { turn: { id: "turn-one" } } }],
            "turn/steer": [
              {
                silent: true,
                delayMs: completeAfterMs,
                frames: turnThatCompletes("thread-new").frames,
              },
            ],
            "thread/read": read,
          },
          timeouts
        );
        const input = request();
        let steered:
          | Promise<{ outcome?: unknown; error?: unknown; ms: number }>
          | undefined;
        const run = t.provider.adapter.execute(input, {
          signal: cancel?.signal ?? new AbortController().signal,
          emit: async () => {
            const start = Date.now();
            steered ??= t.provider.adapter.steer!({
              runId: input.identity.runId,
              messageId,
              conversationId: crypto.randomUUID(),
              body: "추가",
            }).then(
              (outcome) => ({ outcome, ms: Date.now() - start }),
              (error: unknown) => ({ error, ms: Date.now() - start })
            );
          },
        });
        await expect
          .poll(() => steered !== undefined, { timeout: 5_000 })
          .toBe(true);
        return { ...t, run, steered: () => steered! };
      }

      it("takes the steer as accepted when the conversation record holds its message number", async () => {
        const t = await unansweredSteer([recordWith(null, messageId)], 1_000);
        expect((await t.steered()).outcome).toBe("accepted");
        expect((await t.run).stopReason).toBe("completed");
        const methods = await t.methods();
        expect(methods.filter((m) => m === "turn/steer")).toHaveLength(1);
        expect(methods.filter((m) => m === "thread/read")).toHaveLength(1);
        // Checking the record starts no model turn.
        expect(methods.filter((m) => m === "turn/start")).toHaveLength(1);
        const read = (await t.sent()).find((f) => f.method === "thread/read");
        expect(read!.params).toEqual({
          threadId: "thread-new",
          includeTurns: true,
        });
      });

      it("takes it as accepted when the number appears more than once", async () => {
        const t = await unansweredSteer(
          [recordWith(messageId, messageId)],
          1_000
        );
        expect((await t.steered()).outcome).toBe("accepted");
        await t.run;
      });

      it.each([
        ["holds no such message", recordWith(null)],
        ["holds only another message's number", recordWith("message-other")],
        ["is refused", { error: { code: -32600, message: "no" } }],
        ["is not a record", { result: { thread: { id: "thread-new" } } }],
      ])(
        "keeps the delivery unknown when the record %s",
        async (_case, read) => {
          const t = await unansweredSteer([read as Step], 1_000);
          expect(await t.steered()).toMatchObject({
            error: expect.any(Error),
          });
          expect((await t.run).stopReason).toBe("completed");
        }
      );

      it("keeps the delivery unknown, within both limits, when the record read goes unanswered", async () => {
        const t = await unansweredSteer([{ silent: true }], 3_000);
        const steered = await t.steered();
        expect(steered).toMatchObject({ error: expect.any(Error) });
        // Steer limit 200 ms plus record limit 300 ms; the turn only ends at 3 s.
        expect(steered.ms).toBeLessThan(1_500);
        expect((await t.run).stopReason).toBe("completed");
      }, 10_000);

      it("does not read the record when the program refuses the steer", async () => {
        const t = await scripted({
          "thread/start": [thread],
          "turn/start": [{ result: { turn: { id: "turn-one" } } }],
          "turn/steer": [
            {
              error: { code: -32600, message: "no" },
              frames: turnThatCompletes("thread-new").frames,
            },
          ],
        });
        const input = request();
        let steered: Promise<unknown> | undefined;
        await t.provider.adapter.execute(input, {
          signal: new AbortController().signal,
          emit: async () => {
            steered ??= t.provider.adapter.steer!({
              runId: input.identity.runId,
              messageId,
              conversationId: crypto.randomUUID(),
              body: "추가",
            });
          },
        });
        expect(await steered).toBe("rejected");
        expect(await t.methods()).not.toContain("thread/read");
      });

      it.each([
        ["the run is cancelled", "cancel"],
        ["the program ends", "exit"],
      ] as const)(
        "stops checking at once, without accepting, when %s during the check",
        async (_case, ending) => {
          const cancel = new AbortController();
          const read: Step =
            ending === "exit"
              ? { delayMs: 300, silent: true, exit: 1 }
              : // The record would hold the number, but only after the run is gone.
                { ...recordWith(messageId), delayMs: 3_000 };
          const t = await unansweredSteer(
            [read],
            8_000,
            { steer: 200, steerRecord: 5_000 },
            cancel
          );
          if (ending === "cancel") {
            await expect
              .poll(async () => (await t.methods()).includes("thread/read"), {
                timeout: 5_000,
              })
              .toBe(true);
            cancel.abort();
          }
          const steered = await t.steered();
          expect(steered).toMatchObject({ error: expect.any(Error) });
          expect(steered.ms).toBeLessThan(2_000);
          const result = await t.run;
          expect(result.stopReason).toBe(
            ending === "cancel" ? "cancelled" : "failed"
          );
          expect(await t.running()).toBe(false);
        },
        15_000
      );
    });

    it("starts one new thread only when the program refuses the old one, with the usage counted from zero", async () => {
      const t = await scripted({
        "thread/resume": [{ error: { code: -32600, message: "not found" } }],
        "thread/start": [thread],
        "turn/start": [turnThatCompletes("thread-new")],
      });
      const w = watch();
      const result = await t.provider.adapter.execute(resumed(), w.control());
      expect(result.stopReason).toBe("completed");
      expect(result.nextSession?.id).toBe("thread-new");
      expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
      expect(
        w.progress.filter((text) => text.includes("새 세션"))
      ).toHaveLength(1);
      expect(await t.methods()).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
        "thread/start",
        "turn/start",
      ]);
    });

    it("tries the new thread only once when it is refused too", async () => {
      const refused = { error: { code: -32600, message: "no" } };
      const t = await scripted({
        "thread/resume": [refused],
        "thread/start": [refused],
      });
      const w = watch();
      const result = await t.provider.adapter.execute(resumed(), w.control());
      expect(result.stopReason).toBe("failed");
      expect(await t.methods()).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
        "thread/start",
      ]);
      expect(
        w.progress.filter((text) => text.includes("새 세션"))
      ).toHaveLength(1);
    });

    it.each([
      ["goes unanswered", { silent: true }, { request: 2_000 }],
      ["ends with the program", { silent: true, exit: 1 }, undefined],
    ])(
      "does not start a new thread when the resume %s",
      async (_case, step, timeouts) => {
        const t = await scripted({ "thread/resume": [step] }, timeouts);
        const w = watch();
        const result = await t.provider.adapter.execute(resumed(), w.control());
        w.returned();
        expect(result.stopReason).toBe("failed");
        expect(await t.methods()).toEqual([
          "initialize",
          "initialized",
          "thread/resume",
        ]);
        expect(w.progress).toEqual([]);
        expect(await t.running()).toBe(false);
      }
    );

    it.each([
      ["the handshake", "initialize"],
      ["the resume", "thread/resume"],
    ])(
      "takes a cancel during %s at once and starts nothing after it",
      async (_case, method) => {
        const t = await scripted({ [method]: [{ silent: true }] });
        const w = watch();
        const cancel = new AbortController();
        const running = t.provider.adapter.execute(
          resumed(),
          w.control(cancel.signal)
        );
        await expect
          .poll(async () => (await t.methods()).includes(method), {
            timeout: 5_000,
          })
          .toBe(true);
        cancel.abort();
        const result = await running;
        w.returned();
        expect(result.stopReason).toBe("cancelled");
        const methods = await t.methods();
        expect(methods.at(-1)).toBe(method);
        expect(methods).not.toContain("thread/start");
        expect(methods).not.toContain("turn/start");
        expect(w.progress).toEqual([]);
        expect(await t.running()).toBe(false);
        expect(w.late()).toBe(0);
      },
      10_000
    );
  });
});
