import { access, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acpOrganizationMcp,
  acpRpc,
  readRecordedFrames,
  runAcpSessionReplay,
  runOwnedAcpSession,
  writeRecordingAcpPeer,
} from "./acp-test-support.ts";
import {
  extractJsonModels,
  extractJsonObject,
  hasPositiveLoginLine,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  isPositiveLoginLine,
  parsePlainBulletModels,
  stripAnsi,
} from "./host-cli.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

const folders = testFolders();

describe("ACP session client", () => {
  it("refuses container execution fail-closed without spawning a program", async () => {
    const root = await folders.make("acp-container-");
    const marker = path.join(root, "spawned");
    const { result } = await runOwnedAcpSession(
      folders,
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'ran')",
          marker,
        ],
        args: ["acp"],
        env: { ...process.env },
      },
      { ...request(), execution: "container" }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error:
        "이 프로바이더 연결은 격리 실행에서 쓸 인증 중계가 아직 검증되지 않아 실행하지 않았습니다.",
      summary: null,
      usage: null,
      nextSession: null,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("returns a failed RunResult without spawning when workspace.cwd does not exist", async () => {
    const root = await folders.make("acp-missing-cwd-");
    const missing = path.join(root, "does-not-exist");
    const marker = path.join(root, "spawned");
    const { result } = await runOwnedAcpSession(
      folders,
      {
        logName: "TestAcp",
        dataDir: root,
        connectionId: "test-acp",
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'ran')",
          marker,
        ],
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
      }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error: "프로바이더 실행이 실패했습니다.",
      summary: null,
      usage: null,
      nextSession: null,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports login_required when the process exits early with an auth error on stderr", async () => {
    const root = await folders.make("acp-early-auth-");
    const script = path.join(root, "auth-exit.mjs");
    await writeFile(
      script,
      "console.error('\\u001b[31mNot signed in. Run login first.\\u001b[0m');\nprocess.exitCode = 1;\n"
    );
    const { result } = await runOwnedAcpSession(
      folders,
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
      }
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

  it("keeps model refusal intact even when stderr logged a normal authentication banner", async () => {
    const root = await folders.make("acp-model-stderr-");
    const { script, logFile } = await writeRecordingAcpPeer(root, {
      expectedArgs: ["acp"],
      body: [
        "  if (msg.method === 'initialize') {",
        "    console.error('Authenticated with IAM Identity Center');",
        "    out({ id: msg.id, result: { protocolVersion: 1 } });",
        "  } else if (msg.method === 'session/new') {",
        "    out({ id: msg.id, result: { sessionId: 's-banner', configOptions: [{ id: 'model', category: 'model' }] } });",
        "  } else if (msg.method === 'session/set_config_option') {",
        "    out({ id: msg.id, error: { code: -32602, message: 'model unavailable' } });",
        "  }",
      ].join("\n"),
    });
    const { result } = await runOwnedAcpSession(
      folders,
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
      }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error: "고른 모델을 쓸 수 없어 실행하지 않았습니다.",
      summary: null,
      usage: null,
      nextSession: null,
    });
    const received = await readRecordedFrames(logFile);
    expect(received.map((frame) => frame.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
    ]);
  });

  it("reports login_required when session/prompt returns a generic RPC error alongside auth failure on stderr", async () => {
    const root = await folders.make("acp-prompt-stderr-auth-");
    const { script } = await writeRecordingAcpPeer(root, {
      expectedArgs: ["acp"],
      body: [
        "  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1 } });",
        "  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 's-stderr-auth' } });",
        "  else if (msg.method === 'session/prompt') {",
        "    console.error('401 Unauthorized: token expired');",
        "    out({ id: msg.id, error: { code: -32603, message: 'Internal error' } });",
        "  }",
      ].join("\n"),
    });
    const { result } = await runOwnedAcpSession(
      folders,
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
      }
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

  it("answers string JSON-RPC permission IDs preferring allow_once and omits raw tool_call updates from public activity", async () => {
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
    expect(activity).toEqual([
      { type: "progress", text: "프로바이더가 작업을 시작했습니다." },
    ]);
  });

  it("sends session/cancel and answers in-flight permission requests with cancelled once aborted", async () => {
    const root = await folders.make("acp-cancel-perm-");
    const stop = new AbortController();
    const trigger = createServer((socket) => {
      stop.abort();
      socket.end();
    });
    await new Promise<void>((resolve) =>
      trigger.listen(0, "127.0.0.1", () => resolve())
    );
    folders.own(
      () =>
        new Promise<void>((resolve, reject) =>
          trigger.close((error) => (error ? reject(error) : resolve()))
        ),
      "the cancel trigger server"
    );
    const address = trigger.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const { script, logFile } = await writeRecordingAcpPeer(root, {
      expectedArgs: ["acp"],
      body: [
        "  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1 } });",
        "  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 's-cancel' } });",
        "  else if (msg.method === 'session/prompt') {",
        "    promptId = msg.id;",
        `    const { createConnection } = await import('node:net');`,
        `    createConnection({ host: '127.0.0.1', port: ${port} });`,
        "  } else if (msg.method === 'session/cancel') {",
        "    out({ id: 'perm-after-cancel', method: 'session/request_permission', params: { sessionId: 's-cancel', options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }] } });",
        "  } else if (msg.id === 'perm-after-cancel') {",
        "    out({ id: promptId, result: { stopReason: 'cancelled' } });",
        "  }",
      ].join("\n"),
    });
    const { result } = await runOwnedAcpSession(
      folders,
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
      { controller: stop }
    );
    expect(result).toEqual({
      stopReason: "cancelled",
      error: null,
      summary: null,
      usage: null,
      nextSession: null,
    });
    const received = await readRecordedFrames(logFile);
    expect(received.map((frame) => frame.method ?? frame.id)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
      "perm-after-cancel",
    ]);
    expect(received.at(-2)).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "s-cancel" },
    });
    expect(received.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "perm-after-cancel",
      result: { outcome: { outcome: "cancelled" } },
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
    const root = await folders.make("acp-auth-refusal-");
    const { script, logFile } = await writeRecordingAcpPeer(root, {
      expectedArgs: ["acp"],
      body: [
        "  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1 } });",
        "  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 's-auth' } });",
        "  else if (msg.method === 'session/set_config_option') out({ id: msg.id, error: { code: -32000, message: 'Not signed in' } });",
      ].join("\n"),
    });
    const { result } = await runOwnedAcpSession(
      folders,
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
        model: "m1",
        workspace: { cwd: root, organization: root, personal: root, peers: [] },
      }
    );
    expect(result).toEqual({
      stopReason: "failed",
      error: "프로바이더 실행이 실패했습니다.",
      errorCode: "login_required",
      summary: null,
      usage: null,
      nextSession: null,
    });
    const received = await readRecordedFrames(logFile);
    expect(received.map((frame) => frame.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
    ]);
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
    expect(activity).toEqual([
      {
        type: "progress",
        text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
      },
      { type: "progress", text: "프로바이더가 작업을 시작했습니다." },
    ]);
  });

  it("resets configOptions from a failed session/load before falling back to session/new", async () => {
    const { result } = await runAcpSessionReplay(folders, {
      prefix: "acp-load-reset-config-",
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        {
          input: {
            method: "session/load",
            params: { sessionId: "stale-cfg", ...acpOrganizationMcp },
          },
        },
        {
          frame: {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "stale-cfg",
              update: {
                sessionUpdate: "config_option_update",
                configOptions: [{ id: "stale_model", category: "model" }],
              },
            },
          },
        },
        acpRpc(2, { error: { code: -32002, message: "session not found" } }),
        { input: { method: "session/new", params: acpOrganizationMcp } },
        acpRpc(3, { result: { sessionId: "fresh-cfg" } }),
        {
          input: {
            method: "session/set_config_option",
            params: {
              sessionId: "fresh-cfg",
              configId: "model",
              value: "m-fresh",
            },
          },
        },
        acpRpc(4, { result: {} }),
        {
          input: {
            method: "session/prompt",
            params: { sessionId: "fresh-cfg" },
          },
        },
        acpRpc(5, { result: { stopReason: "end_turn" } }),
      ],
      patch: { previousSession: { id: "stale-cfg" }, model: "m-fresh" },
    });
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "fresh-cfg" },
    });
  });
});

