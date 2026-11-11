import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentDetailSchema,
  artifactSchema,
  eventListSchema,
  runDetailSchema,
  runSummaryListSchema,
  taskDetailSchema,
  taskListSchema,
  conversationPageSchema,
  type RecoveredIntent,
  type RunRequest,
  type WakeReason,
} from "@babojubot/contracts";
import {
  acceptIntent,
  controlAgent,
  findIntentByKey,
  type Database,
} from "@babojubot/db";
import { createGate } from "@babojubot/runtime/testing";
import {
  insertCompletedIntent,
  intentStatusOf,
  lockWaiters,
  setIntentRequest,
  setOrganizationStage,
  whileHoldingRun,
  setIntentSettleAttempts,
  setIntentSource,
} from "@babojubot/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "../src/index.ts";
import { Workspaces } from "../src/workspace.ts";
import { calls, idle, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// #150 실행 의도 복구. 모든 조직 쓰기 도구 호출은 효과보다 먼저 실행 의도(도구·입력·원본 자료)로 남고, 효과와 최초 결과는 함께 정산된다.
// 서버가 멈추면 다음 실행 시도가 모델을 부르기 전에 남은 의도를 정산하고 그 결과를 깨우기 사유로 받는다. 정산이 막히면 에이전트는
// 사용자가 복구 재시도를 고를 때까지 진행하지 않는다. 실제 모델은 없고, 서버 정지는 같은 프로세스의 정상 종료(`stopServer`)로 만든다.
// 중단 지점은 진행 중 실행 시도의 토큰으로 직접 부른 도구 호출(효과 commit 뒤)과, 같은 입력 표기로 수락만 한 의도(효과 commit 전)로 고정한다.

let t: TestServer | undefined;
let restarted: RunningServer | undefined;
let root = "";
afterEach(async () => {
  vi.restoreAllMocks();
  await restarted?.close();
  restarted = undefined;
  await t?.close();
  t = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

const http = (base: () => string) => {
  const request = async (
    method: string,
    route: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) => {
    const res = await fetch(base() + route, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const get = async (route: string) => (await request("GET", route)).body;
  return {
    request,
    /** 그 실행 시도의 토큰으로 조직 도구를 부른다. 키를 주면 같은 호출 키 header로 보낸다. */
    tool: (token: string, route: string, body: unknown, key?: string) =>
      request("POST", `/api/tools${route}`, body, {
        authorization: `Bearer ${token}`,
        ...(key ? { "idempotency-key": key } : {}),
      }),
    events: async (orgId: string) =>
      eventListSchema.parse(await get(`/api/organizations/${orgId}/events`)),
    runs: async (orgId: string, agentId: string) =>
      runSummaryListSchema.parse(
        await get(`/api/organizations/${orgId}/runs?agentId=${agentId}`)
      ),
    run: async (orgId: string, runId: string) =>
      runDetailSchema.parse(
        await get(`/api/organizations/${orgId}/runs/${runId}`)
      ),
    agent: async (orgId: string, agentId: string) =>
      agentDetailSchema.parse(
        await get(`/api/organizations/${orgId}/agents/${agentId}`)
      ),
    /** 이 시험이 보낸 답장(본문이 주어진 것)만. 조직을 준비하며 Lead가 남긴 답장은 뺀다. */
    agentReplies: async (orgId: string, ...bodies: string[]) =>
      conversationPageSchema
        .parse(await get(`/api/organizations/${orgId}/messages`))
        .messages.filter(
          (m) =>
            m.author === "agent" && (!bodies.length || bodies.includes(m.body))
        ),
    tasks: async (orgId: string) =>
      taskListSchema.parse(await get(`/api/organizations/${orgId}/tasks`)),
    say: async (orgId: string, body: string) =>
      expect(
        (
          await request("POST", `/api/organizations/${orgId}/messages`, {
            body,
          })
        ).status
      ).toBe(201),
  };
};

/** 실행 의도가 고정하는 입력 표기(경로 변수와 본문)와 그 digest. 도구 경로가 쓰는 것과 같다. */
const draft = (
  tool: "send_message" | "record_artifact" | "create_task",
  body: unknown,
  key: string | null,
  source: unknown = null
) => {
  const request = JSON.stringify({ params: {}, body });
  return {
    key,
    tool,
    request,
    digest: createHash("sha256").update(request).digest("hex"),
    source,
  };
};

const recoveries = (reasons: WakeReason[]) =>
  reasons.filter(
    (r): r is Extract<WakeReason, { kind: "intent_recovery" }> =>
      r.kind === "intent_recovery"
  );
const outcomes = (intents: RecoveredIntent[]) =>
  intents.map((i) => [i.tool, i.outcome.status]);

/**
 * 연구 진행 중인 조직과, Lead가 실행 시도 안에서 멈춘 상태. 멈춘 실행 시도의 요청(토큰 포함)을 돌려준다.
 * `restart`는 서버를 멈추고 같은 DB·폴더로 다시 띄운 뒤 대기 깨우기를 모두 처리한다.
 */
async function heldLead(name: string) {
  root = await mkdtemp(path.join(tmpdir(), "intent-recovery-"));
  const agents = scriptedAgents();
  t = await startTestServer({ runtime: agents.runtime, dataDir: root });
  const { researching, say } = serverHelpers(() => t!);
  const org = await researching(agents, name);
  agents.queue(
    org.lead.id,
    calls({
      tool: "create_task",
      input: { title: "근거 정리", assigneeAgentId: org.workers[0]!.id },
    })
  );
  agents.queue(org.workers[0]!.id, idle);
  await say(org.id, "작업 만들기");
  await t.drain();
  const gate = createGate();
  let held!: RunRequest;
  agents.queue(org.lead.id, (request) => {
    held = request;
    return { steps: [{ do: "hold", until: gate.wait }] };
  });
  await say(org.id, "멈출 실행");
  await gate.reached;
  const api = http(() => restarted?.url ?? t!.baseUrl);
  const task = (await api.tasks(org.id))[0]!;
  const restart = async (
    between?: () => Promise<void>,
    { drain = true }: { drain?: boolean } = {}
  ) => {
    if (restarted) await restarted.close();
    else await t!.stopServer();
    await between?.();
    restarted = await startServer({
      db: t!.db,
      port: 0,
      runtime: agents.runtime,
      dataDir: root,
    });
    if (drain) await restarted.drain();
  };
  return { agents, org, task, held, api, restart, db: t.db as Database };
}

describe("execution intent recovery across a server restart (#150)", () => {
  it("returns the first result of a write committed before the response was lost, both to the next run before the model and to a retransmission with a new token", async () => {
    const { agents, org, held, api, restart } =
      await heldLead("응답 유실 조직");
    const token = held.access.token;
    const first = await api.tool(
      token,
      "/messages",
      { body: "보낸 답장" },
      "k-c"
    );
    expect(first.status).toBe(201);
    const messagesBefore = (await api.events(org.id)).filter(
      (e) => e.type === "message.created" && e.payload.author === "agent"
    ).length;
    let next!: RunRequest;
    let nextToken = "";
    agents.queue(org.lead.id, (request) => {
      next = request;
      nextToken = request.access.token;
      return idle;
    });
    await restart();
    // 모델이 받은 첫 요청에 멈춘 실행 시도의 쓰기가 최초 결과와 함께 있다.
    const [recovery] = recoveries(next.wakeReasons);
    expect(recovery).toMatchObject({ interruptedRunId: held.identity.runId });
    expect(recovery!.intents).toEqual([
      {
        intentId: expect.any(String),
        tool: "send_message",
        request: { params: {}, body: { body: "보낸 답장" } },
        outcome: { status: "completed", result: first.body },
      },
    ]);
    // 다시 대기한 사용자 메시지도 함께 받는다.
    expect(next.wakeReasons.map((r) => r.kind).sort()).toEqual([
      "intent_recovery",
      "owner_message",
    ]);
    expect(
      (await api.agentReplies(org.id, "보낸 답장")).map((m) => m.body)
    ).toEqual(["보낸 답장"]);
    // 옛 토큰은 거부되고, 같은 의도를 새 실행 시도의 토큰으로 다시 보내면 최초 결과만 돌아온다(그 실행 시도는 끝났으므로 다시 멈춰 확인한다).
    expect(
      (await api.tool(token, "/messages", { body: "보낸 답장" }, "k-c")).status
    ).toBe(401);
    expect(nextToken).not.toBe(token);
    const gate = createGate();
    let third!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      third = request;
      return { steps: [{ do: "hold", until: gate.wait }] };
    });
    await api.say(org.id, "다시 확인");
    await gate.reached;
    const again = await api.tool(
      third.access.token,
      "/messages",
      { body: "보낸 답장" },
      "k-c"
    );
    expect(again).toEqual(first);
    gate.open();
    await restarted!.drain();
    expect(
      (await api.agentReplies(org.id, "보낸 답장")).map((m) => m.body)
    ).toEqual(["보낸 답장"]);
    // 돌려받은 호출은 메시지 Event를 새로 남기지 않았다.
    const agentMessages = (events: Awaited<ReturnType<typeof api.events>>) =>
      events.filter(
        (e) => e.type === "message.created" && e.payload.author === "agent"
      ).length;
    expect(agentMessages(await api.events(org.id))).toBe(messagesBefore);
  });

  it("performs an accepted write that had no effect yet exactly once before the model runs, even when the recovering run is interrupted again", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("효과 전 조직");
    const accepted = await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "복구로 보낼 답장" }, "k-b")
    );
    expect(accepted.kind).toBe("accepted");
    // 첫 복구 실행 시도는 정산 뒤 모델 안에서 멈추고, 서버가 다시 멈춘다.
    const gate = createGate();
    let second!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      second = request;
      return { steps: [{ do: "hold", until: gate.wait }] };
    });
    await restart(undefined, { drain: false });
    await gate.reached;
    expect(outcomes(recoveries(second.wakeReasons)[0]!.intents)).toEqual([
      ["send_message", "completed"],
    ]);
    expect(
      (await api.agentReplies(org.id, "복구로 보낼 답장")).map((m) => m.body)
    ).toEqual(["복구로 보낼 답장"]);
    let third!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      third = request;
      return idle;
    });
    await restart();
    // 다시 대기한 복구 깨우기를 다음 실행 시도가 한 번 받고, 효과는 여전히 하나다.
    const thirdRecoveries = recoveries(third.wakeReasons);
    expect(thirdRecoveries.map((r) => r.interruptedRunId)).toEqual([
      held.identity.runId,
    ]);
    expect(outcomes(thirdRecoveries[0]!.intents)).toEqual([
      ["send_message", "completed"],
    ]);
    expect(
      (await api.agentReplies(org.id, "복구로 보낼 답장")).map((m) => m.body)
    ).toEqual(["복구로 보낼 답장"]);
    const runs = await api.runs(org.id, org.lead.id);
    expect(runs.slice(0, 3).map((r) => r.status)).toEqual([
      "completed",
      "server_restart",
      "server_restart",
    ]);
  });

  it("registers the bytes fixed at acceptance even after the file changes or disappears, and blocks instead of reading a new file when the fixed source is gone", async () => {
    const { agents, org, task, held, api, restart, db } =
      await heldLead("파일 원본 조직");
    const workspaces = new Workspaces(root, db);
    const folder = held.workspace!.cwd;
    await writeFile(path.join(folder, "보고서.md"), "# 수락 때 원문");
    const input = { taskId: task.id, title: "보고서", path: "보고서.md" };
    const source = await workspaces.readArtifact(org.id, "보고서.md");
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("record_artifact", input, "k-file", source)
    );
    // 고정한 원본이 없는 의도(기록 모순으로 원본 자료가 사라짐)도 하나 둔다.
    const lost = await acceptIntent(
      db,
      { id: held.identity.runId },
      draft(
        "record_artifact",
        { ...input, title: "원본 잃음" },
        "k-lost",
        source
      )
    );
    if (lost.kind !== "accepted") throw new Error("not accepted");
    await setIntentSource(db, lost.intent.id, null);
    await writeFile(path.join(folder, "보고서.md"), "# 바뀐 내용");
    const modelRuns = agents.of(org.lead.id).length;
    await restart();
    // 정산이 막혀 모델은 부르지 않았고, 에이전트는 막혔으며 실행 시도는 실패로 끝나 받은 깨우기를 되돌렸다.
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    expect((await api.agent(org.id, org.lead.id)).recovery).toMatchObject({
      state: "blocked",
      reason: "missing_source",
    });
    const [blockedRun] = await api.runs(org.id, org.lead.id);
    expect(blockedRun).toMatchObject({ status: "failed" });
    const types = (await api.events(org.id)).map((e) => e.type);
    expect(types).toContain("agent.recovery_blocked");
    // 앞의 의도는 수락 때 바이트로 이미 정산됐다(효과는 하나).
    const taskArtifacts = async () =>
      taskDetailSchema.parse(
        (
          await api.request(
            "GET",
            `/api/organizations/${org.id}/tasks/${task.id}`
          )
        ).body
      ).artifacts;
    const artifacts = async () => (await taskArtifacts()).map((a) => a.title);
    expect(await artifacts()).toEqual(["보고서"]);

    // 새 메시지·heartbeat·서버 재시작은 막힘을 풀지 않는다.
    await api.say(org.id, "막힌 동안 보낸 말");
    await restarted!.tickHeartbeats();
    await restarted!.drain();
    await restart();
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    expect((await api.agent(org.id, org.lead.id)).recovery?.state).toBe(
      "blocked"
    );
    // 사용자가 복구 재시도를 골라도 원본이 없으면 다시 막힌다.
    const retry = async () =>
      api.request(
        "POST",
        `/api/organizations/${org.id}/agents/${org.lead.id}/recover`,
        {}
      );
    expect((await retry()).status).toBe(200);
    await restarted!.drain();
    expect((await api.agent(org.id, org.lead.id)).recovery?.state).toBe(
      "blocked"
    );
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    // 원본 자료를 되찾은 뒤 다시 시도하면 정산이 끝나고 그때서야 모델이 깨우기를 모두 받는다.
    await setIntentSource(db, lost.intent.id, source);
    expect((await retry()).status).toBe(200);
    await restarted!.drain();
    expect((await api.agent(org.id, org.lead.id)).recovery).toBeNull();
    const resumed = agents.of(org.lead.id).slice(modelRuns);
    expect(resumed).toHaveLength(1);
    const [recovery] = recoveries(resumed[0]!.request.wakeReasons);
    expect(outcomes(recovery!.intents)).toEqual([
      ["record_artifact", "completed"],
      ["record_artifact", "completed"],
    ]);
    expect(
      resumed[0]!.request.wakeReasons
        .filter((r) => r.kind === "owner_message")
        .map((r) => (r as { body: string }).body)
    ).toEqual(["멈출 실행", "막힌 동안 보낸 말"]);
    expect(await artifacts()).toEqual(["보고서", "원본 잃음"]);
    for (const summary of await taskArtifacts()) {
      const artifact = artifactSchema.parse(
        (
          await api.request(
            "GET",
            `/api/organizations/${org.id}/artifacts/${summary.id}`
          )
        ).body
      );
      expect(artifact.content).toBe("# 수락 때 원문");
    }
    expect((await api.events(org.id)).map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "agent.recovery_retried",
        "agent.recovery_resolved",
      ])
    );
  });

  it("keeps counting settlement attempts across restarts, and only the owner's retry, not reading or archiving the Inbox item, lets it settle again", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("재시도 한도 조직");
    const accepted = await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "한도 뒤 답장" }, "k-limit")
    );
    if (accepted.kind !== "accepted") throw new Error("not accepted");
    // 앞선 재시작들에서 이미 한도만큼 정산을 시작했다가 멈춘 기록.
    await setIntentSettleAttempts(db, accepted.intent.id, 3);
    const modelRuns = agents.of(org.lead.id).length;
    await restart();
    expect((await api.agent(org.id, org.lead.id)).recovery).toMatchObject({
      state: "blocked",
      reason: "retry_exhausted",
    });
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    expect(await api.agentReplies(org.id, "한도 뒤 답장")).toEqual([]);
    // 막혀 실패한 실행 시도의 Inbox 항목을 읽고 보관해도, 서버를 다시 시작해도 풀리지 않는다.
    const [blockedRun] = await api.runs(org.id, org.lead.id);
    for (const change of [{ read: true }, { archived: true }])
      expect(
        (
          await api.request(
            "PUT",
            `/api/organizations/${org.id}/inbox/run_failure/${blockedRun!.id}`,
            change
          )
        ).status
      ).toBe(200);
    await restart();
    expect((await api.agent(org.id, org.lead.id)).recovery?.state).toBe(
      "blocked"
    );
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    // 사용자의 복구 재시도는 시도 횟수를 새로 세고 정산한 뒤에야 모델을 부른다.
    expect(
      (
        await api.request(
          "POST",
          `/api/organizations/${org.id}/agents/${org.lead.id}/recover`,
          {}
        )
      ).status
    ).toBe(200);
    await restarted!.drain();
    expect((await api.agent(org.id, org.lead.id)).recovery).toBeNull();
    expect(
      (await api.agentReplies(org.id, "한도 뒤 답장")).map((m) => m.body)
    ).toEqual(["한도 뒤 답장"]);
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns + 1);
  });

  it("keeps one effect for concurrent retransmissions of one intent and separate effects for separate intents with the same content", async () => {
    const { org, held, api } = await heldLead("동시 재전송 조직");
    const token = held.access.token;
    const same = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.tool(token, "/messages", { body: "같은 의도" }, "k-same")
      )
    );
    expect(same.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(same.map((r) => r.body.id)).size).toBe(1);
    expect(same[0]!.status).toBe(201);
    // 같은 내용이라도 키가 다르거나 키가 없으면 별개의 의도다.
    expect(
      (await api.tool(token, "/messages", { body: "같은 의도" }, "k-other"))
        .status
    ).toBe(201);
    expect(
      (await api.tool(token, "/messages", { body: "같은 의도" })).status
    ).toBe(201);
    // 같은 키의 다른 입력·도구는 충돌이며 효과가 없다.
    expect(
      await api.tool(token, "/messages", { body: "다른 입력" }, "k-same")
    ).toEqual({
      status: 409,
      body: { error: { code: "idempotency_conflict" } },
    });
    expect(
      (await api.tool(token, "/tasks", { title: "다른 도구" }, "k-same")).body
    ).toEqual({ error: { code: "idempotency_conflict" } });
    expect(
      (await api.agentReplies(org.id, "같은 의도")).map((m) => m.body)
    ).toEqual(["같은 의도", "같은 의도", "같은 의도"]);
  });

  it("returns a completed result after the stage closed the tool, but settles a pending write of a closed tool as a refusal without effect", async () => {
    const { agents, org, task, held, api, restart, db } =
      await heldLead("단계 변경 조직");
    const token = held.access.token;
    const assigneeAgentId = org.workers[0]!.id;
    const created = await api.tool(
      token,
      "/tasks",
      { title: "끝난 쓰기", assigneeAgentId },
      "k-done"
    );
    expect(created.status).toBe(201);
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("create_task", { title: "남은 쓰기", assigneeAgentId }, "k-pending")
    );
    // 결과 제출로 연구 단계를 넘긴다. 작업 만들기는 이제 닫혔다.
    const artifact = await api.tool(
      token,
      "/artifacts",
      { taskId: task.id, title: "근거", format: "text", content: "근거" },
      "k-artifact"
    );
    expect(artifact.body).toMatchObject({ title: "근거" });
    expect(
      (
        await api.tool(
          token,
          "/results",
          { summary: "결과", artifactIds: [artifact.body.id] },
          "k-result"
        )
      ).status
    ).toBe(201);
    expect(
      (
        await api.tool(
          token,
          "/tasks",
          { title: "새 쓰기", assigneeAgentId },
          "k-new"
        )
      ).body
    ).toMatchObject({ error: { code: "stage_closed" } });
    // 끝난 의도의 최초 결과 조회는 새 쓰기가 아니다.
    expect(
      await api.tool(
        token,
        "/tasks",
        { title: "끝난 쓰기", assigneeAgentId },
        "k-done"
      )
    ).toEqual(created);
    let next!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      next = request;
      return idle;
    });
    await restart();
    const [recovery] = recoveries(next.wakeReasons);
    expect(recovery!.intents.map((i) => [i.request?.body, i.outcome])).toEqual([
      [
        { title: "끝난 쓰기", assigneeAgentId },
        { status: "completed", result: created.body },
      ],
      [
        { title: "남은 쓰기", assigneeAgentId },
        { status: "refused", reason: "stage" },
      ],
      [expect.anything(), expect.objectContaining({ status: "completed" })],
      [expect.anything(), expect.objectContaining({ status: "completed" })],
    ]);
    expect((await api.tasks(org.id)).map((x) => x.title).sort()).toEqual([
      "근거 정리",
      "끝난 쓰기",
    ]);
  });

  it("drops a pending write of a run the owner cancelled and refuses its retransmission", async () => {
    const { agents, org, held, api, db } = await heldLead("취소 조직");
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "취소된 답장" }, "k-cancel")
    );
    expect(
      (
        await api.request(
          "POST",
          `/api/organizations/${org.id}/agents/${org.lead.id}/interrupt`,
          {}
        )
      ).status
    ).toBe(200);
    await t!.drain();
    const [cancelled] = await api.runs(org.id, org.lead.id);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    // 취소된 실행 시도의 수행하지 않은 의도는 되살리지 않는다.
    const gate = createGate();
    let next!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      next = request;
      return { steps: [{ do: "hold", until: gate.wait }] };
    });
    await api.say(org.id, "다음");
    await gate.reached;
    expect(recoveries(next.wakeReasons)).toEqual([]);
    expect(
      await api.tool(
        next.access.token,
        "/messages",
        { body: "취소된 답장" },
        "k-cancel"
      )
    ).toEqual({ status: 409, body: { error: { code: "intent_cancelled" } } });
    gate.open();
    await t!.drain();
    expect(await api.agentReplies(org.id, "취소된 답장")).toEqual([]);
  });

  it("waits for a paused agent before settling, and keeps keys apart across agents and organizations", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("일시정지 조직");
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "재개 뒤 답장" }, "k-shared")
    );
    // 서버가 멈춘 동안 사용자가 Lead를 일시정지했다(대시보드와 같은 저장 경로).
    await restart(async () => {
      expect((await controlAgent(db, org.id, org.lead.id, "pause")).kind).toBe(
        "ok"
      );
    });
    // 일시정지 동안에는 실행 시도도 정산도 없다. 의도는 수락한 채 남는다.
    expect(await api.agentReplies(org.id, "재개 뒤 답장")).toEqual([]);
    expect(await intentStatusOf(db, org.lead.id, "k-shared")).toBe("accepted");
    let next!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      next = request;
      return idle;
    });
    expect(
      (
        await api.request(
          "POST",
          `/api/organizations/${org.id}/agents/${org.lead.id}/resume`,
          {}
        )
      ).status
    ).toBe(200);
    await restarted!.drain();
    expect(outcomes(recoveries(next.wakeReasons)[0]!.intents)).toEqual([
      ["send_message", "completed"],
    ]);
    expect(
      (await api.agentReplies(org.id, "재개 뒤 답장")).map((m) => m.body)
    ).toEqual(["재개 뒤 답장"]);
    // 같은 키 문자열이라도 다른 에이전트·조직의 의도와 섞이지 않는다.
    const other = await heldOtherOrganization(api, agents, db);
    expect(other.replies).toEqual(["다른 조직 답장"]);
    expect(
      (await api.agentReplies(org.id, "재개 뒤 답장")).map((m) => m.body)
    ).toEqual(["재개 뒤 답장"]);
  });
});

