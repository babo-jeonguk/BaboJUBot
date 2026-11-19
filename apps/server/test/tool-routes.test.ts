import {
  isOrgToolRead,
  orgToolNames,
  orgTools,
  type OrgToolName,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, expect, it } from "vitest";
import { idle, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 조직 도구는 도구 목록(contracts `orgTools`)의 메서드·경로로 실제 서버의 `/api/tools`에서 받는다. 경로마다 그 도구를 부르고
// 응답을 그대로 돌려주며, 목록에 없는 메서드는 받지 않는다. 연구 진행 중인 조직의 Lead 실행 시도를 붙잡고 그 토큰으로 HTTP만 쓴다.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { say, researching, eventsOf } = serverHelpers(() => t!);

/** 계약 밖의 호출 키(200자 초과). 쓰기 도구는 이 키를 무엇보다 먼저 보고 효과 없이 거절한다. */
const badKey = "k".repeat(201);
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];

it("serves each organization tool at its method and path, and nothing else there", async () => {
  const agents = scriptedAgents();
  const runs = new Map<string, { runId: string; token: string }>();
  const runtime: RuntimeAdapter = {
    ...agents.runtime,
    execute(request, control) {
      runs.set(request.identity.agentId, {
        runId: request.identity.runId,
        token: request.access.token,
      });
      return agents.runtime.execute(request, control);
    },
  };
  t = await startTestServer({ runtime });
  const org = await researching(agents, "도구 경로 조직");
  const gate = createGate();
  agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
  await say(org.id, "도구를 살펴보세요");
  await gate.reached;
  const { runId, token } = runs.get(org.lead.id)!;
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    t!.request(method, `/api/tools${path}`, body, {
      authorization: `Bearer ${token}`,
      ...headers,
    });
  const created = async (path: string, body: object) => {
    const res = await call("POST", path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  // 읽기 도구가 찾을 것을 쓰기 도구로 만든다.
  const taskId = await created(orgTools.create_task.path, {
    title: "조사",
    assigneeAgentId: org.lead.id,
  });
  const nodeId = await created(orgTools.create_research_node.path, {
    kind: "problem",
    title: "문제",
    body: "",
  });
  const artifactId = await created(orgTools.record_artifact.path, {
    taskId,
    title: "메모",
    format: "text",
    content: "내용",
  });
  const messageId = await created(orgTools.send_message.path, {
    body: "살펴보는 중입니다",
  });
  const ids: Record<string, string> = {
    messageId,
    taskId,
    artifactId,
    nodeId,
  };
  const pathOf = (tool: OrgToolName) =>
    orgTools[tool].path.replace(/:(\w+)/g, (_, name: string) => ids[name]!);

  // 읽기: 그 도구의 응답 계약을 지키고, ID로 찾는 도구는 그 ID의 것을 돌려준다.
  const reads = orgToolNames.filter((tool) => isOrgToolRead(tool));
  for (const tool of reads) {
    const query = tool === "recall_memory" ? "?scope=organization" : "";
    const res = await call(orgTools[tool].method, pathOf(tool) + query);
    expect([tool, res.status]).toEqual([tool, 200]);
    const value = orgTools[tool].output.parse(res.body);
    const wanted = orgTools[tool].params.map((name) => ids[name]);
    if (wanted.length > 0) expect(value).toMatchObject({ id: wanted[0] });
  }
  // 쓰기: 계약 밖의 호출 키를 그 도구의 처리로 거절한다. 아무것도 남기지 않는다.
  const writes = orgToolNames.filter((tool) => !isOrgToolRead(tool));
  for (const tool of writes) {
    const res = await call(
      orgTools[tool].method,
      pathOf(tool),
      {},
      { "idempotency-key": badKey }
    );
    expect([tool, res.status, res.body.error?.code]).toEqual([
      tool,
      422,
      "invalid_input",
    ]);
  }
  // 경로마다 목록에 없는 메서드는 없는 경로와 같은 응답이다.
  const declared = new Map<string, string[]>();
  for (const tool of orgToolNames) {
    const path = pathOf(tool);
    declared.set(path, [...(declared.get(path) ?? []), orgTools[tool].method]);
  }
  for (const [path, served] of declared)
    for (const method of methods.filter((m) => !served.includes(m))) {
      const res = await call(method, path, method === "GET" ? undefined : {});
      expect([method, path, res.status, res.body]).toEqual([
        method,
        path,
        404,
        { error: { code: "not_found" } },
      ]);
    }

  agents.queue(org.lead.id, idle, idle);
  gate.open();
  await t.drain();
  // 붙잡은 실행 시도가 받은 호출마다 그 이름의 도구가 처리했다(공개 활동에 남은 도구 이름). 거절한 쓰기는 남지 않는다.
  const handled = (await eventsOf(org.id)).flatMap((event) =>
    event.type === "run.activity" &&
    event.payload.runId === runId &&
    event.payload.activity.source === "control_plane"
      ? [event.payload.activity.activity.tool]
      : []
  );
  expect(handled).toEqual([
    "create_task",
    "create_research_node",
    "record_artifact",
    "send_message",
    ...reads,
  ]);
});
