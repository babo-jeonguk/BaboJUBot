import { afterEach, expect, it } from "vitest";
import { createGate } from "@babojubot/runtime/testing";
import { scriptedAgents, serverHelpers, calls } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";
let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
});
it("authenticates MCP requests and exposes the same catalog and stage refusal as HTTP", async () => {
  const gate = createGate();
  let token = "";
  const agents = scriptedAgents({
    created: (request) => {
      token = request.access.token;
      return { steps: [{ do: "hold", until: gate.wait }] };
    },
  });
  t = await startTestServer({ runtime: agents.runtime });
  await t.request("POST", "/api/organizations", {
    name: "MCP 조직",
    goal: "검증",
  });
  await gate.reached;
  const rpc = (method: string, params = {}, auth = token) =>
    t!.request(
      "POST",
      "/api/tools/mcp",
      { jsonrpc: "2.0", id: 1, method, params },
      { authorization: `Bearer ${auth}` }
    );
  expect((await rpc("tools/list", {}, "bad")).status).toBe(401);
  const list = await rpc("tools/list");
  expect(list.status).toBe(200);
  expect(
    list.body.result.tools.some(
      (tool: { name: string }) => tool.name === "get_run_context"
    )
  ).toBe(true);
  expect(
    list.body.result.tools.some(
      (tool: { name: string }) => tool.name === "record_artifact"
    )
  ).toBe(false);
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(init.body.result.protocolVersion).toBe("2025-11-25");
  const foreignOrigin = await t.request(
    "POST",
    "/api/tools/mcp",
    { jsonrpc: "2.0", id: 9, method: "ping" },
    { authorization: `Bearer ${token}`, origin: "https://outside.example" }
  );
  expect(foreignOrigin.status).toBe(403);
  const result = await rpc("tools/call", {
    name: "get_run_context",
    arguments: {},
  });
  expect(result.body.result.isError).toBe(false);
  const denied = await rpc("tools/call", {
    name: "record_artifact",
    arguments: {},
  });
  expect(denied.body.result.structuredContent).toEqual({
    error: { code: "stage_closed" },
  });
  expect((await t.tool(token, "POST", "/artifacts", {})).body).toEqual(
    denied.body.result.structuredContent
  );
  gate.open();
  await t.drain();
  expect((await rpc("tools/list")).status).toBe(401);
});

it("preserves worker Role refusal, organization isolation, policy decisions and MCP-to-HTTP receipts", async () => {
  const agents = scriptedAgents();
  t = await startTestServer({ runtime: agents.runtime });
  const { researching, say, tasksOf } = serverHelpers(() => t!);
  const org = await researching(agents, "MCP 연구");
  const other = await researching(agents, "다른 조직");
  const workerGate = createGate();
  let workerToken = "";
  agents.queue(org.workers[0]!.id, (request) => {
    workerToken = request.access.token;
    return { steps: [{ do: "hold", until: workerGate.wait }] };
  });
  agents.queue(
    org.lead.id,
    calls({
      tool: "create_task",
      input: { title: "권한 검증", assigneeAgentId: org.workers[0]!.id },
    })
  );
  await say(org.id, "분담");
  await workerGate.reached;
  const task = (await tasksOf(org.id))[0]!;
  const rpc = (token: string, name: string, args: unknown, key?: string) =>
    t!.request(
      "POST",
      "/api/tools/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          ...(key ? { _meta: { "idempotency-key": key } } : {}),
        },
      },
      { authorization: `Bearer ${token}` }
    );
  const forbidden = await rpc(workerToken, "add_worker", {
    role: "researcher",
  });
  expect(forbidden.body.result.structuredContent).toEqual({
    error: { code: "forbidden" },
  });
  expect(
    (await t.tool(workerToken, "POST", "/workers", { role: "researcher" })).body
  ).toEqual(forbidden.body.result.structuredContent);
  const recorded = await rpc(
    workerToken,
    "record_artifact",
    { taskId: task.id, title: "근거", format: "text", content: "보존" },
    "mcp-first"
  );
  const replay = await t.request(
    "POST",
    "/api/tools/artifacts",
    { taskId: task.id, title: "근거", format: "text", content: "보존" },
    { authorization: `Bearer ${workerToken}`, "idempotency-key": "mcp-first" }
  );
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(recorded.body.result.structuredContent);
  workerGate.open();
  await t.drain();
  const leadGate = createGate();
  let leadToken = "";
  agents.queue(other.lead.id, (request) => {
    leadToken = request.access.token;
    return { steps: [{ do: "hold", until: leadGate.wait }] };
  });
  await say(other.id, "격리 검증");
  await leadGate.reached;
  const foreign = await rpc(leadToken, "get_artifact", {
    artifactId: replay.body.id,
  });
  expect(foreign.body.result.structuredContent).toEqual({
    error: { code: "not_found" },
  });
  expect(
    (await t.tool(leadToken, "GET", `/artifacts/${replay.body.id}`)).body
  ).toEqual(foreign.body.result.structuredContent);
  const policy = await t.request(
    "PUT",
    `/api/organizations/${other.id}/approval-policy`,
    { addWorker: true }
  );
  expect(policy.status).toBe(200);
  const pending = await rpc(
    leadToken,
    "add_worker",
    { role: "researcher" },
    "policy-one"
  );
  expect(pending.body.result.structuredContent.status).toBe("pending_approval");
  const same = await t.request(
    "POST",
    "/api/tools/workers",
    { role: "researcher" },
    { authorization: `Bearer ${leadToken}`, "idempotency-key": "policy-one" }
  );
  expect(same.status).toBe(202);
  expect(same.body).toEqual(pending.body.result.structuredContent);
  await t.request("PUT", `/api/organizations/${other.id}/approval-policy`, {
    addWorker: false,
  });
  expect(
    (await rpc(leadToken, "add_worker", { role: "researcher" })).body.result
      .structuredContent.status
  ).toBe("added");
  leadGate.open();
});

// #147: 연구 단계에서 처음 열리는 record_artifact의 경로 규칙이 실제 tools/list 응답에 모델 서비스가 받는 표기로 나간다.
it("lists record_artifact once research starts, with the NUL rule in the accepted \\x00 form", async () => {
  const agents = scriptedAgents();
  t = await startTestServer({ runtime: agents.runtime });
  const { researching, say } = serverHelpers(() => t!);
  const org = await researching(agents, "MCP schema");
  const gate = createGate();
  let token = "";
  agents.queue(org.lead.id, (request) => {
    token = request.access.token;
    return { steps: [{ do: "hold", until: gate.wait }] };
  });
  await say(org.id, "산출물 도구 확인");
  await gate.reached;
  const list = await t.request(
    "POST",
    "/api/tools/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { authorization: `Bearer ${token}` }
  );
  expect(list.status).toBe(200);
  const tool = list.body.result.tools.find(
    (tool: { name: string }) => tool.name === "record_artifact"
  );
  expect(tool.inputSchema.properties.path).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 4096,
    pattern: "^[^\\x00]*$",
  });
  // 응답 본문(JSON 문자열)에서도 거부된 `\0` 표기가 없다.
  expect(JSON.stringify(tool.inputSchema)).not.toContain(String.raw`[^\\0]`);
  gate.open();
  await t.drain();
});