/** 같은 서버에 조직을 하나 더 만들어 그 Lead가 같은 키 문자열로 답장한다. */
async function heldOtherOrganization(
  api: ReturnType<typeof http>,
  agents: ReturnType<typeof scriptedAgents>,
  _db: Database
) {
  const created = (
    await api.request("POST", "/api/organizations", {
      name: "다른 조직",
      goal: "다른 목표",
      completionCriteria: "다른 기준",
    })
  ).body as { id: string; agents: { id: string; role: string }[] };
  const lead = created.agents.find((a) => a.role === "lead")!;
  await restarted!.drain();
  const gate = createGate();
  let held!: RunRequest;
  agents.queue(lead.id, (request) => {
    held = request;
    return { steps: [{ do: "hold", until: gate.wait }] };
  });
  await api.say(created.id, "답장해 줘");
  await gate.reached;
  const reply = await api.tool(
    held.access.token,
    "/messages",
    { body: "다른 조직 답장" },
    "k-shared"
  );
  expect(reply.status).toBe(201);
  gate.open();
  await restarted!.drain();
  return {
    replies: (await api.agentReplies(created.id))
      .map((m) => m.body)
      .filter((b) => b === "다른 조직 답장"),
  };
}

describe("recovery delivery and stored records at the edges (#150 PR #164 review)", () => {
  /** 다음 Lead 요청 조립의 작업 폴더 준비(`Workspaces.forRun`)를 바꾼다. 정산과 모델 호출 사이의 경계를 고정한다. */
  const onLeadAssemble = (
    leadId: string,
    around: (
      real: () => ReturnType<Workspaces["forRun"]>
    ) => ReturnType<Workspaces["forRun"]>
  ) => {
    const real = Workspaces.prototype.forRun;
    vi.spyOn(Workspaces.prototype, "forRun").mockImplementation(function (
      this: Workspaces,
      orgId: string,
      agentId: string
    ) {
      const call = () => real.call(this, orgId, agentId);
      return agentId === leadId ? around(call) : call();
    });
  };

  it("keeps the recovery delivery when building the model request fails after settlement, blocks at the limit, and delivers it after the owner's retry", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("요청 조립 실패 조직");
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "조립 전 답장" }, "k-assemble")
    );
    let broken = true;
    onLeadAssemble(org.lead.id, (real) =>
      broken ? Promise.reject(new Error("요청 조립 실패")) : real()
    );
    const modelRuns = agents.of(org.lead.id).length;
    await restart();
    // 효과는 정산됐지만 모델은 결과를 받지 못했다. 복구 깨우기는 소모되지 않고, 한도까지 다시 시도한 뒤 에이전트가 막힌다.
    expect(
      (await api.agentReplies(org.id, "조립 전 답장")).map((m) => m.body)
    ).toEqual(["조립 전 답장"]);
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    expect((await api.agent(org.id, org.lead.id)).recovery).toMatchObject({
      state: "blocked",
      reason: "retry_exhausted",
    });
    broken = false;
    expect(
      (
        await api.request(
          "POST",
          `/api/organizations/${org.id}/agents/${org.lead.id}/recover`,
          {}
        )
      ).status
    ).toBe(200);
    await restarted!.drain();
    const resumed = agents.of(org.lead.id).slice(modelRuns);
    expect(resumed).toHaveLength(1);
    expect(
      outcomes(recoveries(resumed[0]!.request.wakeReasons)[0]!.intents)
    ).toEqual([["send_message", "completed"]]);
    expect((await api.agent(org.id, org.lead.id)).recovery).toBeNull();
    expect(
      (await api.agentReplies(org.id, "조립 전 답장")).map((m) => m.body)
    ).toEqual(["조립 전 답장"]);
  });

  it("keeps the recovery delivery when the owner cancels after settlement but before the model receives the request", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("조립 중 취소 조직");
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "취소 전 답장" }, "k-boundary")
    );
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    onLeadAssemble(org.lead.id, async (real) => {
      if (armed) {
        armed = false;
        enter();
        await released;
      }
      return real();
    });
    const modelRuns = agents.of(org.lead.id).length;
    agents.queue(org.lead.id, idle);
    await restart(undefined, { drain: false });
    await entered;
    expect(
      (
        await api.request(
          "POST",
          `/api/organizations/${org.id}/agents/${org.lead.id}/interrupt`,
          {}
        )
      ).status
    ).toBe(200);
    release();
    await restarted!.drain();
    // 취소된 실행 시도는 모델을 부르지 않았고, 사용자 취소는 막힘이 아니다. 취소한 사용자 메시지는 버리고
    // 복구 깨우기만 다시 대기해 바로 다음 실행 시도가 그 결과를 받는다.
    const [after, cancelled] = await api.runs(org.id, org.lead.id);
    expect([after!.status, cancelled!.status]).toEqual([
      "completed",
      "cancelled",
    ]);
    expect((await api.agent(org.id, org.lead.id)).recovery).toBeNull();
    const resumed = agents.of(org.lead.id).slice(modelRuns);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.request.identity.runId).toBe(after!.id);
    expect(resumed[0]!.request.wakeReasons.map((r) => r.kind)).toEqual([
      "intent_recovery",
    ]);
    expect(
      outcomes(recoveries(resumed[0]!.request.wakeReasons)[0]!.intents)
    ).toEqual([["send_message", "completed"]]);
    expect(
      (await api.agentReplies(org.id, "취소 전 답장")).map((m) => m.body)
    ).toEqual(["취소 전 답장"]);
  });

  it("marks the original input as unknown instead of an empty input when a completed record has none", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("입력 없는 기록 조직");
    const sent = await api.tool(
      held.access.token,
      "/messages",
      { body: "옛 판 답장" },
      "k-legacy"
    );
    expect(sent.status).toBe(201);
    // 이 기능 전 판이 남긴 영수증은 입력을 남기지 않았다(migration 0032 뒤 `request`가 비어 있음).
    await setIntentRequest(db, org.lead.id, "k-legacy", null);
    let next!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      next = request;
      return idle;
    });
    await restart();
    expect(recoveries(next.wakeReasons)[0]!.intents).toEqual([
      {
        intentId: expect.any(String),
        tool: "send_message",
        request: null,
        outcome: { status: "completed", result: sent.body },
      },
    ]);
  });

  it("delivers a completed result with an unknown input, but blocks a pending write whose stored input cannot be read, instead of retrying admission forever", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("손상된 입력 조직");
    const sent = await api.tool(
      held.access.token,
      "/messages",
      { body: "완료된 답장" },
      "k-done"
    );
    expect(sent.status).toBe(201);
    await acceptIntent(
      db,
      { id: held.identity.runId },
      draft("send_message", { body: "손상된 답장" }, "k-corrupt")
    );
    await setIntentRequest(db, org.lead.id, "k-done", "{손상");
    await setIntentRequest(db, org.lead.id, "k-corrupt", "{손상");
    const modelRuns = agents.of(org.lead.id).length;
    await restart(undefined, { drain: false });
    await vi.waitFor(
      async () =>
        expect((await api.agent(org.id, org.lead.id)).recovery).toMatchObject({
          state: "blocked",
          reason: "inconsistent_record",
        }),
      { timeout: 10_000, interval: 100 }
    );
    await restarted!.drain();
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    expect(await api.agentReplies(org.id, "손상된 답장")).toEqual([]);
    // 깨우기 사유를 읽는 곳(실행 시도 상세)도 손상된 입력으로 실패하지 않고 입력을 모름으로 보인다.
    const [blockedRun] = await api.runs(org.id, org.lead.id);
    const detail = await api.run(org.id, blockedRun!.id);
    const recovery = detail.wakeReasons.find(
      (r) => r.kind === "intent_recovery"
    ) as Extract<WakeReason, { kind: "intent_recovery" }>;
    expect(recovery.intents.map((i) => [i.request, i.outcome.status])).toEqual([
      [null, "completed"],
      [null, "pending"],
    ]);
  });

  it("returns the first result to a concurrent retransmission whose file read starts before the first acceptance and ends after the file is gone", async () => {
    const { org, task, held, api } = await heldLead("동시 파일 조직");
    const folder = held.workspace!.cwd;
    await writeFile(path.join(folder, "동시.md"), "# 처음 내용");
    const input = { taskId: task.id, title: "동시 산출물", path: "동시.md" };
    const real = Workspaces.prototype.readArtifact;
    let reads = 0;
    let secondReading!: () => void;
    const second = new Promise<void>((resolve) => (secondReading = resolve));
    let firstSettled!: () => void;
    const settled = new Promise<void>((resolve) => (firstSettled = resolve));
    // 먼저 읽기에 닿은 호출은 다른 호출이 기존 의도 조회를 지나 파일 읽기에 닿을 때까지 기다린다.
    // 뒤의 호출은 앞의 호출이 정산되고 파일이 사라진 뒤에 읽는다.
    vi.spyOn(Workspaces.prototype, "readArtifact").mockImplementation(
      async function (this: Workspaces, orgId: string, requested: string) {
        const n = ++reads;
        if (n === 1) await second;
        if (n === 2) {
          secondReading();
          await settled;
        }
        return real.call(this, orgId, requested);
      }
    );
    const calls = [1, 2].map(() =>
      api.tool(held.access.token, "/artifacts", input, "k-race")
    );
    const first = await Promise.race(calls);
    expect(first.status).toBe(201);
    await rm(path.join(folder, "동시.md"));
    firstSettled();
    expect(await Promise.all(calls)).toEqual([first, first]);
    expect(reads).toBe(2);
    const detail = taskDetailSchema.parse(
      (
        await api.request(
          "GET",
          `/api/organizations/${org.id}/tasks/${task.id}`
        )
      ).body
    );
    expect(detail.artifacts.map((a) => a.title)).toEqual(["동시 산출물"]);
  });
});

