import {
  orgToolNames,
  orgTools,
  type OrgToolName,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import { insertLegacyOrganization } from "@babojubot/db/testing";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, expect, it } from "vitest";
import {
  goal,
  idle,
  initialRequest,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 조직 도구는 도구 목록(contracts `orgTools`)의 메서드·경로로 실제 서버의 `/api/tools`에서 받는다. 경로마다 그 도구가 처리해
// 성공 응답(그 도구의 output 계약)을 돌려주고, 목록에 없는 메서드는 받지 않는다. Lead 실행 시도 하나를 붙잡고 그 토큰으로
// HTTP만 쓴다. 조직은 목표 설정 → 초기 연구 승인 → 연구 진행 → 결과 검토로 나아가므로, 도구를 그 단계 순서로 부르고
// 뒤 도구는 앞 도구가 만든 작업·연구 노드·산출물을 쓴다.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, say, eventsOf } = serverHelpers(() => t!);

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
  // 목표를 받기 전에 만든 조직이라 Lead가 목표를 적는 단계(`목표 설정`)부터 시작한다.
  const org = await insertLegacyOrganization(t.db, "도구 경로 조직");
  const gate = createGate();
  agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
  await say(org.id, "목표를 정해 주세요");
  await gate.reached;
  const { runId, token } = runs.get(org.lead.id)!;

  const ids: Record<string, string> = {};
  const pathOf = (tool: OrgToolName) =>
    orgTools[tool].path.replace(/:(\w+)/g, (_, name: string) => {
      const id = ids[name];
      if (!id) throw new Error(`${tool}: no ${name} yet`);
      return id;
    });
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    t!.request(method, `/api/tools${path}`, body, {
      authorization: `Bearer ${token}`,
      ...headers,
    });
  const called: OrgToolName[] = [];
  /** 도구 하나를 그 경로로 부른다. 성공 상태와 그 도구의 output 계약을 지켜야 한다. */
  const call = async (
    tool: OrgToolName,
    input: Record<string, unknown> = {},
    query = ""
  ) => {
    const { method } = orgTools[tool];
    const res = await send(
      method,
      pathOf(tool) + query,
      method === "GET" ? undefined : input
    );
    expect(
      [tool, res.status >= 200 && res.status < 300],
      JSON.stringify(res.body)
    ).toEqual([tool, true]);
    called.push(tool);
    return orgTools[tool].output.parse(res.body) as { id?: string };
  };
  /** ID로 찾는 읽기 도구는 그 ID의 것을 돌려준다. */
  const read = async (tool: OrgToolName) => {
    const value = await call(tool);
    expect([tool, value.id]).toEqual([tool, ids[orgTools[tool].params[0]!]]);
  };

  // 목표 설정 → 초기 연구 승인 요청. 사용자가 승인하면 연구 진행이다.
  await call("record_goal", goal);
  await call("request_initial_approval", initialRequest);
  const [approval] = await get(`/api/organizations/${org.id}/approvals`);
  const decided = await t.request(
    "POST",
    `/api/organizations/${org.id}/approvals/${approval.id}/decision`,
    { decision: "approve" }
  );
  expect(decided.status).toBe(200);
  const detail = await get(`/api/organizations/${org.id}`);
  expect(detail.stage).toBe("researching");
  const worker = (detail.agents as { id: string; role: string }[]).find(
    (a) => a.role === "worker"
  )!;

  // 연구 진행: 대화·기억·팀.
  ids.messageId = (await call("send_message", { body: "시작합니다" })).id!;
  await call("write_memory", { scope: "organization", content: "기준선" });
  await call("add_worker", { role: "researcher" });
  await call("message_agent", { recipientAgentId: worker.id, body: "준비" });
  // 작업: 자기에게 맡겨 착수·의견·산출물을 남긴다.
  ids.taskId = (
    await call("create_task", { title: "조사", assigneeAgentId: org.lead.id })
  ).id!;
  await call("start_task");
  await call("comment_task", { body: "진행 중" });
  ids.artifactId = (
    await call("record_artifact", {
      taskId: ids.taskId,
      title: "메모",
      format: "text",
      content: "내용",
    })
  ).id!;
  // 연구 지도: 노드 셋, 부모 정하기·바꾸기, 고치기, 보조 연결, 작업 연결·바꾸기·끊기, 폐기·폐기 취소.
  const problem = (
    await call("create_research_node", { kind: "problem", title: "문제" })
  ).id!;
  const hypothesis = (
    await call("create_research_node", { kind: "hypothesis", title: "가설" })
  ).id!;
  const experiment = (
    await call("create_research_node", {
      kind: "experiment",
      title: "실험",
      parentNodeId: problem,
    })
  ).id!;
  ids.nodeId = hypothesis;
  await call("assign_research_node_parent", { parentNodeId: problem });
  ids.nodeId = experiment;
  await call("change_research_node_parent", { parentNodeId: hypothesis });
  await call("update_research_node", { title: "실험 다시" });
  await call("add_research_link", {
    sourceNodeId: experiment,
    targetNodeId: problem,
    kind: "supports",
  });
  await call("link_task_research_node", { researchNodeId: problem });
  await call("relink_task_research_node", { researchNodeId: hypothesis });
  await call("unlink_task_research_node");
  await call("discard_research_node");
  await call("restore_research_node");

  // 읽기: 위에서 만든 것을 찾는다.
  await call("get_run_context");
  await read("get_message");
  await call("get_harness_library");
  await call("list_providers");
  await call("list_tasks");
  await read("get_task");
  await read("get_artifact");
  await call("get_research_map");
  await read("get_research_node");
  await call("recall_memory", {}, "?scope=organization");

  // 작업을 마치고 결과를 낸다(결과 검토로 넘어간다).
  await call("complete_task", { summary: "끝" });
  await call("submit_result", {
    summary: "결과",
    artifactIds: [ids.artifactId],
  });
  // 모든 도구를 성공으로 불렀다(연구 노드는 셋을 만든다).
  expect([...new Set(called)].sort()).toEqual([...orgToolNames].sort());

  // 쓰기 도구는 계약 밖의 호출 키를 효과 없이 거절한다.
  for (const tool of ["send_message", "create_task"] as const) {
    const res = await send(
      "POST",
      orgTools[tool].path,
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
      const res = await send(method, path, method === "GET" ? undefined : {});
      expect([method, path, res.status, res.body]).toEqual([
        method,
        path,
        404,
        { error: { code: "not_found" } },
      ]);
    }

  agents.queue(org.lead.id, idle, idle, idle);
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
  expect(handled).toEqual(called);
});
