import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { request } from "./test-support.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it("uses one private workspace MCP configuration, normalizes usage, and removes only owned files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-test-"));
  roots.push(root);
  const config = path.join(root, ".agents/mcp_config.json");
  await mkdir(path.dirname(config));
  const fixture = path.join(root, "fixture.json");
  await writeFile(
    fixture,
    JSON.stringify({
      version: "9.9.9",
      steps: [
        { frame: { event: "init", conversation_id: "saved" } },
        { input: { event: "user" } },
        {
          frame: {
            event: "step_update",
            step_update: {
              conversation_id: "saved",
              step_index: 1,
              state: "DONE",
              usage: {
                input_tokens: 15,
                output_tokens: 4,
                cache_read_tokens: 5,
              },
            },
          },
        },
        {
          frame: {
            event: "result",
            result: { status: "SUCCESS", conversation_id: "saved" },
          },
        },
        { exit: 0 },
      ],
    })
  );
  const adapter = createAntigravityProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ],
  }).adapter;
  const input = {
    ...request(),
    workspace: { cwd: root, organization: root, personal: root, peers: [] },
  };
  const result = await adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async () => {
      expect((await stat(config)).mode & 0o777).toBe(0o600);
      expect(await readFile(config, "utf8")).toContain("private-run-token");
    },
  });
  expect(result.stopReason).toBe("completed");
  expect(result.nextSession?.id).toBe("saved");
  expect(result.usage).toEqual({
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: null,
    costUsd: null,
  });
  await expect(stat(config)).rejects.toThrow();
  await writeFile(config, '{"user":"keep"}');
  expect(
    (
      await adapter.execute(input, {
        signal: new AbortController().signal,
        emit: async () => {},
      })
    ).stopReason
  ).toBe("failed");
  expect(await readFile(config, "utf8")).toBe('{"user":"keep"}');
});

describe("usage numbers outside the contract (#140)", () => {
  /** A finished conversation whose completed steps report these counts, in order. */
  async function run(steps: [number, Record<string, unknown>][]) {
    const root = await mkdtemp(path.join(tmpdir(), "agy-usage-"));
    roots.push(root);
    const fixture = path.join(root, "fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: "9.9.9",
        steps: [
          { frame: { event: "init", conversation_id: "saved" } },
          { input: { event: "user" } },
          ...steps.map(([index, usage]) => ({
            frame: {
              event: "step_update",
              step_update: {
                conversation_id: "saved",
                step_index: index,
                state: "DONE",
                usage,
              },
            },
          })),
          {
            frame: {
              event: "result",
              result: { status: "SUCCESS", conversation_id: "saved" },
            },
          },
          { exit: 0 },
        ],
      })
    );
    return createAntigravityProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        fixture,
      ],
    }).adapter.execute(
      {
        ...request(),
        workspace: { cwd: root, organization: root, personal: root, peers: [] },
      },
      { signal: new AbortController().signal, emit: async () => {} }
    );
  }
  const warnings = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return {
      lines: () => warn.mock.calls.map((call) => call.join(" ")),
      [Symbol.dispose]: () => warn.mockRestore(),
    };
  };

  it("keeps a total unreported after a bad step even when good steps follow, and still skips repeated steps", async () => {
    using warn = warnings();
    const result = await run([
      [1, { input_tokens: 15, cache_read_tokens: 5, output_tokens: 100 }],
      [2, { input_tokens: 10, output_tokens: -1 }],
      [2, { input_tokens: 1000, output_tokens: 1 }],
      [3, { input_tokens: 7, cache_read_tokens: 2, output_tokens: 50 }],
    ]);
    expect(result.stopReason).toBe("completed");
    expect(result.nextSession?.id).toBe("saved");
    expect(result.usage).toEqual({
      inputTokens: 25,
      outputTokens: null,
      cacheReadTokens: 7,
      cacheWriteTokens: null,
      costUsd: null,
    });
    expect(warn.lines()).toEqual([
      expect.stringMatching(/outputTokens.*invalid_value/),
    ]);
  });

  it("leaves the input unreported when the cache is larger, and keeps the cache", async () => {
    using _ = warnings();
    expect(
      (
        await run([
          [1, { input_tokens: 100, cache_read_tokens: 120, output_tokens: 3 }],
        ])
      ).usage
    ).toEqual({
      inputTokens: null,
      outputTokens: 3,
      cacheReadTokens: 120,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });

  it("carries a bad cache into the input that needs it and reports an overflowing total", async () => {
    using warn = warnings();
    const result = await run([
      [
        1,
        {
          input_tokens: 10,
          cache_read_tokens: 1.5,
          output_tokens: Number.MAX_SAFE_INTEGER,
        },
      ],
      [2, { input_tokens: 3, cache_read_tokens: 0, output_tokens: 1 }],
    ]);
    expect(result.stopReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
    expect(warn.lines()).toEqual([
      expect.stringMatching(/inputTokens.*invalid_operand/),
      expect.stringMatching(/outputTokens.*overflow/),
      expect.stringMatching(/cacheReadTokens.*invalid_value/),
    ]);
  });
});
