import {
  eventListSchema,
  organizationDetailSchema,
  taskDetailSchema,
  taskListSchema,
  type RunRequest,
} from "@babojubot/contracts";
import {
  createScriptedRuntime,
  defaultScriptSelector,
  leadReplyScript,
  type Script,
  type ScriptState,
  type ToolCallRecord,
} from "@babojubot/runtime";
import { expect } from "vitest";
import type { TestServer } from "./support.ts";

// 가짜 실행기 시나리오로 조직을 진행시키는 API 테스트 helper. 실제 HTTP·조직 도구 경로만 쓴다.

/**
 * 에이전트마다 쌓아 둔 시나리오를 앞에서부터 하나씩 쓰고, 없으면 가짜 실행기의 기본 시나리오를 쓰는 실행기.
 * 받은 요청과 시나리오 상태를 실행 시도 순서대로 기록한다.
 */
export function scriptedAgents() {
  const runs: { request: RunRequest; state: ScriptState }[] = [];
  const queued = new Map<string, Script[]>();
  const runtime = createScriptedRuntime({
    select: (request) => {
      const script =
        queued.get(request.identity.agentId)?.shift() ??
        defaultScriptSelector(request)!;
      return {
        ...script,
        summary: (state) => {
          runs.push({ request, state });
          return script.summary?.(state) ?? "끝";
        },
      };
    },
  });
  return {
    runtime,
    queue(agentId: string, ...scripts: Script[]) {
      queued.set(agentId, [...(queued.get(agentId) ?? []), ...scripts]);
    },
    /** 이 에이전트의 실행 시도들. */
    of: (agentId: string) =>
      runs.filter((r) => r.request.identity.agentId === agentId),
  };
}

const goal = {
  goal: "음성 인식 오류율을 절반으로 줄인다",
  completionCriteria: "공개 평가셋 WER 10% 이하",
};
export const proposeScript: Script = {
  steps: [
    { do: "call", tool: "record_goal", input: () => goal },
    {
      do: "call",
      tool: "request_initial_approval",
      input: () => ({
        plan: "# 계획",
        environment: "# 연구 환경",
        team: [{ role: "researcher", count: 2 }],
        template: "basic-research",
      }),
    },
  ],
};
/** 실행할 조직 도구 호출만 나열한 시나리오. 거부도 결과로 남긴다. */
export const calls = (
  ...steps: {
    tool: Extract<Script["steps"][number], { do: "call" }>["tool"];
    input?: unknown;
    params?: Record<string, string>;
  }[]
): Script => ({
  steps: steps.map((s) => ({
    do: "call",
    tool: s.tool,
    input: s.input === undefined ? undefined : () => s.input,
    params: s.params && (() => s.params!),
    allowRefusal: true,
  })),
});
/** 아무 도구도 부르지 않고 읽기만 하는 시나리오. */
export const idle: Script = { steps: [{ do: "read_context" }] };

export const reasons = (runs: { request: Pick<RunRequest, "wakeReasons"> }[]) =>
  runs.flatMap((r) => r.request.wakeReasons);
export const ok = (record: ToolCallRecord | undefined) => {
  if (!record?.ok)
    throw new Error(`tool call failed: ${JSON.stringify(record)}`);
  return record.output as { id: string };
};

/** 지금 서버에 묶은 조회·메시지 helper. */
export function serverHelpers(t: () => TestServer) {
  const get = async (path: string) => {
    const res = await t().request("GET", path);
    expect(res.status, path).toBe(200);
    return res.body;
  };
  const say = async (orgId: string, body: string) => {
    const res = await t().request(
      "POST",
      `/api/organizations/${orgId}/messages`,
      { body }
    );
    expect(res.status).toBe(201);
  };
  const tasksOf = async (orgId: string) =>
    taskListSchema.parse(await get(`/api/organizations/${orgId}/tasks`));
  const taskDetail = async (orgId: string, taskId: string) =>
    taskDetailSchema.parse(
      await get(`/api/organizations/${orgId}/tasks/${taskId}`)
    );
  const eventsOf = async (orgId: string) =>
    eventListSchema.parse(await get(`/api/organizations/${orgId}/events`));
  /** 초기 연구 승인을 받아 `연구 진행`에 들어선 조직. 승인 결정에는 Lead가 답장만 하고 작업은 아직 없다. */
  async function researching(
    agents: ReturnType<typeof scriptedAgents>,
    name: string
  ) {
    const res = await t().request("POST", "/api/organizations", { name });
    const created = organizationDetailSchema.parse(res.body);
    const lead = created.agents.find((a) => a.role === "lead")!;
    agents.queue(lead.id, proposeScript, leadReplyScript);
    await say(created.id, "목표를 정했어요");
    await t().drain();
    const [approval] = await get(`/api/organizations/${created.id}/approvals`);
    const decided = await t().request(
      "POST",
      `/api/organizations/${created.id}/approvals/${approval.id}/decision`,
      { decision: "approve" }
    );
    expect(decided.status).toBe(200);
    await t().drain();
    const org = organizationDetailSchema.parse(
      await get(`/api/organizations/${created.id}`)
    );
    expect(org.stage).toBe("researching");
    const workers = org.agents.filter((a) => a.role === "worker");
    return { id: org.id, lead, workers };
  }

  return { get, say, tasksOf, taskDetail, eventsOf, researching };
}
