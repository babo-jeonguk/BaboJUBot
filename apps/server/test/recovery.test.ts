import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import {
  approvalSummaryListSchema,
  conversationMessageListSchema,
  eventListSchema,
  organizationDetailSchema,
  runDetailSchema,
  runSummaryListSchema,
} from "@babojubot/contracts";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import {
  createScriptedRuntime,
  defaultScriptSelector,
  leadReplyScript,
} from "@babojubot/runtime";
import { createGate, holdAfter, writes } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.ts";
import { calls, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 서버 재시작 복구. 실행 중 서버가 멈추면 그 실행 시도는 `server_restart`로 끝나고, 받은 깨우기는 다시 처리되어 새 실행 시도가 생긴다.

let database: TestDatabase | undefined;
let server: RunningServer | undefined;
let t: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await database?.close();
  database = undefined;
  await t?.close();
  t = undefined;
});

const api = (base: () => string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base() + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    async createOrganization(name: string) {
      const org = organizationDetailSchema.parse(
        (await call("POST", "/api/organizations", { name })).body
      );
      return { id: org.id, lead: org.agents.find((a) => a.role === "lead")! };
    },
    organization: async (orgId: string) =>
      organizationDetailSchema.parse(
        (await call("GET", `/api/organizations/${orgId}`)).body
      ),
    async say(orgId: string, body: string) {
      expect(
        (await call("POST", `/api/organizations/${orgId}/messages`, { body }))
          .status
      ).toBe(201);
    },
    runs: async (orgId: string) =>
      runSummaryListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/runs`)).body
      ),
    run: async (orgId: string, runId: string) =>
      runDetailSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/runs/${runId}`)).body
      ),
    conversation: async (orgId: string) =>
      conversationMessageListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/messages`)).body
      ),
    events: async (orgId: string) =>
      eventListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/events`)).body
      ),
  };
};
type Api = ReturnType<typeof api>;

