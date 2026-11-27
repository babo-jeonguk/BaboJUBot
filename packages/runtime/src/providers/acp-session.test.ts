import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractJsonObject,
  extractJsonValue,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  isPositiveLoginLine,
  runAcpSession,
  stripAnsi,
} from "./acp-session.ts";
import {
  acpOrganizationMcp,
  acpRpc,
  runAcpSessionReplay,
} from "./acp-test-support.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

const folders = testFolders();

describe("ACP session client", () => {
  it("refuses container execution fail-closed without spawning a program", async () => {
    const root = await folders.make("acp-container-");
    const result = await runAcpSession(
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
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

  it("places workspace-less planning runs in an organization folder separate from recovery records", async () => {
    const runRequest = request();
    const root = await folders.make("acp-planning-cwd-");
    const expectedOrgDir = path.join(
      root,
      "providers",
      "test-acp",
      "organizations",
      runRequest.identity.organizationId
    );
    const fixture = path.join(root, "fixture.json");
    // replay가 받은 session/new.params.cwd를 정확히 조직 폴더로 대조해 연결 폴더(processes 기록 위치)와 분리됨을 확인한다.
    const realRoot = await realpath(root);
    const expectedRealOrgDir = path.join(
      realRoot,
      "providers",
      "test-acp",
      "organizations",
      runRequest.identity.organizationId
    );
    await writeFile(
      fixture,
      JSON.stringify({
        argv: { acp: true },
        steps: [
          { input: { method: "initialize" } },
          acpRpc(1, { result: { protocolVersion: 1 } }),
          {
            input: {
              method: "session/new",
              params: { cwd: expectedRealOrgDir, ...acpOrganizationMcp },
            },
          },
          acpRpc(2, { result: { sessionId: "plan-1" } }),
          {
            input: {
              method: "session/prompt",
              params: { sessionId: "plan-1" },
            },
          },
          acpRpc(3, { result: { stopReason: "end_turn" } }),
        ],
      })
    );
    const stop = new AbortController();
    const running = runAcpSession(
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
        command: [
          process.execPath,
          path.resolve("test-fixtures/replay.mjs"),
          fixture,
        ],
        args: ["acp"],
        env: { ...process.env },
      },
      { ...runRequest, workspace: null },
      { signal: stop.signal, emit: async () => {} }
    );
    folders.own(async () => {
      stop.abort();
      await running.catch(() => undefined);
    }, "a planning ACP replay run");
    const result = await running;
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "plan-1" },
    });
    await expect(realpath(expectedOrgDir)).resolves.toBe(expectedRealOrgDir);
  });

  it("returns a failed RunResult instead of throwing when workspace.cwd does not exist", async () => {
    const root = await folders.make("acp-missing-cwd-");
    const missing = path.join(root, "does-not-exist");
    const result = await runAcpSession(
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
        command: [path.join(root, "must-not-run")],
        args: ["acp"],
        env: { ...process.env },
      },
      {
        ...request(),
        workspace: {
          cwd: missing,
          organization: root,
          personal: root,
          peers: [],
        },
      },
      { signal: new AbortController().signal, emit: async () => {} }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error: "프로바이더 실행이 실패했습니다.",
      summary: null,
      usage: null,
      nextSession: null,
    });
  });

  it("reports login_required when the process exits early with an auth error on stderr", async () => {
    const root = await folders.make("acp-early-auth-");
    const script = path.join(root, "auth-exit.mjs");
    await writeFile(
      script,
      "console.error('\\u001b[31mNot signed in. Run login first.\\u001b[0m');\nprocess.exitCode = 1;\n"
    );
    const stop = new AbortController();
    const running = runAcpSession(
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
        command: [process.execPath, script],
        args: ["acp"],
        env: { ...process.env },
      },
      {
        ...request(),
        workspace: { cwd: root, organization: root, personal: root, peers: [] },
      },
      { signal: stop.signal, emit: async () => {} }
    );
    folders.own(async () => {
      stop.abort();
      await running.catch(() => undefined);
    }, "an early-exit ACP run");
    await expect(running).resolves.toEqual({
      stopReason: "failed",
      error: "프로바이더 실행이 실패했습니다.",
      errorCode: "login_required",
      summary: null,
      usage: null,
      nextSession: null,
    });
  });

  it("answers string JSON-RPC permission IDs preferring allow_once and redacts run tokens in tool titles", async () => {
    const { result, activity } = await runAcpSessionReplay(folders, {
      prefix: "acp-perm-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(2, { result: { sessionId: "s-1" } }),
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
        acpRpc(3, { result: { stopReason: "end_turn" } }),
      ],
    });
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

  it("discovers the model configId from config_option_update emitted during session/load", async () => {
    const { result } = await runAcpSessionReplay(folders, {
      prefix: "acp-config-update-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        {
          input: {
            method: "session/load",
            params: { sessionId: "s-2", ...acpOrganizationMcp },
          },
        },
        {
          frame: {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-2",
              update: {
                sessionUpdate: "config_option_update",
                configOptions: [
                  { id: "reasoning", category: "thought_level" },
                  { id: "active_model", category: "model" },
                ],
              },
            },
          },
        },
        acpRpc(2, { result: {} }),
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
        acpRpc(3, { result: {} }),
        { input: { method: "session/prompt", params: { sessionId: "s-2" } } },
        acpRpc(4, { result: { stopReason: "end_turn" } }),
      ],
      patch: { previousSession: { id: "s-2" }, model: "custom-model" },
    });
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "s-2" },
    });
  });

  it("falls back to session/set_model when session/set_config_option returns -32601", async () => {
    const { result } = await runAcpSessionReplay(folders, {
      prefix: "acp-set-model-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(2, { result: { sessionId: "s-legacy" } }),
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
        acpRpc(3, { error: { code: -32601, message: "Method not found" } }),
        {
          input: {
            method: "session/set_model",
            params: { sessionId: "s-legacy", modelId: "legacy-model" },
          },
        },
        acpRpc(4, { result: {} }),
        {
          input: {
            method: "session/prompt",
            params: { sessionId: "s-legacy" },
          },
        },
        acpRpc(5, { result: { stopReason: "end_turn" } }),
      ],
      patch: { model: "legacy-model" },
    });
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "s-legacy" },
    });
  });

  it("reports login_required and sends no prompt when session/set_config_option rejects due to authentication", async () => {
    const { result } = await runAcpSessionReplay(folders, {
      prefix: "acp-auth-refusal-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(2, { result: { sessionId: "s-auth" } }),
        {
          input: {
            method: "session/set_config_option",
            params: { sessionId: "s-auth", configId: "model", value: "m1" },
          },
        },
        acpRpc(3, { error: { code: -32000, message: "Not signed in" } }),
        { inputEnd: true },
      ],
      patch: { model: "m1" },
    });
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
    const { result, activity } = await runAcpSessionReplay(folders, {
      prefix: "acp-no-load-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, {
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
          },
        }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(2, { result: { sessionId: "fresh" } }),
        { input: { method: "session/prompt", params: { sessionId: "fresh" } } },
        acpRpc(3, { result: { stopReason: "end_turn" } }),
      ],
      patch: { previousSession: { id: "stale" } },
    });
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

