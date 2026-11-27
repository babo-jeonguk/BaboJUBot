import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRequest } from "@babojubot/contracts";
import { createKiroProvider as unownedKiroProvider } from "./kiro.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// `kiro-cli acp --agent-engine=v3` 대화를 재생한다. 프레임 순서는 Kiro CLI 3.6 ACP 문서의 initialize, session/new, session/prompt다.
const folders = testFolders();
const createKiroProvider = folders.owning(unownedKiroProvider);
const rpc = (id: number, body: Record<string, unknown>) => ({
  frame: { jsonrpc: "2.0", id, ...body },
});
const opening = [
  { input: { method: "initialize" } },
  rpc(1, { result: { protocolVersion: 1 } }),
  {
    input: {
      method: "session/new",
      params: {
        mcpServers: [
          {
            type: "http",
            name: "organization",
            url: "http://127.0.0.1:1/api/tools/mcp",
            headers: [
              { name: "Authorization", value: "Bearer private-run-token" },
            ],
          },
        ],
      },
    },
  },
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
      argv: { acp: true, "--agent-engine": "v3", "--auth-method": "cli" },
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
    expect(result).toMatchObject({
      stopReason: "completed",
      nextSession: { id: "saved" },
    });
    expect(activity).toContainEqual({
      type: "tool_use",
      tool: "send_message",
      summary: "send_message",
    });
  });

  it("loads the previous session instead of starting another", async () => {
    const { result } = await run(
      [
        { input: { method: "initialize" } },
        rpc(1, { result: { protocolVersion: 1 } }),
        {
          input: {
            method: "session/load",
            params: { sessionId: "saved" },
          },
        },
        rpc(2, { result: {} }),
        prompt,
        rpc(3, { result: { stopReason: "end_turn" } }),
      ],
      { previousSession: { id: "saved" } }
    );
    expect(result.nextSession).toEqual({ id: "saved" });
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
    expect(result).toMatchObject({
      stopReason: "failed",
      error: "고른 모델을 쓸 수 없어 실행하지 않았습니다.",
      nextSession: null,
    });
  });
});

describe("Kiro readiness and models", () => {
  it("reads whoami and the model list without calling a model", async () => {
    const root = await folders.make("kiro-probe-");
    const program = path.join(root, "kiro.mjs");
    await writeFile(
      program,
      [
        "const args = process.argv.slice(2);",
        "if (args.includes('whoami')) {",
        "  if (args.includes('signed-out')) {",
        "    console.error('not logged in');",
        "    process.exit(1);",
        "  }",
        "  console.log('Logged in with IAM Identity Center');",
        "  process.exit(0);",
        "}",
        "if (args.includes('--list-models')) {",
        "  console.log(JSON.stringify({ models: [{ model_id: 'auto', model_name: 'auto' }, { model_id: 'claude-haiku-5.5', model_name: 'Haiku' }] }));",
        "  process.exit(0);",
        "}",
        "process.exit(9);",
        "",
      ].join("\n")
    );
    const provider = createKiroProvider({
      dataDir: root,
      command: [process.execPath, program],
    });
    const signal = new AbortController().signal;
    await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });
    await expect(provider.listModels?.(signal)).resolves.toEqual([
      { id: "auto", label: "auto" },
      { id: "claude-haiku-5.5", label: "Haiku" },
    ]);
    const signedOut = createKiroProvider({
      dataDir: root,
      id: "kiro-out",
      command: [process.execPath, program, "signed-out"],
    });
    await expect(signedOut.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "not_ready",
      reason: "product_login_missing",
    });
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