describe("server restart recovery", () => {
  it("ends a run the server stopped during as a server restart and hands its wakes to a new run after the restart", async () => {
    database = await createTestDatabase();
    const gate = createGate();
    server = await startServer({
      db: database.db,
      port: 0,
      runtime: createScriptedRuntime({
        select: () => ({
          ...leadReplyScript,
          steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
        }),
      }),
    });
    const http = api(() => server!.url);
    const org = await http.createOrganization("재시작 조직");
    await http.say(org.id, "재시작 뒤에도 처리해 줘");
    await gate.reached;
    const [interrupted] = await http.runs(org.id);

    await server.close();
    server = await startServer({ db: database.db, port: 0 });
    await server.drain();

    const [next, old] = await http.runs(org.id);
    expect(old).toMatchObject({
      id: interrupted!.id,
      status: "server_restart",
      wakeCount: 1,
    });
    expect(next).toMatchObject({ status: "completed", wakeCount: 1 });
    const [before, after] = await Promise.all([
      http.run(org.id, old!.id),
      http.run(org.id, next!.id),
    ]);
    expect(after.wakeReasons).toEqual(before.wakeReasons);
    expect(
      (await http.conversation(org.id)).map((m) => [
        m.author,
        m.deliveredToRunId,
      ])
    ).toEqual([
      ["owner", next!.id],
      ["agent", null],
    ]);
  });

  it("recovers after the server process is killed mid-run without repeating the reply it already sent", async () => {
    const { http, org, old } = await crashAndRestart(
      "send_message",
      "답장하고 멈춰",
      async (http, orgId) => (await http.conversation(orgId)).length === 2
    );
    expect(old.error).toContain("서버가 멈춰");
    // 새 실행 시도는 같은 깨우기를 받아 같은 답장을 보내지만, 같은 호출 키라 이미 남긴 답장을 돌려받는다.
    const conversation = await http.conversation(org.id);
    expect(conversation.map((m) => m.author)).toEqual(["owner", "agent"]);
    expect(conversation[1]!.sentByRunId).toBe(old.id);
    // 돌려받은 호출은 기록·Event를 새로 남기지 않는다.
    const replies = (await http.events(org.id)).filter(
      (e) =>
        e.type === "run.activity" &&
        e.payload.activity.source === "control_plane" &&
        e.payload.activity.activity.type === "org_tool" &&
        e.payload.activity.activity.tool === "send_message"
    );
    expect(replies.map((e) => e.payload)).toEqual([
      expect.objectContaining({ runId: old.id }),
    ]);
    expect(
      (await http.events(org.id)).filter((e) => e.type === "message.created")
    ).toHaveLength(2);
  });

  // 단계를 바꾸는 쓰기 뒤에 죽으면 새 실행 시도는 바뀐 단계에서 시작한다. 그래도 초기 연구 승인 흐름의 남은 단계를 이어 간다.
  it.each([
    ["record_goal", "planning"],
    ["request_initial_approval", "awaiting_approval"],
    ["send_message", "awaiting_approval"],
  ] as const)(
    "continues the initial research approval flow after the server is killed right after %s",
    async (stopAfter, stageAtCrash) => {
      const { http, org, old, next } = await crashAndRestart(
        stopAfter,
        "목표: 음성 인식 오류율을 절반으로 줄인다\n완료 기준: 공개 평가셋 WER 10% 이하",
        async (http, orgId) =>
          (await http.organization(orgId)).stage === stageAtCrash &&
          (stopAfter !== "send_message" ||
            (await http.conversation(orgId)).length === 2)
      );
      const detail = await http.organization(org.id);
      expect(detail).toMatchObject({
        stage: "awaiting_approval",
        goal: "음성 인식 오류율을 절반으로 줄인다",
      });
      const approvals = approvalSummaryListSchema.parse(
        (await http.call("GET", `/api/organizations/${org.id}/approvals`)).body
      );
      expect(approvals.map((a) => [a.kind, a.status])).toEqual([
        ["initial_research", "pending"],
      ]);
      const conversation = await http.conversation(org.id);
      expect(conversation.map((m) => m.author)).toEqual(["owner", "agent"]);
      expect(conversation[1]!.body).toContain("초기 연구 승인을 요청했습니다");
      expect(conversation[1]!.sentByRunId).toBe(
        stopAfter === "send_message" ? old.id : next.id
      );
      // 목표 기록·승인 요청·답장은 한 번씩만 남고, 새 실행 시도는 끝난 단계의 도구를 부르다 거부되지 않는다.
      const types = (await http.events(org.id)).map((e) => e.type);
      for (const type of [
        "organization.goal_recorded",
        "approval.requested",
      ] as const)
        expect(types.filter((t) => t === type)).toHaveLength(1);
      expect(types).not.toContain("tool.refused");
    }
  );
});

/**
 * 자식 서버 프로세스에서 Lead에게 `say`를 보내고, `stopAfter` 쓰기가 commit된 것을 `committed`로 확인한 뒤 SIGKILL한다.
 * 같은 DB로 기본 가짜 실행기 서버를 다시 띄워 재처리가 끝날 때까지 기다린다.
 */
