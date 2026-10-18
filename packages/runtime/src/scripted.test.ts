import type { RunRequest } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { createScriptedRuntime } from "./scripted.ts";
import { createGate } from "./testing.ts";

const ids = {
  organizationId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
};
const request: RunRequest = {
  identity: ids,
  access: { toolsBaseUrl: "http://tools.test", token: "secret-token" },
  wakeReasons: [
    {
      kind: "owner_message",
      wakeId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      body: "목표를 정하자",
    },
  ],
  context: {
    organization: {
      id: ids.organizationId,
      name: "조직",
      stage: "goal_setting",
    },
    agent: { id: ids.agentId, role: "lead", name: "Research Lead" },
    conversation: [],
  },
  instructionsBundleVersion: null,
  workspace: null,
  previousSession: null,
};

/** 조직 도구 HTTP 호출을 기록하고 계약 모양으로 답한다. */
function toolServer(status = 200) {
  const calls: {
    method: string;
    url: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    init?.signal?.throwIfAborted();
    calls.push({
      method: init?.method ?? "GET",
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (status !== 200)
      return Response.json({ error: { code: "invalid_token" } }, { status });
    if (url.endsWith("/run-context"))
      return Response.json({
        identity: request.identity,
        wakeReasons: request.wakeReasons,
        context: request.context,
      });
    return Response.json(
      {
        id: crypto.randomUUID(),
        organizationId: ids.organizationId,
        agentId: ids.agentId,
        author: "agent",
        body: (calls.at(-1)!.body as { body: string }).body,
        delivery: null,
        sentByRunId: ids.runId,
        deliveredToRunId: null,
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    );
  };
  return { calls, fetch };
}

const control = () => {
  const emitted: unknown[] = [];
  return {
    emitted,
    controller: new AbortController(),
    emit: async (activity: unknown) => {
      emitted.push(activity);
    },
  };
};

describe("scripted runtime", () => {
  it("answers the Lead conversation through the organization tools with the run token", async () => {
    const tools = toolServer();
    const runtime = createScriptedRuntime({ fetch: tools.fetch });
    const c = control();

    const result = await runtime.execute(request, {
      signal: c.controller.signal,
      emit: c.emit,
    });

    expect(result).toMatchObject({ stopReason: "completed", error: null });
    expect(result.summary).toBeTruthy();
    expect(tools.calls.map((x) => [x.method, x.url, x.auth])).toEqual([
      ["GET", "http://tools.test/api/tools/run-context", "Bearer secret-token"],
      ["POST", "http://tools.test/api/tools/messages", "Bearer secret-token"],
    ]);
    expect(tools.calls[1]!.body).toEqual({
      body: expect.stringContaining("목표를 정하자"),
    });
    expect(c.emitted).toEqual([{ type: "progress", text: expect.any(String) }]);
  });

  it("stops at a held step when cancelled and settles as cancelled without further tool calls", async () => {
    const tools = toolServer();
    const gate = createGate();
    const runtime = createScriptedRuntime({
      fetch: tools.fetch,
      select: () => ({
        steps: [
          { do: "read_context" },
          { do: "hold", until: gate.wait },
          { do: "send_message", body: () => "늦은 답장" },
        ],
      }),
    });
    const c = control();

    const done = runtime.execute(request, {
      signal: c.controller.signal,
      emit: c.emit,
    });
    await gate.reached;
    c.controller.abort();

    expect(await done).toMatchObject({ stopReason: "cancelled" });
    expect(tools.calls.map((x) => x.method)).toEqual(["GET"]);
  });

  it("fails the run when an organization tool refuses the token", async () => {
    const tools = toolServer(401);
    const runtime = createScriptedRuntime({ fetch: tools.fetch });
    const c = control();

    const result = await runtime.execute(request, {
      signal: c.controller.signal,
      emit: c.emit,
    });

    expect(result).toMatchObject({ stopReason: "failed" });
    expect(result.error).toContain("401");
    expect(result.error).not.toContain("secret-token");
  });

  it("fails when no scenario matches the agent and wake", async () => {
    const runtime = createScriptedRuntime({
      fetch: toolServer().fetch,
      select: () => undefined,
    });
    const c = control();
    const result = await runtime.execute(
      {
        ...request,
        context: {
          ...request.context,
          agent: { ...request.context.agent, role: "worker" },
        },
      },
      { signal: c.controller.signal, emit: c.emit }
    );
    expect(result.stopReason).toBe("failed");
  });
});
