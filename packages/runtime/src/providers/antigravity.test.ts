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
import { afterEach, expect, it } from "vitest";
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
