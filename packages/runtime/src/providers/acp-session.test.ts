import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRequest } from "@babojubot/contracts";
import {
  extractJsonObject,
  isExplicitlySignedOut,
  runAcpSession,
  stripAnsi,
} from "./acp-session.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

const folders = testFolders();
const rpc = (id: number, body: Record<string, unknown>) => ({
  frame: { jsonrpc: "2.0", id, ...body },
});

const organizationMcp = {
  mcpServers: [
    {
      type: "http",
      name: "organization",
      url: "http://127.0.0.1:1/api/tools/mcp",
      headers: [{ name: "Authorization", value: "Bearer private-run-token" }],
    },
  ],
};

async function runReplay(
  steps: Record<string, unknown>[],
  patch: Partial<RunRequest> = {},
  signal: AbortSignal = new AbortController().signal
) {
  const root = await folders.make("acp-session-");
  const fixture = path.join(root, "fixture.json");
  await writeFile(fixture, JSON.stringify({ argv: { acp: true }, steps }));
  const activity: unknown[] = [];
  const result = await runAcpSession(
    {
      logName: "TestAcp",
      stateDir: path.join(root, "state"),
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        fixture,
      ],
      args: ["acp"],
      env: { ...process.env },
    },
    {
      ...request(),
      ...patch,
      workspace: { cwd: root, organization: root, personal: root, peers: [] },
    },
    {
      signal,
      emit: async (item) => {
        activity.push(item);
      },
    }
  );
  return { result, activity };
}

describe("ACP session client", () => {
  it("refuses container execution fail-closed without spawning a program", async () => {
    const root = await folders.make("acp-container-");
    const result = await runAcpSession(
      {
        logName: "TestAcp",
        stateDir: root,
        command: [path.join(root, "must-not-run")],
        args: ["acp"],
        env: { ...process.env },
      },
      { ...request(), execution: "container" },
      { signal: new AbortController().signal, emit: async () => {} }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error:
        "이 프로바이더 연결은 격리 실행에서 쓸 인증 중계가 아직 검증되지 않아 실행하지 않았습니다.",
      summary: null,
      usage: null,
      nextSession: null,
    });
  });

  it("answers string JSON-RPC permission IDs preferring allow_once and redacts run tokens in tool titles", async () => {
    const { result, activity } = await runReplay([
      { input: { method: "initialize" } },
      rpc(1, { result: { protocolVersion: 1 } }),
      { input: { method: "session/new", params: organizationMcp } },
      rpc(2, { result: { sessionId: "s-1" } }),
      { input: { method: "session/prompt", params: { sessionId: "s-1" } } },
      {
        frame: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "s-1",
            update: {
              sessionUpdate: "tool_call",
              title: "curl -H Bearer private-run-token",
            },
          },
        },
      },
      {
        frame: {
          jsonrpc: "2.0",
          id: "perm-uuid-1",
          method: "session/request_permission",
          params: {
            sessionId: "s-1",
            options: [
              { optionId: "always", kind: "allow_always", name: "Always" },
              { optionId: "once", kind: "allow_once", name: "Once" },
            ],
          },
        },
      },
      {
        input: {
          id: "perm-uuid-1",
          result: { outcome: { outcome: "selected", optionId: "once" } },
        },
      },
      rpc(3, { result: { stopReason: "end_turn" } }),
    ]);
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "s-1" },
    });
    expect(activity).toContainEqual({
      type: "tool_use",
      tool: "curl -H Bearer [redacted]",
      summary: "curl -H Bearer [redacted]",
    });
  });

  it("discovers the model configId from configOptions instead of hardcoding", async () => {
    const { result } = await runReplay(
      [
        { input: { method: "initialize" } },
        rpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: organizationMcp } },
        rpc(2, {
          result: {
            sessionId: "s-2",
            configOptions: [
              { id: "reasoning", category: "thought_level", type: "select" },
              { id: "active_model", category: "model", type: "select" },
            ],
          },
        }),
        {
          input: {
            method: "session/set_config_option",
            params: {
              sessionId: "s-2",
              configId: "active_model",
              value: "custom-model",
            },
          },
        },
        rpc(3, { result: {} }),
        { input: { method: "session/prompt", params: { sessionId: "s-2" } } },
        rpc(4, { result: { stopReason: "end_turn" } }),
      ],
      { model: "custom-model" }
    );
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "s-2" },
    });
  });

  it("falls back to session/set_model when session/set_config_option returns -32601", async () => {
    const { result } = await runReplay(
      [
        { input: { method: "initialize" } },
        rpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: organizationMcp } },
        rpc(2, { result: { sessionId: "s-legacy" } }),
        {
          input: {
            method: "session/set_config_option",
            params: {
              sessionId: "s-legacy",
              configId: "model",
              value: "legacy-model",
            },
          },
        },
        rpc(3, { error: { code: -32601, message: "Method not found" } }),
        {
          input: {
            method: "session/set_model",
            params: { sessionId: "s-legacy", modelId: "legacy-model" },
          },
        },
        rpc(4, { result: {} }),
        {
          input: {
            method: "session/prompt",
            params: { sessionId: "s-legacy" },
          },
        },
        rpc(5, { result: { stopReason: "end_turn" } }),
      ],
      { model: "legacy-model" }
    );
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "s-legacy" },
    });
  });

  it("reports login_required when session/set_config_option rejects due to authentication", async () => {
    const { result } = await runReplay(
      [
        { input: { method: "initialize" } },
        rpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: organizationMcp } },
        rpc(2, { result: { sessionId: "s-auth" } }),
        {
          input: {
            method: "session/set_config_option",
            params: { sessionId: "s-auth", configId: "model", value: "m1" },
          },
        },
        rpc(3, { error: { code: -32000, message: "Not signed in" } }),
      ],
      { model: "m1" }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error: "프로바이더 실행이 실패했습니다.",
      errorCode: "login_required",
      summary: null,
      usage: null,
      nextSession: null,
    });
  });

  it("skips session/load when initialize advertises loadSession: false and starts a new session", async () => {
    const { result, activity } = await runReplay(
      [
        { input: { method: "initialize" } },
        rpc(1, {
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
          },
        }),
        { input: { method: "session/new", params: organizationMcp } },
        rpc(2, { result: { sessionId: "fresh" } }),
        { input: { method: "session/prompt", params: { sessionId: "fresh" } } },
        rpc(3, { result: { stopReason: "end_turn" } }),
      ],
      { previousSession: { id: "stale" } }
    );
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "fresh" },
    });
    expect(activity).toContainEqual({
      type: "progress",
      text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
    });
  });
});

describe("ACP parsing helpers", () => {
  it("extracts pretty-printed and prefixed JSON objects and strips ANSI codes", () => {
    expect(
      extractJsonObject(
        '\u001b[33mNotice: update available\u001b[0m\n{\n  "models": [\n    { "model_id": "a" }\n  ]\n}\n'
      )
    ).toEqual({ models: [{ model_id: "a" }] });
    expect(stripAnsi("\u001b[32m* grok-4.7\u001b[0m")).toBe("* grok-4.7");
    expect(isExplicitlySignedOut("Authenticated with IAM")).toBe(false);
    expect(isExplicitlySignedOut("Not logged in")).toBe(true);
    expect(isExplicitlySignedOut("Not signed in")).toBe(true);
  });
});
