import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRequest } from "@babojubot/contracts";
import { createKiroProvider as unownedKiroProvider } from "./kiro.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// `kiro-cli acp` 대화를 재생한다. 프레임 순서는 ACP v1의 initialize, session/new(또는 session/load), session/prompt다.
const folders = testFolders();
const createKiroProvider = folders.owning(unownedKiroProvider);
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
const opening = [
  { input: { method: "initialize" } },
  rpc(1, { result: { protocolVersion: 1 } }),
  { input: { method: "session/new", params: organizationMcp } },
  rpc(2, { result: { sessionId: "saved" } }),
];

async function run(
  steps: Record<string, unknown>[],
  patch: Partial<RunRequest> = {}
) {
  const root = await folders.make("kiro-acp-");
  const fixture = path.join(root, "fixture.json");
  await writeFile(
    fixture,
    JSON.stringify({
      argv: { acp: true },
      steps,
    })
  );
  const activity: unknown[] = [];
  const result = await createKiroProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ],
  }).adapter.execute(
    {
      ...request(),
      ...patch,
      workspace: { cwd: root, organization: root, personal: root, peers: [] },
    },
    {
      signal: new AbortController().signal,
      emit: async (item) => {
        activity.push(item);
      },
    }
  );
  return { result, activity };
}

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

describe("Kiro ACP", () => {
  it("declares isolatable: true so isolation mode fails closed without a verified relay", async () => {
    const root = await folders.make("kiro-meta-");
    const provider = createKiroProvider({ dataDir: root });
    expect(provider.isolatable).toBe(true);
    expect(provider.credentialRelay).toBeUndefined();
    expect(provider.models).toEqual([]);
  });

  it("gives the organization tools to the session and allows the tool it asks for", async () => {
    const { result, activity } = await run([
      ...opening,
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
      rpc(3, { result: { stopReason: "end_turn" } }),
    ]);
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
    const { result } = await run(
      [
        { input: { method: "initialize" } },
        rpc(1, { result: { protocolVersion: 1 } }),
        {
          input: {
            method: "session/load",
            params: { sessionId: "saved", ...organizationMcp },
          },
        },
        rpc(2, { result: {} }),
        prompt,
        rpc(3, { result: { stopReason: "end_turn" } }),
      ],
      { previousSession: { id: "saved" } }
    );
    expect(result).toEqual({
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: { id: "saved" },
    });
  });

  it("fails the run when the chosen model is refused", async () => {
    const { result } = await run(
      [
        ...opening,
        {
          input: {
            method: "session/set_config_option",
            params: { configId: "model", value: "claude-haiku-5.5" },
          },
        },
        rpc(3, { error: { message: "model unavailable" } }),
      ],
      { model: "claude-haiku-5.5" }
    );
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
  it("reads structured whoami JSON, falls back for older CLIs, and parses multi-line model JSON", async () => {
    const root = await folders.make("kiro-probe-");
    const program = path.join(root, "kiro.mjs");
    // 출력 직후 process.exit()를 부르지 않고 process.exitCode로 자연 종료해 파이프 쓰기를 끝까지 넘긴다(CODING_STANDARDS.md).
    await writeFile(
      program,
      [
        "const args = process.argv.slice(2);",
        "const mode = args[0];",
        "if (args.includes('whoami')) {",
        "  if (mode === 'signed-out-json') {",
        "    console.log(JSON.stringify({ account: null }));",
        "    process.exitCode = 1;",
        "  } else if (mode === 'legacy-cli') {",
        "    if (args.includes('--format')) {",
        "      console.error(\"error: unexpected argument '--format' found\");",
        "      process.exitCode = 2;",
        "    } else {",
        "      console.log('Authenticated with IAM Identity Center');",
        "    }",
        "  } else if (mode === 'broken') {",
        "    console.error('internal failure');",
        "    process.exitCode = 2;",
        "  } else {",
        "    console.log(JSON.stringify({ account: { provider: 'iam' } }));",
        "  }",
        "} else if (args.includes('--list-models')) {",
        "  if (mode === 'empty-models') {",
        "    console.log(JSON.stringify({ models: [] }));",
        "  } else {",
        "    console.log(JSON.stringify({ models: [{ model_id: 'auto', model_name: 'auto' }, { model_id: 'model-a', model_name: 'Model A' }] }, null, 2));",
        "  }",
        "} else {",
        "  process.exitCode = 9;",
        "}",
        "",
      ].join("\n")
    );
    const signal = new AbortController().signal;

    const readyProvider = createKiroProvider({
      dataDir: root,
      command: [process.execPath, program, "ready"],
    });
    await expect(readyProvider.adapter.checkReadiness(signal)).resolves.toEqual(
      { status: "ready", reason: null }
    );
    await expect(readyProvider.listModels?.(signal)).resolves.toEqual([
      { id: "auto", label: "auto" },
      { id: "model-a", label: "Model A" },
    ]);

    const legacyCli = createKiroProvider({
      dataDir: root,
      id: "kiro-legacy",
      command: [process.execPath, program, "legacy-cli"],
    });
    await expect(legacyCli.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });

    const signedOut = createKiroProvider({
      dataDir: root,
      id: "kiro-out",
      command: [process.execPath, program, "signed-out-json"],
    });
    await expect(signedOut.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "not_ready",
      reason: "product_login_missing",
    });

    const broken = createKiroProvider({
      dataDir: root,
      id: "kiro-broken",
      command: [process.execPath, program, "broken"],
    });
    await expect(broken.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "not_ready",
      reason: "check_failed",
    });

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