describe("recovery delivery confirmed by the provider's session and counted across restarts (#150 PR #164 review round 2)", () => {
  /** 서버 재시작 뒤 복구 깨우기를 받은 Lead 요청을 프로바이더가 모델을 부르기 전에 실패로 끝낸다(세션 없음). `times`번까지. */
  const failBeforeModel = (
    agents: ReturnType<typeof scriptedAgents>,
    leadId: string,
    times: number
  ) => {
    const real = agents.runtime.execute.bind(agents.runtime);
    const failed: RunRequest[] = [];
    vi.spyOn(agents.runtime, "execute").mockImplementation(
      async (request, options) => {
        if (
          request.identity.agentId === leadId &&
          request.wakeReasons.some((r) => r.kind === "intent_recovery") &&
          failed.length < times
        ) {
          failed.push(request);
          return {
            stopReason: "failed",
            error: "프로바이더가 모델을 부르기 전에 실패했습니다.",
            summary: null,
            usage: null,
            nextSession: null,
          };
        }
        return real(request, options);
      }
    );
    return failed;
  };

  it("requeues the recovery wake when the provider fails before the model and leaves no session, so the next run receives the result", async () => {
    const { agents, org, held, api, restart } =
      await heldLead("프로바이더 준비 실패 조직");
    const sent = await api.tool(
      held.access.token,
      "/messages",
      { body: "준비 실패 전 답장" },
      "k-provider"
    );
    expect(sent.status).toBe(201);
    const failed = failBeforeModel(agents, org.lead.id, 1);
    let next!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      next = request;
      return idle;
    });
    await restart();
    expect(failed).toHaveLength(1);
    const [after, failedRun] = await api.runs(org.id, org.lead.id);
    expect([after!.status, failedRun!.status]).toEqual(["completed", "failed"]);
    expect(next.identity.runId).toBe(after!.id);
    expect(outcomes(recoveries(next.wakeReasons)[0]!.intents)).toEqual([
      ["send_message", "completed"],
    ]);
    expect((await api.agent(org.id, org.lead.id)).recovery).toBeNull();
    expect(
      (await api.agentReplies(org.id, "준비 실패 전 답장")).map((m) => m.body)
    ).toEqual(["준비 실패 전 답장"]);
  });

  it("counts recovery delivery attempts in the database even when every intent is already settled, so failures and restarts cannot reset the limit", async () => {
    const { agents, org, held, api, restart } =
      await heldLead("전달 한도 조직");
    expect(
      (
        await api.tool(
          held.access.token,
          "/messages",
          { body: "한도 전 답장" },
          "k-delivery"
        )
      ).status
    ).toBe(201);
    const failed = failBeforeModel(agents, org.lead.id, 100);
    const modelRuns = agents.of(org.lead.id).length;
    await restart();
    // 모델 전 실패가 이어지면 전달 시도는 한도(3)에서 멈추고 에이전트가 막힌다.
    expect(failed).toHaveLength(3);
    expect((await api.agent(org.id, org.lead.id)).recovery).toMatchObject({
      state: "blocked",
      reason: "retry_exhausted",
    });
    // 서버를 다시 시작해도 센 횟수는 남아 다시 시도하지 않는다.
    await restart();
    expect(failed).toHaveLength(3);
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    vi.restoreAllMocks();
    let next!: RunRequest;
    agents.queue(org.lead.id, (request) => {
      next = request;
      return idle;
    });
    expect(
      (
        await api.request(
          "POST",
          `/api/organizations/${org.id}/agents/${org.lead.id}/recover`,
          {}
        )
      ).status
    ).toBe(200);
    await restarted!.drain();
    expect(outcomes(recoveries(next.wakeReasons)[0]!.intents)).toEqual([
      ["send_message", "completed"],
    ]);
    expect((await api.agent(org.id, org.lead.id)).recovery).toBeNull();
  });

  it("blocks a recovery whose settled intents already used up their attempts before earlier restarts", async () => {
    const { agents, org, held, api, restart, db } =
      await heldLead("정산 끝난 한도 조직");
    expect(
      (
        await api.tool(
          held.access.token,
          "/messages",
          { body: "정산 끝난 답장" },
          "k-settled"
        )
      ).status
    ).toBe(201);
    const intent = await findIntentByKey(db, org.lead.id, "k-settled");
    await setIntentSettleAttempts(db, intent!.id, 3);
    const modelRuns = agents.of(org.lead.id).length;
    await restart();
    expect(agents.of(org.lead.id)).toHaveLength(modelRuns);
    expect((await api.agent(org.id, org.lead.id)).recovery).toMatchObject({
      state: "blocked",
      reason: "retry_exhausted",
    });
  });

  it("returns the first result to a same-key retransmission whose stage check runs after the first call settled and the stage closed the tool", async () => {
    const { org, held, api, db } = await heldLead("단계 경합 조직");
    const assigneeAgentId = org.workers[0]!.id;
    const body = { title: "경합 작업", assigneeAgentId };
    const stored = draft("create_task", body, "k-stage-race");
    const result = {
      id: "00000000-0000-4000-8000-000000000000",
      title: "경합 작업",
    };
    const eventsBefore = (await api.events(org.id)).length;
    let retransmission!: ReturnType<typeof api.tool>;
    // 재전송의 기존 의도 조회는 지났고 단계 검사는 실행 시도 행 잠금을 기다리는 동안, 앞선 호출의 정산과 단계 변경이 commit된다.
    await whileHoldingRun(db, held.identity.runId, async (tx) => {
      retransmission = api.tool(
        held.access.token,
        "/tasks",
        body,
        "k-stage-race"
      );
      await vi.waitFor(async () => expect(await lockWaiters(db)).toBe(1), {
        timeout: 10_000,
        interval: 20,
      });
      await insertCompletedIntent(tx, {
        organizationId: org.id,
        agentId: org.lead.id,
        runId: held.identity.runId,
        key: "k-stage-race",
        tool: "create_task",
        request: stored.request,
        digest: stored.digest,
        result,
      });
      await setOrganizationStage(tx, org.id, "result_review");
    });
    expect(await retransmission).toEqual({ status: 201, body: result });
    expect(
      (await api.events(org.id))
        .slice(0, (await api.events(org.id)).length - eventsBefore)
        .map((e) => e.type)
    ).not.toContain("tool.refused");
  });
});
