import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
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
  const input = request();
  const result = await provider.adapter.execute(input, {
    signal: controller.signal,
    emit: async () => {
      controller.abort();
    },
  });
  expect(result.stopReason).toBe("cancelled");
  expect(result.usage).toBeNull();
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
/** Claude's saved cumulative cost rows for a session, as the program appends them to the transcript. */
async function saveCost(
  root: string,
  organizationId: string,
  id: string,
  ...rows: Record<string, unknown>[]
) {
  const folder = path.join(
    root,
    "providers/claude/organizations",
    organizationId,
    "config/projects/synthetic"
  );
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, `${id}.jsonl`),
    rows
      .map((row) =>
        JSON.stringify({ type: "cost-state", sessionId: id, ...row })
      )
      .join("\n") + "\n"
  );
}
const costState = (
  totalCostUSD: number,
  [input, output, cacheRead, cacheWrite]: number[]
) => ({
  totalCostUSD,
  totalDuration: Math.round(totalCostUSD * 1e6),
  modelUsage: {
    "claude-haiku-4-5": {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
      costUSD: totalCostUSD,
    },
  },
});
async function costPeer(root: string, scene: unknown) {
  const file = path.join(root, `scene-${crypto.randomUUID()}.json`);
  await writeFile(file, JSON.stringify(scene));
  return createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/claude-cost-state.synthetic.mjs"),
      file,
    ],
  });
}
it("resumes the requested session and subtracts the cost Claude saved for it", async () => {
  const root = await home();
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-resume.synthetic.json"),
    ],
  });
  const input = request();
  await saveCost(
    root,
    input.identity.organizationId,
    "session-one",
    costState(0.02, [1, 1, 0, 0])
  );
  input.previousSession = { id: "session-one" };
  const result = await provider.adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(result.stopReason).toBe("completed");
  expect(result.nextSession?.id).toBe("session-one");
  expect(result.usage?.costUsd).toBeCloseTo(0.03);
});
it("does not guess a resumed session's cost when Claude's saved cost cannot be read", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-resume.synthetic.json"),
    ],
  });
  const input = request();
  // A copy of the cost in the session state is not Claude's record and is not used.
  input.previousSession = { id: "session-one", costUsd: 0.02 };
  const result = await provider.adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(result.stopReason).toBe("completed");
  expect(result.usage).toEqual({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  });
});
it("reports a cancelled run's own usage from the cost Claude saved, and the next run pays only its own requests (#128)", async () => {
  const root = await home();
  const first = request();
  const organizationId = first.identity.organizationId;
  await saveCost(
    root,
    organizationId,
    "session-one",
    costState(0.5286, [100, 50, 1000, 200])
  );
  // The state the product kept from the last successful run, before and after the cancelled run.
  const stored = { id: "session-one", costUsd: 0.5286 };
  first.previousSession = stored;
  const controller = new AbortController();
  const cancelled = await (
    await costPeer(root, {
      mode: "cancel",
      costState: costState(0.6037, [110, 80, 3000, 700]),
    })
  ).adapter.execute(first, {
    signal: controller.signal,
    emit: async () => controller.abort(),
  });
  expect(cancelled.stopReason).toBe("cancelled");
  expect(cancelled.usage).toEqual({
    inputTokens: 10,
    outputTokens: 30,
    cacheReadTokens: 2000,
    cacheWriteTokens: 500,
    costUsd: expect.closeTo(0.0751, 6),
  });

  const next = request();
  next.identity.organizationId = organizationId;
  next.previousSession = stored;
  const finished = await (
    await costPeer(root, {
      mode: "finish",
      result: {
        total_cost_usd: 0.6643,
        usage: { input_tokens: 9, output_tokens: 20 },
      },
      costState: costState(0.6643, [119, 100, 4000, 900]),
    })
  ).adapter.execute(next, {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(finished.stopReason).toBe("completed");
  expect(finished.usage?.costUsd).toBeCloseTo(0.0606, 6);
  // Claude's saved cost is the one record of the session's cost; the session state keeps no copy.
  expect(finished.nextSession).not.toHaveProperty("costUsd");
});
it("leaves a cancelled run's usage unreported when Claude saved no new cost", async () => {
  const root = await home();
  const input = request();
  await saveCost(
    root,
    input.identity.organizationId,
    "session-one",
    costState(0.5286, [100, 50, 1000, 200])
  );
  input.previousSession = { id: "session-one" };
  const controller = new AbortController();
  const result = await (
    await costPeer(root, { mode: "cancel" })
  ).adapter.execute(input, {
    signal: controller.signal,
    emit: async () => controller.abort(),
  });
  expect(result.stopReason).toBe("cancelled");
  expect(result.usage).toBeNull();
});
it("charges the run after a compaction only its own cost, using the latest saved cost", async () => {
  const root = await home();
  const input = request();
  await saveCost(
    root,
    input.identity.organizationId,
    "session-one",
    costState(0.225151, [10, 10, 10, 10]),
    // The compaction's own process saved the newer cumulative cost.
    costState(0.3335439, [20, 20, 20, 20])
  );
  input.previousSession = { id: "session-one", costUsd: 0.225151 };
  const result = await (
    await costPeer(root, {
      mode: "finish",
      result: { total_cost_usd: 0.3519445, usage: { input_tokens: 10 } },
      costState: costState(0.3519445, [30, 30, 30, 30]),
    })
  ).adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(result.usage?.costUsd).toBeCloseTo(0.0184006, 6);
});
it("records the latest primary-session token size, request timestamp and cache TTL from its transcript", async () => {
  const root = await home();
  const input = request();
  const transcripts = path.join(
    root,
    "providers/claude/organizations",
    input.identity.organizationId,
    "config/projects/synthetic"
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
  const result = await provider.adapter.execute(input, {
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
        "--append-system-prompt-file": true,
      },
      argvFile: { "--append-system-prompt-file": "saved instructions" },
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
    { session, access: request().access, organizationId: crypto.randomUUID() },
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
        {
          session,
          access: request().access,
          organizationId: crypto.randomUUID(),
        },
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
  const input = request();
  const result = await provider.adapter.execute(input, {
    signal: controller.signal,
    emit: async () => {
      controller.abort();
    },
  });
  expect(result.stopReason).toBe("cancelled");
  // The child keeps writing while it lives, so a run that settles early would see this change.
  const heartbeat = path.join(
    root,
    "providers/claude/organizations",
    input.identity.organizationId,
    "orphan-heartbeat"
  );
  const settled = await readFile(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await readFile(heartbeat, "utf8")).toBe(settled);
});

it("compacts through the real compact protocol output", async () => {
  const root = await home();
  const provider = createClaudeProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/claude-simulator.mjs"),
      "--recording",
      path.resolve("test-fixtures/claude-recorded.json"),
    ],
  });
  const session = {
    id: "session-one",
    costUsd: 0,
    launch: { instructions: "지침", cwd: root, model: null },
  };
  const result = await provider.adapter.precompact!(
    { session, access: request().access, organizationId: crypto.randomUUID() },
    new AbortController().signal
  );
  expect(result.ok).toBe(true);
  expect(result.nextSession?.id).toBe("session-one");
});
