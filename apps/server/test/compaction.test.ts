import { afterEach, expect, it, vi } from "vitest";
import {
  eventually,
  startTestServer,
  within,
  type TestServer,
} from "./support.ts";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { folderCleanup, withCleanup } from "@babojubot/runtime/test-cleanup";

const leadOf = (org: { agents: { id: string; role: string }[] }) =>
  org.agents.find((a) => a.role === "lead")!.id;
let t: TestServer | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
});
it("persists compaction settings with provider defaults and rejects invalid ranges", async () => {
  t = await startTestServer();
  const before = await t.request("GET", "/api/providers");
  expect(before.body.compaction).toEqual({
    thresholdTokens: 400000,
    ratio: 0.9,
  });
  const defaults = {
    leadDefault: before.body.leadDefault,
    workerDefault: before.body.workerDefault,
  };
  const saved = await t.request("PUT", "/api/providers/defaults", {
    ...defaults,
    compaction: { thresholdTokens: 50000, ratio: 0.5 },
  });
  expect(saved.status).toBe(200);
  expect((await t.request("GET", "/api/providers")).body.compaction).toEqual({
    thresholdTokens: 50000,
    ratio: 0.5,
  });
  for (const compaction of [
    { thresholdTokens: 49999, ratio: 0.9 },
    { thresholdTokens: 1000001, ratio: 0.9 },
    { thresholdTokens: 400000, ratio: 0.96 },
    { thresholdTokens: "", ratio: 0.9 },
    { thresholdTokens: 400000, ratio: null },
  ]) {
    expect(
      (
        await t.request("PUT", "/api/providers/defaults", {
          ...defaults,
          compaction,
        })
      ).status
    ).toBe(422);
  }
});
it("compacts a due paused session without creating a run or activity and denies all maintenance tool calls", async () => {
  const { createScriptedRuntime } = await import("@babojubot/runtime");
  let now = new Date("2026-01-01T00:00:00Z"),
    calls = 0;
  const inner = createScriptedRuntime();
  t = await startTestServer({
    now: () => now,
    runtime: {
      ...inner,
      capabilities: { ...inner.capabilities, precompact: true },
      async execute(input) {
        await fetch(new URL("/api/tools/mcp", input.access.toolsBaseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.access.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        });
        return {
          stopReason: "completed",
          error: null,
          summary: null,
          usage: null,
          nextSession: { id: "saved-session" },
          sessionMaintenance: {
            tokens: 400000,
            lastRequestAt: now.toISOString(),
            ttlMs: 3600000,
          },
        };
      },
      async precompact(input) {
        calls++;
        const invoke = async (method: string, params: unknown) =>
          fetch(new URL("/api/tools/mcp", input.access.toolsBaseUrl), {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.access.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
        const listed = (await (await invoke("tools/list", {})).json()) as {
          result: { tools: unknown[] };
        };
        expect(listed.result.tools.length).toBeGreaterThan(0);
        const denied = (await (
          await invoke("tools/call", { name: "get_run_context", arguments: {} })
        ).json()) as { result: { isError: boolean } };
        expect(denied.result.isError).toBe(true);
        return { ok: true, nextSession: input.session };
      },
    },
  });
  const org = (
    await t.request("POST", "/api/organizations", {
      name: "압축 검사",
      goal: "검증",
      completionCriteria: "확인",
    })
  ).body;
  await t.drain();
  await t.request("POST", `/api/organizations/${org.id}/pause`, {});
  const runs = await t.request("GET", `/api/organizations/${org.id}/runs`);
  const events = await t.request("GET", `/api/organizations/${org.id}/events`);
  now = new Date("2026-01-01T00:53:59Z");
  await t.tickCompactions();
  expect(calls).toBe(0);
  now = new Date("2026-01-01T00:54:00Z");
  await t.tickCompactions();
  expect(calls).toBe(1);
  expect(
    (await t.request("GET", `/api/organizations/${org.id}/runs`)).body
  ).toEqual(runs.body);
  expect(
    (await t.request("GET", `/api/organizations/${org.id}/events`)).body
  ).toEqual(events.body);
  await t.tickCompactions();
  expect(calls).toBe(1);
});
it("keeps a normal wake pending while compaction owns the session and uses the compacted session afterward", async () => {
  const { createScriptedRuntime } = await import("@babojubot/runtime");
  const inner = createScriptedRuntime();
  let now = new Date("2026-01-01T00:00:00Z"),
    runs = 0,
    started!: () => void,
    finish!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t = await startTestServer({
    now: () => now,
    runtime: {
      ...inner,
      capabilities: { ...inner.capabilities, precompact: true },
      async execute(input) {
        runs++;
        if (runs === 2)
          expect(input.previousSession).toEqual({
            id: "saved",
            compacted: true,
          });
        return {
          stopReason: "completed",
          error: null,
          summary: null,
          usage: null,
          nextSession: { id: "saved" },
          ...(runs === 1
            ? {
                sessionMaintenance: {
                  tokens: 400000,
                  lastRequestAt: now.toISOString(),
                  ttlMs: 3600000,
                },
              }
            : {}),
        };
      },
      async precompact() {
        started();
        await done;
        return { ok: true, nextSession: { id: "saved", compacted: true } };
      },
    },
  });
  const org = (
    await t.request("POST", "/api/organizations", {
      name: "경쟁",
      goal: "검증",
      completionCriteria: "확인",
    })
  ).body;
  await t.drain();
  now = new Date("2026-01-01T00:54:00Z");
  const tick = t.tickCompactions();
  // 붙잡은 압축을 풀고 그 처리가 끝나기를 기다린 뒤에 다음 실행 시도를 본다.
  await withCleanup(async (defer) => {
    defer(async () => {
      finish();
      await tick;
    });
    await began;
    expect(
      (
        await t!.request("POST", `/api/organizations/${org.id}/messages`, {
          body: "계속",
        })
      ).status
    ).toBe(201);
    // 메시지의 촉진을 처리한 뒤에 본다. 압축 중이면 실행 시도를 시작하지 않고 처리가 끝난다.
    await within(t!.kickHandled(leadOf(org)), "handling the message's kick");
    expect(runs).toBe(1);
  });
  await t.drain();
  expect(runs).toBe(2);
});
it.each([
  ["had not finished", { ok: false, nextSession: null }, { id: "saved" }],
  [
    "had already finished",
    { ok: true, nextSession: { id: "saved", compacted: true } },
    { id: "saved", compacted: true },
  ],
] as const)(
  "ends a compaction at the time limit and the waiting wake resumes the reported session: %s",
  async (_label, reported, expected) => {
    const { createScriptedRuntime } = await import("@babojubot/runtime");
    const inner = createScriptedRuntime();
    let now = new Date("2026-01-01T00:00:00Z"),
      runs = 0,
      resumed: unknown,
      compacting: AbortSignal | undefined,
      started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    t = await startTestServer({
      now: () => now,
      runtime: {
        ...inner,
        capabilities: { ...inner.capabilities, precompact: true },
        async execute(input) {
          runs++;
          if (runs === 2) resumed = input.previousSession;
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage: null,
            nextSession: { id: "saved" },
            ...(runs === 1
              ? {
                  sessionMaintenance: {
                    tokens: 400000,
                    lastRequestAt: now.toISOString(),
                    ttlMs: 3600000,
                  },
                }
              : {}),
          };
        },
        async precompact(_input, signal) {
          compacting = signal;
          started();
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true })
          );
          return reported;
        },
      },
    });
    const org = (
      await t.request("POST", "/api/organizations", {
        name: "멈춘 압축",
        goal: "검증",
        completionCriteria: "확인",
      })
    ).body;
    await t.drain();
    now = new Date("2026-01-01T00:54:00Z");
    // 압축 시한 확인(250ms 간격의 setInterval)을 시험이 돌린다. 제품에서 setInterval은 주기 확인만 쓰고, 그 밖의 타이머는 실제 시간 그대로다.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const tick = t.tickCompactions();
    await began;
    expect(
      (
        await t.request("POST", `/api/organizations/${org.id}/messages`, {
          body: "계속",
        })
      ).status
    ).toBe(201);
    await within(t.kickHandled(leadOf(org)), "handling the message's kick");
    expect(runs).toBe(1);
    now = new Date("2026-01-01T01:08:59Z");
    // 시한 전 시각을 본 확인은 압축을 멈추지 않는다. 시한 판단은 확인 안에서 바로 하므로 확인을 돌린 직후에 본다.
    vi.advanceTimersByTime(250);
    expect(compacting?.aborted).toBe(false);
    expect(runs).toBe(1);
    now = new Date("2026-01-01T01:09:00Z");
    vi.advanceTimersByTime(250);
    expect(compacting?.aborted).toBe(true);
    vi.useRealTimers();
    await tick;
    await t.drain();
    expect(runs).toBe(2);
    expect(resumed).toEqual(expected);
  }
);
it.each(["expired", "stopped", "ordinary-run"] as const)(
  "does not compact a %s reservation",
  async (scenario) => {
    const { createScriptedRuntime } = await import("@babojubot/runtime");
    const inner = createScriptedRuntime();
    let now = new Date("2026-01-01T00:00:00Z"),
      calls = 0,
      runs = 0;
    t = await startTestServer({
      now: () => now,
      runtime: {
        ...inner,
        capabilities: { ...inner.capabilities, precompact: true },
        async execute() {
          runs++;
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage: null,
            nextSession: { id: "saved" },
            ...(runs === 1
              ? {
                  sessionMaintenance: {
                    tokens: 400000,
                    lastRequestAt: now.toISOString(),
                    ttlMs: 3600000,
                  },
                }
              : {}),
          };
        },
        async precompact(input) {
          calls++;
          return { ok: true, nextSession: input.session };
        },
      },
    });
    const org = (
      await t.request("POST", "/api/organizations", {
        name: "예약",
        goal: "검증",
        completionCriteria: "확인",
      })
    ).body;
    await t.drain();
    if (scenario === "stopped")
      await t.request("POST", `/api/organizations/${org.id}/stop`, {});
    if (scenario === "ordinary-run") {
      await t.request("POST", `/api/organizations/${org.id}/messages`, {
        body: "계속",
      });
      await t.drain();
    }
    now = new Date(
      scenario === "expired" ? "2026-01-01T01:00:00Z" : "2026-01-01T00:54:00Z"
    );
    await t.tickCompactions();
    expect(calls).toBe(0);
  }
);
it("uses spare provider capacity for another organization while one compaction is still running", async () => {
  const { createScriptedRuntime } = await import("@babojubot/runtime");
  const inner = createScriptedRuntime();
  let now = new Date("2026-01-01T00:00:00Z"),
    calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t = await startTestServer({
    now: () => now,
    runtime: {
      ...inner,
      capabilities: { ...inner.capabilities, precompact: true },
      async execute(input) {
        return {
          stopReason: "completed",
          error: null,
          summary: null,
          usage: null,
          nextSession: { id: input.identity.organizationId },
          sessionMaintenance: {
            tokens: 400000,
            lastRequestAt: now.toISOString(),
            ttlMs: 3600000,
          },
        };
      },
      async precompact(input) {
        calls++;
        if (calls === 1) await gate;
        return { ok: true, nextSession: input.session };
      },
    },
  });
  for (const name of ["첫 조직", "다른 조직"])
    await t.request("POST", "/api/organizations", {
      name,
      goal: "검증",
      completionCriteria: "확인",
    });
  await t.drain();
  now = new Date("2026-01-01T00:54:00Z");
  const tick = t.tickCompactions();
  // 붙잡은 압축을 풀고, 시험 서버를 닫는 afterEach보다 먼저 그 처리가 끝나기를 기다린다.
  await withCleanup(async (defer) => {
    defer(async () => {
      release();
      await tick;
    });
    await expect.poll(() => calls, eventually).toBe(2);
  });
});
it("reuses the preceding MCP catalog even when that run changes the organization stage", async () => {
  const { createScriptedRuntime } = await import("@babojubot/runtime");
  const inner = createScriptedRuntime({
    select: () => ({
      steps: [
        {
          do: "call",
          tool: "request_initial_approval",
          input: () => ({
            plan: "계획",
            environment: "환경",
            team: [{ role: "researcher", count: 1 }],
            template: "basic-research",
          }),
        },
      ],
    }),
  });
  let now = new Date("2026-01-01T00:00:00Z"),
    normal: unknown,
    maintenance: unknown;
  const listed = async (access: { token: string; toolsBaseUrl: string }) => {
    const res = await fetch(new URL("/api/tools/mcp", access.toolsBaseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    return ((await res.json()) as { result: { tools: unknown } }).result.tools;
  };
  t = await startTestServer({
    now: () => now,
    runtime: {
      ...inner,
      capabilities: { ...inner.capabilities, precompact: true },
      async execute(input, control) {
        normal = await listed(input.access);
        const result = await inner.execute(input, control);
        return {
          ...result,
          nextSession: { id: "saved" },
          sessionMaintenance: {
            tokens: 400000,
            lastRequestAt: now.toISOString(),
            ttlMs: 3600000,
          },
        };
      },
      async precompact(input) {
        maintenance = await listed(input.access);
        return { ok: true, nextSession: input.session };
      },
    },
  });
  const org = (
    await t.request("POST", "/api/organizations", {
      name: "목록 보존",
      goal: "검증",
      completionCriteria: "확인",
    })
  ).body;
  await t.drain();
  expect(
    (await t.request("GET", `/api/organizations/${org.id}`)).body.stage
  ).toBe("awaiting_approval");
  now = new Date("2026-01-01T00:54:00Z");
  await t.tickCompactions();
  expect(maintenance).toEqual(normal);
});
it.each([
  ["within TTL", 54, 1],
  ["expired TTL", 61, 0],
] as const)(
  "recovers a saved reservation after restart: %s",
  async (_label, minutes, expected) => {
    const { createScriptedRuntime } = await import("@babojubot/runtime");
    const { startServer } = await import("../src/index.ts");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dataDir = await mkdtemp(path.join(tmpdir(), "compact-restart-"));
    let now = new Date("2026-01-01T00:00:00Z"),
      calls = 0;
    const inner = createScriptedRuntime();
    const runtime = {
      ...inner,
      capabilities: { ...inner.capabilities, precompact: true },
      async execute() {
        return {
          stopReason: "completed" as const,
          error: null,
          summary: null,
          usage: null,
          nextSession: { id: "saved" },
          sessionMaintenance: {
            tokens: 400000,
            lastRequestAt: now.toISOString(),
            ttlMs: 3600000,
          },
        };
      },
      async precompact(input: {
        session: import("@babojubot/contracts").SessionState;
      }) {
        calls++;
        return { ok: true, nextSession: input.session };
      },
    };
    // 다시 띄운 서버를 닫은 뒤에 그 폴더를 지운다. 닫기가 실패하면 폴더를 남긴다.
    // 다시 띄운 서버는 시험 서버의 DB를 쓰므로, 그 DB를 닫는 afterEach보다 먼저 시험 안에서 정리한다.
    await withCleanup(async (defer) => {
      const folder = folderCleanup(() => removeFolder(dataDir));
      defer(folder.cleanUp);
      t = await startTestServer({ dataDir, now: () => now, runtime });
      await t.request("POST", "/api/organizations", {
        name: "재시작",
        goal: "검증",
        completionCriteria: "확인",
      });
      await t.drain();
      await t.stopServer();
      now = new Date(Date.UTC(2026, 0, 1, 0, minutes));
      const restarted = await startServer({
        db: t.db,
        dataDir,
        port: 0,
        now: () => now,
        runtime,
      });
      folder.own(() => restarted.close());
      await restarted.tickCompactions();
      expect(calls).toBe(expected);
      await restarted.tickCompactions();
      expect(calls).toBe(expected);
    });
  }
);