describe("Host CLI parsing and login classification helpers", () => {
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
    expect(isAcpAuthProblem("Authenticated with IAM: 401 Unauthorized")).toBe(
      true
    );
  });

  it("distinguishes positive login confirmations from negative, expired, or ambiguous text", () => {
    expect(isPositiveLoginLine("Authenticated with IAM Identity Center")).toBe(
      true
    );
    expect(isPositiveLoginLine("Logged in with IAM Identity Center")).toBe(
      true
    );
    expect(isPositiveLoginLine("You are logged in with grok.com.")).toBe(true);
    expect(
      hasPositiveLoginLine(
        "Notice: cache error\nLogged in with IAM Identity Center"
      )
    ).toBe(true);
    expect(
      isPositiveLoginLine("Authenticated with IAM: 401 Unauthorized")
    ).toBe(false);
    expect(
      isPositiveLoginLine("Session expired (previously logged in as alice)")
    ).toBe(false);
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

  it("parses structured plain bullet models while rejecting prose and help bullets", () => {
    expect(
      parsePlainBulletModels(
        [
          "  - Help",
          "  - Help (show usage)",
          "  - login   Sign in",
          "  - 1. Run login first",
          "  - non-interactive mode",
          "  - v2 API enabled",
          "  * auto  Automatic selection",
          "  * grok-fast  Fast coding model",
          "  * grok-fast (default)",
          "  * claude-opus (default) - Fast reasoning model",
          "  * Grok-4.8 (default)",
          "  - grok-4.5",
        ].join("\n")
      )
    ).toEqual([
      { id: "auto", label: "auto" },
      { id: "grok-fast", label: "grok-fast" },
      { id: "claude-opus", label: "claude-opus" },
      { id: "Grok-4.8", label: "Grok-4.8" },
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
  });
});
