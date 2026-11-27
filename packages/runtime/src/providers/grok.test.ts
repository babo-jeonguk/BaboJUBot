import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGrokProvider as unownedGrokProvider } from "./grok.ts";
import {
  acpOpening,
  acpOrganizationMcp,
  acpRpc,
  runProviderAcpReplay,
} from "./acp-test-support.ts";
import { testFolders } from "./test-folders.ts";

// `grok agent --no-leader stdio` 대화를 재생한다. 프레임 순서는 ACP v1의 initialize, session/new(또는 session/load), session/prompt다.
const folders = testFolders();
const createGrokProvider = folders.owning(unownedGrokProvider);

const prompt = {
  input: { method: "session/prompt", params: { sessionId: "saved" } },
};
const permission = {
  frame: {
    jsonrpc: "2.0",
    id: 50,
    method: "session/request_permission",
    params: {
      sessionId: "saved",
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "reject", kind: "reject_once", name: "Deny" },
      ],
    },
  },
};
const allowed = {
  input: {
    id: 50,
    result: { outcome: { outcome: "selected", optionId: "allow" } },
  },
};

/** 정확한 CLI 인자 배열을 검증하는 가짜 `grok`을 만든다. 출력 직후 `process.exit()` 대신 `process.exitCode`로 자연 종료한다. */
async function createProbeFixture(root: string): Promise<string> {
  const program = path.join(root, "grok.mjs");
  await writeFile(
    program,
    [
      "const [mode, ...args] = process.argv.slice(2);",
      "if (JSON.stringify(args) !== JSON.stringify(['models'])) {",
      "  process.exitCode = 9;",
      "} else if (mode === 'signed-out') {",
      "  console.error('\\u001b[31mNot signed in\\u001b[0m');",
      "  process.exitCode = 1;",
      "} else if (mode === 'signed-out-zero') {",
      "  console.log('Not authenticated. You must be logged in.');",
      "} else if (mode === 'unknown-zero') {",
      "  console.log('Unexpected status banner');",
      "} else if (mode === 'broken') {",
      "  console.error('internal failure');",
      "  process.exitCode = 2;",
      "} else if (mode === 'models-only') {",
      "  console.log('  * Grok-4.8 (default)');",
      "} else if (mode === 'json-array') {",
      "  console.log(JSON.stringify([{ id: 'grok-json-1', name: 'Grok JSON 1' }]));",
      "} else if (mode === 'empty-models') {",
      "  console.log('You are logged in with grok.com.');",
      "} else if (mode === 'ready') {",
      "  console.log('You are logged in with grok.com.');",
      "  console.log('  - run grok login to switch accounts');",
      "  console.log('  - Run grok login to switch accounts');",
      "  console.log('  \\u001b[32m* grok-4.7 (default)\\u001b[0m');",
      "  console.log('  - grok-4.5');",
      "} else {",
      "  process.exitCode = 9;",
      "}",
      "",
    ].join("\n")
  );
  return program;
}

