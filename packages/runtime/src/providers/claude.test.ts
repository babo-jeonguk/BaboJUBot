import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { request } from "./test-support.ts";
import { createClaudeProvider } from "./claude.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-claude-"));
  roots.push(root);
  await mkdir(path.join(root, "providers/claude"), { recursive: true });
  await writeFile(
    path.join(root, "providers/claude/setup-token"),
    "synthetic-login",
    { mode: 0o600 }
  );
  return root;
}
it("reports a missing program without exposing credentials or raw process errors", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: ["/missing/claude"],
  });
  expect(
    await provider.adapter.checkReadiness(new AbortController().signal)
  ).toEqual({ status: "not_ready", reason: "program_missing" });
  const result = await provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(result.stopReason).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("private-run-token");
});
it("finishes a duplex stream, normalizes missing usage and publishes no raw content", async () => {
  const root = await home();
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-finish.synthetic.json"),
    ],
  });
  const activities: unknown[] = [];
  const result = await provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async (value) => {
      activities.push(value);
    },
  });
  expect(result.stopReason).toBe("completed");
  expect(result.usage).toEqual({
    inputTokens: 21,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    costUsd: 0.02,
  });
  expect(result.nextSession?.id).toBe("session-one");
  expect(JSON.stringify(activities)).not.toMatch(
    /private thinking|private raw input|private-run-token/
  );
});
it("interrupts through the protocol and deletes attempt credentials after process exit", async () => {
  const root = await home();
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-cancel.synthetic.json"),
    ],
  });
  const controller = new AbortController();
  const result = await provider.adapter.execute(request(), {
    signal: controller.signal,
    emit: async () => {
      controller.abort();
    },
  });
  expect(result.stopReason).toBe("cancelled");
  const { readdir } = await import("node:fs/promises");
  expect(
    (await readdir(path.join(root, "providers/claude"))).filter((name) =>
      name.startsWith("attempt-")
    )
  ).toEqual([]);
});
it("delivers steering to the active stream and rejects unknown and finished runs", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-steer.synthetic.json"),
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
  expect(await provider.adapter.steer!(message)).toBe("rejected");
  const result = await provider.adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async () => {
      expect(
        await provider.adapter.steer!({
          ...message,
          runId: crypto.randomUUID(),
        })
      ).toBe("rejected");
      expect(await provider.adapter.steer!(message)).toBe("accepted");
    },
  });
  expect(result.stopReason).toBe("completed");
  expect(await provider.adapter.steer!(message)).toBe("rejected");
});
it("resumes the requested session and subtracts its cumulative cost baseline", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-resume.synthetic.json"),
    ],
  });
  const input = request();
  input.previousSession = { id: "session-one", costUsd: 0.02 };
  const result = await provider.adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(result.stopReason).toBe("completed");
  expect(result.nextSession?.id).toBe("session-one");
  expect(result.usage?.costUsd).toBeCloseTo(0.03);
});
it("does not start a turn without a product login", async () => {
  const root = await home();
  await rm(path.join(root, "providers/claude/setup-token"));
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-finish.synthetic.json"),
    ],
  });
  const result = await provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {
      throw new Error("must not begin a turn");
    },
  });
  expect(result.errorCode).toBe("login_required");
});
it("records the latest primary-session token size, request timestamp and cache TTL from its transcript", async () => {
  const root = await home();
  const transcripts = path.join(
    root,
    "providers/claude/config/projects/synthetic"
  );
  await mkdir(transcripts, { recursive: true });
  await writeFile(
    path.join(transcripts, "session-one.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        sessionId: "session-one",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 400000,
            cache_creation_input_tokens: 50,
            cache_creation: { ephemeral_5m_input_tokens: 50 },
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "session-one",
        isSidechain: true,
        timestamp: "2026-01-01T00:01:00Z",
        message: { usage: { input_tokens: 1 } },
      }),
    ].join("\n")
  );
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-finish.synthetic.json"),
    ],
  });
  const result = await provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(result.sessionMaintenance).toEqual({
    tokens: 400150,
    lastRequestAt: "2026-01-01T00:00:00.000Z",
    ttlMs: 300000,
  });
});
it("compacts the saved launch with the same session and requires a compact boundary", async () => {
  const root = await home();
  const fixture = path.join(root, "compact.json");
  await writeFile(
    fixture,
    JSON.stringify({
      argv: {
        "--resume": "session-one",
        "--append-system-prompt": "saved instructions",
      },
      steps: [
        { input: { type: "user", message: { content: "/compact" } } },
        {
          frame: { type: "system", subtype: "init", session_id: "session-one" },
        },
        {
          frame: {
            type: "system",
            subtype: "compact_boundary",
            session_id: "session-one",
          },
        },
        {
          frame: {
            type: "result",
            subtype: "success",
            session_id: "session-one",
            total_cost_usd: 0.03,
          },
        },
        { exit: 0 },
      ],
    })
  );
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ],
  });
  expect(provider.adapter.capabilities.precompact).toBe(true);
  const session = {
    id: "session-one",
    costUsd: 0.02,
    launch: {
      instructions: "saved instructions",
      cwd: root,
      model: null,
    },
  };
  const result = await provider.adapter.precompact!(
    { session, access: request().access },
    new AbortController().signal
  );
  expect(result.ok).toBe(true);
  expect(result.nextSession?.id).toBe("session-one");
  await writeFile(
    fixture,
    JSON.stringify({
      steps: [
        { input: { type: "user" } },
        {
          frame: {
            type: "result",
            subtype: "success",
            session_id: "session-one",
          },
        },
        { exit: 0 },
      ],
    })
  );
  expect(
    (
      await provider.adapter.precompact!(
        { session, access: request().access },
        new AbortController().signal
      )
    ).ok
  ).toBe(false);
});
it("waits for an orphaned child to exit before settling cancellation", async () => {
  const root = await home(),
    controller = new AbortController();
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/claude-orphan.synthetic.mjs"),
    ],
  });
  const result = await provider.adapter.execute(request(), {
    signal: controller.signal,
    emit: async () => {
      controller.abort();
    },
  });
  expect(result.stopReason).toBe("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 2800));
  const { access } = await import("node:fs/promises");
  await expect(
    access(path.join(root, "providers/claude/orphan-effect"))
  ).rejects.toThrow();
}, 10000);
