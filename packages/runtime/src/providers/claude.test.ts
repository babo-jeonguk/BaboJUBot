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

// #125: 첫 턴이 끝난 뒤에도 Claude는 띄운 백그라운드 명령을 기다렸다가 그 결과로 한 턴 더 한다(입력을 닫은 뒤).
// 제품은 입력만 닫고 프로그램이 스스로 끝날 때까지 기다리며, 마지막 턴의 결과로 실행 시도를 끝낸다.
// 실제 Claude 2.1.317 녹화: 기다리는 서브에이전트 → 45초 백그라운드 명령 → 첫 결과 → 명령 끝 → 두 번째 턴(init이 다시 온다) → 결과.
it("keeps the run open for a background command and finishes with the turn that handles its outcome", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-background-recorded.json"),
    ],
  });
  const input = request();
  const progress: string[] = [];
  let steeredAfterFirstTurn: string | undefined;
  const result = await provider.adapter.execute(input, {
    signal: new AbortController().signal,
    emit: async (value) => {
      const activity = value as { type?: string; text?: string };
      if (activity.type !== "progress" || !activity.text) return;
      progress.push(activity.text);
      if (activity.text.includes("백그라운드"))
        steeredAfterFirstTurn = await provider.adapter.steer!({
          runId: input.identity.runId,
          messageId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          body: "늦은 말",
        });
    },
  });
  expect(result.stopReason).toBe("completed");
  // 턴마다의 토큰은 더하고, 비용은 마지막 결과의 누계다.
  expect(result.usage).toEqual({
    inputTokens: 12,
    outputTokens: 779,
    cacheReadTokens: 107249,
    cacheWriteTokens: 3332,
    costUsd: 0.006115485,
  });
  expect(result.nextSession?.id).toBe("<session>");
  // 기다리는 동안 활동에 그 사실이 한 번 보인다. 두 번째 턴의 init은 실행 시도의 시작이 아니다(리뷰 3회차).
  expect(progress).toEqual([
    "프로바이더가 작업을 시작했습니다.",
    "백그라운드 작업이 끝나기를 기다립니다.",
  ]);
  // 입력을 닫은 뒤에는 끼워 넣기를 받지 않는다.
  expect(steeredAfterFirstTurn).toBe("rejected");
});

// PR #130 리뷰 SPEC-03: 기다리는(foreground) 서브에이전트는 시작 신호만 내고 끝 신호를 약속하지 않는다.
// 백그라운드 일은 Claude가 내는 살아 있는 목록으로만 판단하므로, 이 실행은 결과대로 끝난다.
it("finishes with its result when a foreground task never reports back", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-foreground-task.synthetic.json"),
    ],
  });
  const progress: string[] = [];
  const result = await provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async (value) => {
      const activity = value as { type?: string; text?: string };
      if (activity.type === "progress" && activity.text)
        progress.push(activity.text);
    },
  });
  expect(result.stopReason).toBe("completed");
  expect(result.nextSession?.id).toBe("session-fg");
  expect(progress).not.toContain("백그라운드 작업이 끝나기를 기다립니다.");
});

it("cancels a run that is waiting for a background command", async () => {
  const provider = createClaudeProvider({
    dataDir: await home(),
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-background-hang.synthetic.json"),
    ],
  });
  const controller = new AbortController();
  const started = Date.now();
  const result = await provider.adapter.execute(request(), {
    signal: controller.signal,
    emit: async (value) => {
      const activity = value as { type?: string; text?: string };
      if (activity.type === "progress" && activity.text?.includes("백그라운드"))
        controller.abort();
    },
  });
  expect(result.stopReason).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(15_000);
});

/** 백그라운드 작업이 알리기 전에 끝나는 녹화를 고쳐 재생한다. */
async function runBackgroundLost(
  change: (fixture: { steps: Record<string, unknown>[] }) => void
) {
  const fixture = JSON.parse(
    await readFile(
      path.resolve("test-fixtures/claude-background-lost.synthetic.json"),
      "utf8"
    )
  );
  change(fixture);
  const root = await home();
  const file = path.join(root, "lost.json");
  await writeFile(file, JSON.stringify(fixture));
  const provider = createClaudeProvider({
    dataDir: root,
    command: [process.execPath, path.resolve("test-fixtures/replay.mjs"), file],
  });
  return provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {},
  });
}

// PR #130 리뷰 SPEC-01: 띄운 백그라운드 작업이 끝났다고 알리기 전에 프로그램이 끝나면 일은 끝나지 않았다.
// 첫 턴의 성공 결과는 중간 결과이므로 실행 시도를 성공으로 남기지 않고, 그 세션도 저장하지 않는다.
// 리뷰 SPEC-02: 그래도 이미 보고된 턴의 사용량은 실제로 쓴 것이므로 실행 기록에 남긴다.
it.each([1, 0])(
  "fails a run whose program exits with code %i before a background command reports back",
  async (code) => {
    const result = await runBackgroundLost((fixture) => {
      fixture.steps[fixture.steps.length - 1] = { exit: code };
    });
    expect(result.stopReason).toBe("failed");
    expect(result.nextSession).toBeNull();
    expect(result.error).toContain("백그라운드");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.01,
    });
  }
);

// 리뷰 SPEC-02: 마지막 결과가 로그인 문제였으면 백그라운드 작업이 남아도 그 판정을 남겨 준비 상태를 다시 확인하게 한다.
it("keeps a login problem when the program exits before a background command reports back", async () => {
  const result = await runBackgroundLost((fixture) => {
    const step = fixture.steps.find(
      (s) => (s.frame as { type?: string } | undefined)?.type === "result"
    ) as { frame: Record<string, unknown> };
    step.frame.is_error = true;
    step.frame.api_error_status = 401;
  });
  expect(result.stopReason).toBe("failed");
  expect(result.nextSession).toBeNull();
  expect(result.errorCode).toBe("login_required");
});
