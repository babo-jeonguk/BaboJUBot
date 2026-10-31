import {
  conversationMessageListSchema,
  conversationPageSchema,
  eventListSchema,
  organizationDetailSchema,
  taskDetailSchema,
  taskListSchema,
  type RunRequest,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import {
  createScriptedRuntime,
  defaultScriptSelector,
  leadReplyScript,
  type FakeProviderSettings,
  type Script,
  type ScriptSelector,
  type ScriptState,
  type ToolCallRecord,
} from "@babojubot/runtime";
import { expect } from "vitest";
import type { TestServer } from "./support.ts";

/**
 * 처음 연 대화 화면이 보는 메시지: 대화에 놓인 메시지의 가장 최근 쪽(받은 순서) 뒤에 줄 세운 메시지 전부.
 * `conversationId`를 비우면 기본 대화다.
 */
export async function chatMessages(
  server: TestServer,
  orgId: string,
  conversationId?: string
) {
  const base = conversationId
    ? `/api/organizations/${orgId}/conversations/${conversationId}`
    : `/api/organizations/${orgId}`;
  const page = await server.request("GET", `${base}/messages`);
  expect(page.status).toBe(200);
  const queued = await server.request("GET", `${base}/queued-messages`);
  expect(queued.status).toBe(200);
  return [
    ...conversationPageSchema.parse(page.body).messages,
    ...conversationMessageListSchema.parse(queued.body),
  ];
}

// 가짜 프로바이더 시나리오로 조직을 진행시키는 API 테스트 helper. 실제 HTTP·조직 도구 경로만 쓴다.

/** 조직 생성 깨우기만 받은 실행 시도인가. 새 조직의 Lead가 처음 받는 실행 시도다. */
export const onlyCreationWake = (request: RunRequest) =>
  request.wakeReasons.every((r) => r.kind === "organization_created");

/**
 * 조직 생성 깨우기만 받은 실행 시도는 맥락만 읽고 끝내고, 나머지 실행 시도는 `inner`에 넘기는 프로바이더.
 * 생성으로 깨어난 Lead의 초기 연구 승인 요청 없이 그 뒤의 흐름만 보는 검사가 쓴다.
 */
export function quietCreation(
  inner: RuntimeAdapter = createScriptedRuntime()
): RuntimeAdapter {
  const quiet = createScriptedRuntime({ select: () => idle });
  return {
    ...inner,
    execute: (request, control) =>
      (onlyCreationWake(request) ? quiet : inner).execute(request, control),
  };
}

/**
 * 에이전트마다 쌓아 둔 시나리오를 앞에서부터 하나씩 쓰고, 없으면 가짜 프로바이더의 기본 시나리오를 쓰는 프로바이더.
 * 쌓아 둔 항목이 함수면 받은 요청으로 시나리오를 정한다. 받은 요청과 시나리오 상태를 실행 시도 순서대로 기록한다.
 * 조직 생성 깨우기만 받은 실행 시도는 쌓아 둔 시나리오를 쓰지 않고 `created`(기본은 가짜 프로바이더의 기본 시나리오:
 * 초기 연구 승인 요청)를 쓰며 `of`에서 빠진다. 조직을 만든 응답보다 그 실행 시도가 먼저 시작해도 쌓은 순서가 어긋나지 않는다.
 */
export function scriptedAgents({
  created = (request) => defaultScriptSelector(request)!,
}: { created?: Script | ScriptSelector } = {}) {
  const runs: { request: RunRequest; state: ScriptState }[] = [];
  const queued = new Map<string, (Script | ScriptSelector)[]>();
  const select: ScriptSelector = (request) => {
    const next = onlyCreationWake(request)
      ? created
      : queued.get(request.identity.agentId)?.shift();
    const script =
      (typeof next === "function" ? next(request) : next) ??
      defaultScriptSelector(request)!;
    return {
      ...script,
      summary: (state) => {
        runs.push({ request, state });
        return script.summary?.(state) ?? "끝";
      },
    };
  };
  const runtime = createScriptedRuntime({ select });
  return {
    runtime,
    /** 같은 시나리오 묶음을 쓰되 가짜 프로바이더 설정을 바꾼 adapter. 연결마다 설정이 다른 검사가 쓴다. */
    runtimeWith: (settings: FakeProviderSettings) =>
      createScriptedRuntime({ select, settings }),
    queue(agentId: string, ...scripts: (Script | ScriptSelector)[]) {
      queued.set(agentId, [...(queued.get(agentId) ?? []), ...scripts]);
    },
    /** 이 에이전트의 실행 시도들. 조직 생성 깨우기만 받은 실행 시도는 뺀다. */
    of: (agentId: string) =>
      runs.filter(
        (r) =>
          r.request.identity.agentId === agentId && !onlyCreationWake(r.request)
      ),
    /** 이 에이전트가 조직 생성 깨우기만 받은 실행 시도. */
    createdOf: (agentId: string) =>
      runs.filter(
        (r) =>
          r.request.identity.agentId === agentId && onlyCreationWake(r.request)
      ),
  };
}

/** 테스트 조직의 기본 연구 목표와 완료 기준. */
export const goal = {
  goal: "음성 인식 오류율을 절반으로 줄인다",
  completionCriteria: "공개 평가셋 WER 10% 이하",
};
/** 연구원 두 명과 기본 연구 흐름 템플릿의 초기 연구 승인 요청. 조직에 완료 기준이 있을 때의 요청이다. */
export const initialRequest = {
  plan: "# 계획",
  environment: "# 연구 환경",
  team: [{ role: "researcher", count: 2 }],
  template: "basic-research",
};
export const proposeScript: Script = {
  steps: [
    {
      do: "call",
      tool: "request_initial_approval",
      input: () => initialRequest,
    },
  ],
};
/** 실행할 조직 도구 호출만 나열한 시나리오. 거부도 결과로 남긴다. */
export const calls = (
  ...steps: {
    tool: Extract<Script["steps"][number], { do: "call" }>["tool"];
    input?: Record<string, unknown>;
  }[]
): Script => ({
  steps: steps.map((s) => ({
    do: "call",
    tool: s.tool,
    input: s.input === undefined ? undefined : () => s.input!,
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
  /**
   * 사용자가 목표·완료 기준을 적어 만든 조직. 완료 기준을 `null`로 주면 비워 둔다.
   * 생성으로 깨어난 Lead의 실행 시도가 끝날 때까지 기다리므로, 이어지는 깨우기는 그 다음 실행 시도가 받는다.
   */
  const create = async (
    name: string,
    {
      completionCriteria = goal.completionCriteria,
    }: { completionCriteria?: string | null } = {}
  ) => {
    const res = await t().request("POST", "/api/organizations", {
      name,
      goal: goal.goal,
      ...(completionCriteria === null ? {} : { completionCriteria }),
    });
    expect(res.status).toBe(201);
    await t().drain();
    return organizationDetailSchema.parse(res.body);
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
  /**
   * 초기 연구 승인을 받아 `연구 진행`에 들어선 조직. 생성으로 깨어난 Lead가 초기 연구 승인을 요청하고,
   * 승인 결정에는 Lead가 답장만 하며 작업은 아직 없다.
   */
  async function researching(
    agents: ReturnType<typeof scriptedAgents>,
    name: string
  ) {
    const created = await create(name);
    const lead = created.agents.find((a) => a.role === "lead")!;
    agents.queue(lead.id, leadReplyScript);
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

  return { get, create, say, tasksOf, taskDetail, eventsOf, researching };
}
