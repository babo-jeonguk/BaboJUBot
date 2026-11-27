import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractJsonModels,
  extractJsonObject,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  isPositiveLoginLine,
  parsePlainBulletModels,
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
        command: [process.execPath, "-e", "process.exitCode = 99"],
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
    const { result, root, realRoot, runRequest } = await runAcpSessionReplay(
      folders,
      {
        prefix: "acp-planning-cwd-",
        patch: { workspace: null },
        steps: ({ realRoot: resolvedRoot, runRequest: req }) => {
          const expectedRealOrgDir = path.join(
            resolvedRoot,
            "providers",
            "test-acp",
            "organizations",
            req.identity.organizationId
          );
          return [
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
          ];
        },
      }
    );
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "plan-1" },
    });
    const expectedOrgDir = path.join(
      root,
      "providers",
      "test-acp",
      "organizations",
      runRequest.identity.organizationId
    );
    await expect(realpath(expectedOrgDir)).resolves.toBe(
      path.join(
        realRoot,
        "providers",
        "test-acp",
        "organizations",
        runRequest.identity.organizationId
      )
    );
  });

  it("returns a failed RunResult instead of throwing when workspace.cwd does not exist", async () => {
    const root = await folders.make("acp-missing-cwd-");
    const missing = path.join(root, "does-not-exist");
    // 실행 가능한 명령을 넘겨 spawn 실패가 아니라 realpath 단계에서 실패로 잡히는지 확인한다.
    const result = await runAcpSession(
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
        command: [process.execPath, "-e", "process.exitCode = 99"],
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

  it("keeps model refusal intact even when stderr logged a normal authentication banner", async () => {
    const root = await folders.make("acp-model-stderr-");
    const script = path.join(root, "banner-refuse.mjs");
    await writeFile(
      script,
      [
        "import { createInterface } from 'node:readline';",
        "console.error('Authenticated with IAM Identity Center');",
        "const out = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');",
        "for await (const line of createInterface({ input: process.stdin })) {",
        "  if (!line.trim()) continue;",
        "  const { id, method } = JSON.parse(line);",
        "  if (method === 'initialize') out({ id, result: { protocolVersion: 1 } });",
        "  else if (method === 'session/new') out({ id, result: { sessionId: 's-banner', configOptions: [{ id: 'model', category: 'model' }] } });",
        "  else if (method === 'session/set_config_option') out({ id, error: { code: -32602, message: 'model unavailable' } });",
        "}",
        "",
      ].join("\n")
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
        model: "bad-model",
        workspace: { cwd: root, organization: root, personal: root, peers: [] },
      },
      { signal: stop.signal, emit: async () => {} }
    );
    folders.own(async () => {
      stop.abort();
      await running.catch(() => undefined);
    }, "a banner-stderr ACP run");
    await expect(running).resolves.toEqual({
      stopReason: "failed",
      error: "고른 모델을 쓸 수 없어 실행하지 않았습니다.",
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

  it("answers in-flight permission requests with cancelled once the run is aborted", async () => {
    const { result } = await runAcpSessionReplay(folders, {
      prefix: "acp-cancel-perm-",
      onEmit: (item, abort) => {
        if (
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "tool_use"
        )
          abort();
      },
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(2, { result: { sessionId: "s-cancel" } }),
        {
          input: {
            method: "session/prompt",
            params: { sessionId: "s-cancel" },
          },
        },
        {
          frame: {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-cancel",
              update: { sessionUpdate: "tool_call", title: "send_message" },
            },
          },
        },
        {
          input: {
            method: "session/cancel",
            params: { sessionId: "s-cancel" },
          },
        },
        {
          frame: {
            jsonrpc: "2.0",
            id: "perm-after-cancel",
            method: "session/request_permission",
            params: {
              sessionId: "s-cancel",
              options: [
                { optionId: "once", kind: "allow_once", name: "Allow once" },
              ],
            },
          },
        },
        {
          input: {
            id: "perm-after-cancel",
            result: { outcome: { outcome: "cancelled" } },
          },
        },
        acpRpc(3, { result: { stopReason: "cancelled" } }),
      ],
    });
    expect(result).toEqual({
      stopReason: "cancelled",
      error: null,
      summary: null,
      usage: null,
      nextSession: null,
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

  it("uses session/set_model directly for transitional agents whose configOptions omit a model entry", async () => {
    const { result } = await runAcpSessionReplay(folders, {
      prefix: "acp-transitional-model-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(2, {
          result: {
            sessionId: "s-trans",
            configOptions: [{ id: "mode", category: "mode" }],
          },
        }),
        {
          input: {
            method: "session/set_model",
            params: { sessionId: "s-trans", modelId: "trans-model" },
          },
        },
        acpRpc(3, { result: {} }),
        {
          input: { method: "session/prompt", params: { sessionId: "s-trans" } },
        },
        acpRpc(4, { result: { stopReason: "end_turn" } }),
      ],
      patch: { model: "trans-model" },
    });
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "s-trans" },
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
  it("strips ANSI CSI and OSC sequences and evaluates auth errors per line excluding positive lines", () => {
    expect(stripAnsi("\u001b[32m* grok-4.7\u001b[0m")).toBe("* grok-4.7");
    expect(stripAnsi("\u001b]0;window title\u0007Logged in")).toBe("Logged in");
    expect(
      stripAnsi("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")
    ).toBe("link");
    expect(isExplicitlySignedOut("\u001b[31mNot signed in\u001b[0m")).toBe(
      true
    );
    expect(isAcpAuthProblem("\u001b[31mNot signed in\u001b[0m")).toBe(true);
    expect(
      isAcpAuthProblem("Authenticated with IAM Identity Center\nNetwork error")
    ).toBe(false);
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

  it("ignores bracketed log prefixes like [1] or [2] when extracting JSON objects and model lists", () => {
    expect(
      extractJsonObject(
        '[1] Loading...\n\u001b[33mNotice: {update}\u001b[0m\n{\n  "account": { "id": "u1" }\n}\n'
      )
    ).toEqual({ account: { id: "u1" } });
    expect(extractJsonModels("Available models [2]:\n  * grok-4.7")).toBe(
      undefined
    );
    expect(
      extractJsonModels('Notice [2]:\n[\n  { "id": "grok-4.7" }\n]\n')
    ).toEqual([{ id: "grok-4.7", label: "grok-4.7" }]);
  });

  it("parses plain bullet models including auto with description while rejecting help and numbered lists", () => {
    expect(
      parsePlainBulletModels(
        [
          "  - Help",
          "  - 1. Run login first",
          "  - non-interactive mode",
          "  * auto  Automatic selection",
          "  * Grok-4.8 (default)",
          "  - grok-4.5",
        ].join("\n")
      )
    ).toEqual([
      { id: "auto", label: "auto" },
      { id: "Grok-4.8", label: "Grok-4.8" },
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
  });
});
