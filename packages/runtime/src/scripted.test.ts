import type { RunRequest } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  createScriptedRuntime,
  demoLeadScript,
  leadReplyScript,
  parseGoalMessage,
  type Script,
} from "./scripted.ts";
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
      goal: null,
      completionCriteria: null,
    },
    agent: { id: ids.agentId, role: "lead", name: "Research Lead" },
    conversation: [],
  },
  instructionsBundleVersion: null,
  instructions: [],
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

describe("demo Lead scenario", () => {
  const calls = (script: Script) =>
    script.steps.flatMap((s) => (s.do === "call" ? [s.tool] : []));
  const at = (
    stage: RunRequest["context"]["organization"]["stage"],
    wakeReasons: RunRequest["wakeReasons"],
    goal: string | null = null
  ): RunRequest => ({
    ...request,
    wakeReasons,
    context: {
      ...request.context,
      organization: {
        ...request.context.organization,
        stage,
        goal,
        completionCriteria: goal && "기준",
      },
    },
  });
  const message = (body: string) => ({
    kind: "owner_message" as const,
    wakeId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    body,
  });

  it("reads a goal only from both `목표:` and `완료 기준:` lines", () => {
    expect(parseGoalMessage("목표: 오류 절반\n완료 기준：WER 10%")).toEqual({
      goal: "오류 절반",
      completionCriteria: "WER 10%",
    });
    expect(parseGoalMessage("오류를 줄이는 것이 목표입니다")).toBeUndefined();
    expect(parseGoalMessage("목표: 오류 절반")).toBeUndefined();
  });

  it("records the goal and requests approval, resubmits after changes are requested, and otherwise replies", () => {
    expect(
      calls(
        demoLeadScript(
          at("goal_setting", [message("목표: 오류 절반\n완료 기준: WER 10%")])
        )
      )
    ).toEqual(["record_goal", "request_initial_approval"]);
    expect(
      calls(demoLeadScript(at("goal_setting", [message("안녕")])))
    ).toEqual([]);
    const sentBack = {
      kind: "approval_decision" as const,
      wakeId: crypto.randomUUID(),
      approvalId: crypto.randomUUID(),
      decision: "request_changes" as const,
      note: "줄여 주세요",
    };
    const resubmit = demoLeadScript(at("planning", [sentBack], "오류 절반"));
    expect(calls(resubmit)).toEqual(["request_initial_approval"]);
    const step = resubmit.steps.find((s) => s.do === "call");
    expect(
      step?.do === "call" &&
        (
          step.input?.({
            request,
            context: undefined,
            sent: [],
            calls: [],
          }) as {
            plan: string;
          }
        ).plan
    ).toContain("줄여 주세요");
    expect(
      demoLeadScript(
        at("researching", [{ ...sentBack, decision: "approve", note: null }])
      )
    ).toBe(leadReplyScript);
  });
});
