import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createOpenCodeProvider } from "./opencode.ts";
import { request, saying } from "./test-support.ts";
it("runs an isolated v2 server per attempt, uses a free model, and stops it after success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-test-"));
  try {
    const provider = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    expect(
      await provider.adapter.checkReadiness(new AbortController().signal)
    ).toMatchObject({ status: "ready" });
    const input = request();
    input.instructions = [{ path: "role.md", content: "제품 역할 지침" }];
    const result = await provider.adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toMatch(/^ses_/);
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("keeps its SSE stream alive beyond the startup timeout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-long-"));
  try {
    const provider = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    const input = request();
    input.wakeReasons = saying("느린 작업")(
      input.access,
      input.identity
    ).wakeReasons;
    const result = await provider.adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(result.stopReason).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

describe("usage numbers outside the contract (#140)", () => {
  async function run(usage: { before: unknown; after: unknown }) {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-usage-"));
    try {
      const file = path.join(root, "usage.json");
      await writeFile(file, JSON.stringify(usage));
      return await createOpenCodeProvider({
        dataDir: root,
        command: [
          process.execPath,
          path.resolve("test-fixtures/opencode-simulator.mjs"),
          "--usage",
          file,
        ],
      }).adapter.execute(request(), {
        signal: new AbortController().signal,
        emit: async () => {},
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("leaves a decreased, fractional or unsafe session total unreported and keeps the success and the other figures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await run({
        before: {
          tokens: { input: 100, output: 50, cache: { read: 10, write: 0 } },
          cost: 0.5,
        },
        after: {
          tokens: {
            input: 90,
            output: 60.5,
            cache: { read: 2 ** 53, write: 3 },
          },
          cost: 0.75,
        },
      });
      expect(result.stopReason).toBe("completed");
      expect(result.nextSession?.id).toMatch(/^ses_/);
      expect(result.usage).toEqual({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: 3,
        costUsd: 0.25,
      });
      expect(warn.mock.calls.map((call) => call.join(" "))).toEqual([
        expect.stringMatching(/inputTokens.*negative_result/),
        expect.stringMatching(/outputTokens.*invalid_value/),
        expect.stringMatching(/cacheReadTokens.*invalid_value/),
      ]);
    } finally {
      warn.mockRestore();
    }
  }, 20000);

  it("reads an unreported starting total as zero but not a bad one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await run({
        before: { tokens: { input: -1, output: 0 }, cost: null },
        after: {
          tokens: { input: 10, output: 4, cache: { read: 5, write: 1 } },
          cost: 0.1,
        },
      });
      expect(result.usage).toEqual({
        inputTokens: null,
        outputTokens: 4,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
        costUsd: 0.1,
      });
    } finally {
      warn.mockRestore();
    }
  }, 20000);
});