describe("Grok Build ACP", () => {
  it("declares isolatable: true so isolation mode fails closed without a verified relay", async () => {
    const root = await folders.make("grok-meta-");
    const provider = createGrokProvider({ dataDir: root });
    expect(provider.isolatable).toBe(true);
    expect(provider.credentialRelay).toBeUndefined();
    expect(provider.models).toEqual([]);
  });

  it("gives the organization tools to the session and allows the tool it asks for", async () => {
    const { result, activity } = await runProviderAcpReplay(
      folders,
      createGrokProvider,
      {
        prefix: "grok-acp-",
        argv: { agent: true, "--no-leader": true, stdio: true },
        steps: [
          ...acpOpening,
          prompt,
          {
            frame: {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "saved",
                update: { sessionUpdate: "tool_call", title: "send_message" },
              },
            },
          },
          permission,
          allowed,
          acpRpc(3, { result: { stopReason: "end_turn" } }),
        ],
      }
    );
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "saved" },
    });
    expect(activity).toContainEqual({
      type: "tool_use",
      tool: "send_message",
      summary: "send_message",
    });
  });

  it("loads the previous session with organization MCP servers instead of starting another", async () => {
    const { result } = await runProviderAcpReplay(folders, createGrokProvider, {
      prefix: "grok-load-",
      argv: { agent: true, "--no-leader": true, stdio: true },
      steps: [
        { input: { method: "initialize" } },
        acpRpc(1, { result: { protocolVersion: 1 } }),
        {
          input: {
            method: "session/load",
            params: { sessionId: "saved", ...acpOrganizationMcp },
          },
        },
        acpRpc(2, { result: {} }),
        prompt,
        acpRpc(3, { result: { stopReason: "end_turn" } }),
      ],
      patch: { previousSession: { id: "saved" } },
    });
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "saved" },
    });
  });

  it("fails the run without sending session/prompt when the chosen model is refused", async () => {
    const { result } = await runProviderAcpReplay(folders, createGrokProvider, {
      prefix: "grok-model-refused-",
      argv: { agent: true, "--no-leader": true, stdio: true },
      steps: [
        ...acpOpening,
        {
          input: {
            method: "session/set_config_option",
            params: { configId: "model", value: "grok-4.5" },
          },
        },
        acpRpc(3, { error: { message: "model unavailable" } }),
        { inputEnd: true },
      ],
      patch: { model: "grok-4.5" },
    });
    expect(result).toEqual({
      stopReason: "failed",
      error: "고른 모델을 쓸 수 없어 실행하지 않았습니다.",
      summary: null,
      usage: null,
      nextSession: null,
    });
  });
});

describe("Grok readiness and models", () => {
  it("parses ANSI-colored bullet models while ignoring lowercase and uppercase prose bullets", async () => {
    const root = await folders.make("grok-ready-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    const provider = createGrokProvider({
      dataDir: root,
      command: [process.execPath, program, "ready"],
    });
    await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });
    await expect(provider.listModels?.(signal)).resolves.toEqual([
      { id: "grok-4.7", label: "grok-4.7" },
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
  });

  it("accepts model-only exit-0 output with capitalized IDs and top-level JSON model arrays", async () => {
    const root = await folders.make("grok-formats-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;

    const modelsOnly = createGrokProvider({
      dataDir: root,
      id: "grok-models-only",
      command: [process.execPath, program, "models-only"],
    });
    await expect(modelsOnly.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });
    await expect(modelsOnly.listModels?.(signal)).resolves.toEqual([
      { id: "Grok-4.8", label: "Grok-4.8" },
    ]);

    const jsonArray = createGrokProvider({
      dataDir: root,
      id: "grok-json-array",
      command: [process.execPath, program, "json-array"],
    });
    await expect(jsonArray.listModels?.(signal)).resolves.toEqual([
      { id: "grok-json-1", label: "Grok JSON 1" },
    ]);
  });

  it("reports product_login_missing for ANSI-wrapped signed-out stderr and exit-0 auth prompts", async () => {
    const root = await folders.make("grok-signed-out-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    for (const [id, mode] of [
      ["grok-out", "signed-out"],
      ["grok-out-zero", "signed-out-zero"],
    ] as const) {
      const provider = createGrokProvider({
        dataDir: root,
        id,
        command: [process.execPath, program, mode],
      });
      await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
        status: "not_ready",
        reason: "product_login_missing",
      });
    }
  });

  it("fails closed with check_failed on unrecognized exit-0 output or non-zero failures", async () => {
    const root = await folders.make("grok-fail-closed-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    for (const [id, mode] of [
      ["grok-unknown", "unknown-zero"],
      ["grok-broken", "broken"],
    ] as const) {
      const provider = createGrokProvider({
        dataDir: root,
        id,
        command: [process.execPath, program, mode],
      });
      await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
        status: "not_ready",
        reason: "check_failed",
      });
    }
  });

  it("rejects empty model lists and reports program_missing for absent binaries", async () => {
    const root = await folders.make("grok-missing-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    const emptyModels = createGrokProvider({
      dataDir: root,
      id: "grok-empty",
      command: [process.execPath, program, "empty-models"],
    });
    await expect(emptyModels.listModels?.(signal)).rejects.toThrow(
      "Grok returned no models"
    );
    const missing = createGrokProvider({
      dataDir: root,
      id: "grok-missing",
      command: [path.join(root, "missing-grok")],
    });
    await expect(missing.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "not_ready",
      reason: "program_missing",
    });
  });
});
