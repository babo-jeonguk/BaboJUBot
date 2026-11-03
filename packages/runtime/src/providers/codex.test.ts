import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
      version: "codex-cli 0.166.0",
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