describe("ACP parsing and login classification helpers", () => {
  it("strips ANSI CSI and OSC sequences and detects signed-out phrases wrapped in ANSI codes", () => {
    expect(stripAnsi("\u001b[32m* grok-4.7\u001b[0m")).toBe("* grok-4.7");
    expect(stripAnsi("\u001b]0;window title\u0007Logged in")).toBe("Logged in");
    expect(
      stripAnsi("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")
    ).toBe("link");
    expect(isExplicitlySignedOut("\u001b[31mNot signed in\u001b[0m")).toBe(
      true
    );
    expect(isAcpAuthProblem("\u001b[31mNot signed in\u001b[0m")).toBe(true);
  });

  it("distinguishes positive login confirmations from negative or ambiguous text", () => {
    expect(isPositiveLoginLine("Authenticated with IAM Identity Center")).toBe(
      true
    );
    expect(isPositiveLoginLine("Logged in with IAM Identity Center")).toBe(
      true
    );
    expect(isPositiveLoginLine("You are logged in with grok.com.")).toBe(true);
    expect(isPositiveLoginLine("Not authenticated")).toBe(false);
    expect(isPositiveLoginLine("You must be logged in to continue.")).toBe(
      false
    );
    expect(isPositiveLoginLine("")).toBe(false);
    expect(isPositiveLoginLine("Unexpected banner")).toBe(false);
  });

  it("extracts multi-line JSON objects and arrays even when prefix notices contain braces", () => {
    expect(
      extractJsonObject(
        '\u001b[33mNotice: {update available}\u001b[0m\n{\n  "models": [\n    { "model_id": "a" }\n  ]\n}\n'
      )
    ).toEqual({ models: [{ model_id: "a" }] });
    expect(
      extractJsonValue('Notice: ready\n[\n  { "id": "grok-4.7" }\n]\n')
    ).toEqual([{ id: "grok-4.7" }]);
  });
});
