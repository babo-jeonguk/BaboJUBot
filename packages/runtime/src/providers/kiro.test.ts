import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKiroProvider as unownedKiroProvider } from "./kiro.ts";
import {
  acpOpening,
  acpOrganizationMcp,
  acpRpc,
  runProviderAcpReplay,
} from "./acp-test-support.ts";
import { testFolders } from "./test-folders.ts";

// `kiro-cli acp` 대화를 재생한다. 프레임 순서는 ACP v1의 initialize, session/new(또는 session/load), session/prompt다.
const folders = testFolders();
const createKiroProvider = folders.owning(unownedKiroProvider);

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

/** 정확한 CLI 인자 배열을 검증하는 가짜 `kiro-cli`를 만든다. 출력 직후 `process.exit()` 대신 `process.exitCode`로 자연 종료한다. */
async function createProbeFixture(root: string): Promise<string> {
  const program = path.join(root, "kiro.mjs");
  await writeFile(
    program,
    [
      "const [mode, ...args] = process.argv.slice(2);",
      "const key = JSON.stringify(args);",
      "if (key === JSON.stringify(['whoami', '--format', 'json'])) {",
      "  if (mode === 'ready') console.log(JSON.stringify({ account: { provider: 'iam' } }));",
      "  else if (mode === 'signed-out-json') { console.log(JSON.stringify({ account: null })); process.exitCode = 1; }",
      "  else if (mode === 'unknown-json') console.log(JSON.stringify({}));",
      "  else if (mode === 'legacy-cli') { console.error(\"error: unexpected argument '--format' found\"); process.exitCode = 2; }",
      "  else if (mode === 'legacy-empty') { console.error(\"error: unexpected argument '--format' found\"); process.exitCode = 2; }",
      "  else if (mode === 'broken') { console.error('internal failure'); process.exitCode = 2; }",
      "  else process.exitCode = 9;",
      "} else if (key === JSON.stringify(['whoami'])) {",
      "  if (mode === 'legacy-cli') console.log('Authenticated with IAM Identity Center');",
      "  else if (mode === 'legacy-empty') console.log('');",
      "  else process.exitCode = 9;",
      "} else if (key === JSON.stringify(['chat', '--list-models', '--format', 'json'])) {",
      "  if (mode === 'ready') console.log(JSON.stringify({ models: [{ model_id: 'auto', model_name: 'auto' }, { model_id: 'model-a', model_name: 'Model A' }] }, null, 2));",
      "  else if (mode === 'legacy-cli') { console.error(\"error: unexpected argument '--format' found\"); process.exitCode = 2; }",
      "  else if (mode === 'empty-models') console.log(JSON.stringify({ models: [] }));",
      "  else process.exitCode = 9;",
      "} else if (key === JSON.stringify(['chat', '--list-models'])) {",
      "  if (mode === 'legacy-cli') { console.log('  * auto (default)'); console.log('  - model-legacy-1'); }",
      "  else process.exitCode = 9;",
      "} else {",
      "  process.exitCode = 9;",
      "}",
      "",
    ].join("\n")
  );
  return program;
}

describe("Kiro ACP", () => {
  it("declares isolatable: true so isolation mode fails closed without a verified relay", async () => {
    const root = await folders.make("kiro-meta-");
    const provider = createKiroProvider({ dataDir: root });
    expect(provider.isolatable).toBe(true);
    expect(provider.credentialRelay).toBeUndefined();
    expect(provider.models).toEqual([]);
  });

  it("gives the organization tools to the session and allows the tool it asks for", async () => {
    const { result, activity } = await runProviderAcpReplay(
      folders,
      createKiroProvider,
      {
        prefix: "kiro-acp-",
        argv: { acp: true },
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
    const { result } = await runProviderAcpReplay(folders, createKiroProvider, {
      prefix: "kiro-load-",
      argv: { acp: true },
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
    const { result } = await runProviderAcpReplay(folders, createKiroProvider, {
      prefix: "kiro-model-refused-",
      argv: { acp: true },
      steps: [
        ...acpOpening,
        {
          input: {
            method: "session/set_config_option",
            params: { configId: "model", value: "claude-haiku-5.5" },
          },
        },
        acpRpc(3, { error: { message: "model unavailable" } }),
        { inputEnd: true },
      ],
      patch: { model: "claude-haiku-5.5" },
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

describe("Kiro readiness and models", () => {
  it("reports ready from structured whoami JSON and parses multi-line model JSON", async () => {
    const root = await folders.make("kiro-ready-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    const provider = createKiroProvider({
      dataDir: root,
      command: [process.execPath, program, "ready"],
    });
    await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });
    await expect(provider.listModels?.(signal)).resolves.toEqual([
      { id: "auto", label: "auto" },
      { id: "model-a", label: "Model A" },
    ]);
  });

  it("falls back to plain whoami and plain list-models when an older CLI rejects --format", async () => {
    const root = await folders.make("kiro-legacy-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    const provider = createKiroProvider({
      dataDir: root,
      id: "kiro-legacy",
      command: [process.execPath, program, "legacy-cli"],
    });
    await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });
    await expect(provider.listModels?.(signal)).resolves.toEqual([
      { id: "auto", label: "auto" },
      { id: "model-legacy-1", label: "model-legacy-1" },
    ]);
  });

  it("reports product_login_missing when whoami JSON reports account: null", async () => {
    const root = await folders.make("kiro-signed-out-");
    const program = await createProbeFixture(root);
    const provider = createKiroProvider({
      dataDir: root,
      id: "kiro-out",
      command: [process.execPath, program, "signed-out-json"],
    });
    await expect(
      provider.adapter.checkReadiness(new AbortController().signal)
    ).resolves.toEqual({
      status: "not_ready",
      reason: "product_login_missing",
    });
  });

  it("fails closed with check_failed on unrecognized JSON, empty plain stdout, or non-zero failure", async () => {
    const root = await folders.make("kiro-fail-closed-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    for (const [id, mode] of [
      ["kiro-unknown", "unknown-json"],
      ["kiro-empty-plain", "legacy-empty"],
      ["kiro-broken", "broken"],
    ] as const) {
      const provider = createKiroProvider({
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
    const root = await folders.make("kiro-missing-");
    const program = await createProbeFixture(root);
    const signal = new AbortController().signal;
    const emptyModels = createKiroProvider({
      dataDir: root,
      id: "kiro-empty",
      command: [process.execPath, program, "empty-models"],
    });
    await expect(emptyModels.listModels?.(signal)).rejects.toThrow(
      "Kiro returned no models"
    );
    const missing = createKiroProvider({
      dataDir: root,
      id: "kiro-missing",
      command: [path.join(root, "missing-kiro")],
    });
    await expect(missing.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "not_ready",
      reason: "program_missing",
    });
  });
});
