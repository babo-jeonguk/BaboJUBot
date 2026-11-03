import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
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
