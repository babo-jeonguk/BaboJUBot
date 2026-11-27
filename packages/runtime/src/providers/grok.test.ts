import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRequest } from "@babojubot/contracts";
import { createGrokProvider as unownedGrokProvider } from "./grok.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// `grok agent --no-leader stdio` 대화를 재생한다. 프레임 순서는 Grok Build 1.0.92 ACP의 initialize, session/new, session/prompt다.
const folders = testFolders();
const createGrokProvider = folders.owning(unownedGrokProvider);
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
  const root = await folders.make("grok-acp-");
  const fixture = path.join(root, "fixture.json");
  await writeFile(
    fixture,
    JSON.stringify({
      argv: { agent: true, "--no-leader": true, stdio: true },
      steps,
    })
  );
  const activity: unknown[] = [];
  const result = await createGrokProvider({
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

describe("Grok Build ACP", () => {
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
            params: { configId: "model", value: "grok-4.5" },
          },
        },
        rpc(3, { error: { message: "model unavailable" } }),
      ],
      { model: "grok-4.5" }
    );
    expect(result).toMatchObject({
      stopReason: "failed",
      error: "고른 모델을 쓸 수 없어 실행하지 않았습니다.",
      nextSession: null,
    });
  });
});

describe("Grok readiness and models", () => {
  it("reads grok models without calling a model", async () => {
    const root = await folders.make("grok-probe-");
    const program = path.join(root, "grok.mjs");
    await writeFile(
      program,
      [
        "const args = process.argv.slice(2);",
        "if (args.includes('models')) {",
        "  if (args.includes('signed-out')) {",
        "    console.error('Not signed in');",
        "    process.exit(1);",
        "  }",
        "  console.log('You are logged in with grok.com.');",
        "  console.log('  * grok-4.7 (default)');",
        "  console.log('  - grok-4.5');",
        "  process.exit(0);",
        "}",
        "process.exit(9);",
        "",
      ].join("\n")
    );
    const provider = createGrokProvider({
      dataDir: root,
      command: [process.execPath, program],
    });
    const signal = new AbortController().signal;
    await expect(provider.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "ready",
      reason: null,
    });
    await expect(provider.listModels?.(signal)).resolves.toEqual([
      { id: "grok-4.7", label: "grok-4.7" },
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
    const signedOut = createGrokProvider({
      dataDir: root,
      id: "grok-out",
      command: [process.execPath, program, "signed-out"],
    });
    await expect(signedOut.adapter.checkReadiness(signal)).resolves.toEqual({
      status: "not_ready",
      reason: "product_login_missing",
    });
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