async function crashAndRestart(
  stopAfter: string,
  say: string,
  committed: (http: Api, orgId: string) => Promise<boolean>
) {
  database = await createTestDatabase();
  const child = spawn(
    process.execPath,
    [
      path.join(import.meta.dirname, "fixtures/crash-server.ts"),
      database.url,
      stopAfter,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  let orgId: string;
  try {
    const [line] = (await once(child.stdout!, "data")) as [Buffer];
    const crashed = JSON.parse(String(line)) as { url: string };
    const before = api(() => crashed.url);
    const org = await before.createOrganization("crash 조직");
    orgId = org.id;
    await before.say(org.id, say);
    for (let i = 0; !(await committed(before, org.id)); i++) {
      if (i > 200) throw new Error(`${stopAfter} never committed`);
      await new Promise((r) => setTimeout(r, 25));
    }
    child.kill("SIGKILL");
    await once(child, "exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  server = await startServer({ db: database.db, port: 0 });
  await server.drain();
  const http = api(() => server!.url);
  const [next, old] = await http.runs(orgId);
  expect(old).toMatchObject({ status: "server_restart", wakeCount: 1 });
  expect(next).toMatchObject({ status: "completed", wakeCount: 1 });
  return { http, org: { id: orgId }, next: next!, old: old! };
}

// 같은 원인의 인접 흐름: 반려 뒤 재요청과 결과 제출도 단계를 바꾸는 쓰기 뒤에 서버가 멈추면 남은 단계부터 이어 간다.
describe("demo Lead flows across a restart right after a stage-changing write", () => {
  /**
   * Lead의 다음 실행 시도를 `stopAfter` 쓰기 뒤에 멈추고 `trigger`로 깨운 뒤, 서버를 정상 종료하고 같은 DB로 다시 띄워
   * 재처리를 끝낸다. 다시 띄운 서버의 API를 돌려준다.
   */
  async function restartAfter(
    agents: ReturnType<typeof scriptedAgents>,
    leadId: string,
    stopAfter: Parameters<typeof writes>[0],
    trigger: () => Promise<void>
  ) {
    const gate = createGate();
    agents.queue(leadId, (request) =>
      holdAfter(defaultScriptSelector(request)!, writes(stopAfter), gate.wait)
    );
    await trigger();
    await gate.reached;
    await t!.stopServer();
    server = await startServer({ db: t!.db, port: 0, runtime: agents.runtime });
    await server.drain();
    return api(() => server!.url);
  }
  const replies = async (http: Api, orgId: string) =>
    (await http.conversation(orgId))
      .filter((m) => m.author === "agent")
      .map((m) => m.body);

  it("resubmits a rejected initial research request once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const before = api(() => t!.baseUrl);
    const org = await before.createOrganization("재요청 조직");
    await before.say(
      org.id,
      "목표: 음성 인식 오류율을 절반으로 줄인다\n완료 기준: 공개 평가셋 WER 10% 이하"
    );
    await t.drain();
    const [first] = approvalSummaryListSchema.parse(
      (await before.call("GET", `/api/organizations/${org.id}/approvals`)).body
    );

    const http = await restartAfter(
      agents,
      org.lead.id,
      "request_initial_approval",
      async () => {
        const res = await before.call(
          "POST",
          `/api/organizations/${org.id}/approvals/${first!.id}/decision`,
          { decision: "reject", note: "데이터셋을 정해 주세요" }
        );
        expect(res.status).toBe(200);
      }
    );
    const [next, old] = await http.runs(org.id);
    expect([old!.status, next!.status]).toEqual([
      "server_restart",
      "completed",
    ]);
    expect((await http.organization(org.id)).stage).toBe("awaiting_approval");
    const approvals = approvalSummaryListSchema.parse(
      (await http.call("GET", `/api/organizations/${org.id}/approvals`)).body
    );
    expect(approvals.map((a) => a.status).sort()).toEqual([
      "pending",
      "rejected",
    ]);
    const answers = await replies(http, org.id);
    expect(answers).toHaveLength(2);
    expect(answers[1]).toContain("사유를 반영해 계획을 다시 제출했습니다");
    expect((await http.events(org.id)).map((e) => e.type)).not.toContain(
      "tool.refused"
    );
  });

  it("finishes a result submission once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const before = api(() => t!.baseUrl);
    const org = await serverHelpers(() => t!).researching(agents, "제출 조직");
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "오류 유형 분류", assigneeAgentId: org.workers[0]!.id },
      })
    );
    await before.say(org.id, "작업을 맡겨 주세요");
    await t.drain();

    const http = await restartAfter(agents, org.lead.id, "submit_result", () =>
      before.say(org.id, "결과 제출 부탁해요")
    );
    const [next, old] = await http.runs(org.id);
    expect([old!.status, next!.status]).toEqual([
      "server_restart",
      "completed",
    ]);
    expect((await http.organization(org.id)).stage).toBe("result_review");
    const submissions = (
      await http.call("GET", `/api/organizations/${org.id}/results`)
    ).body as unknown[];
    expect(submissions).toHaveLength(1);
    expect((await replies(http, org.id)).at(-1)).toContain(
      "근거 산출물 1개와 함께 제출했습니다"
    );
    expect((await http.events(org.id)).map((e) => e.type)).not.toContain(
      "tool.refused"
    );
  });
});
