import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexProvider } from "./codex.ts";
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
});
