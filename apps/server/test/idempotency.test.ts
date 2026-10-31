import { eventListSchema, taskListSchema } from "@babojubot/contracts";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 같은 호출 키(`Idempotency-Key`)는 모든 쓰기 도구에서 효과를 한 번만 남긴다. 서버 재시작 뒤 같은 깨우기를 다시 받은
// 실행 시도는 새 토큰으로 같은 키를 보내므로, 여기서는 진행 중 실행 시도의 토큰으로 같은 호출을 되풀이해 그 경계를 본다.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const { say, researching } = serverHelpers(() => t!);

describe("idempotency key on write tools", () => {
  it("creates a task once for the same key and refuses the key for another input or tool", async () => {
    const agents = scriptedAgents();
    const tokens = new Map<string, string>();
    t = await startTestServer({
      runtime: {
        ...agents.runtime,
        execute(request, control) {
          tokens.set(request.identity.agentId, request.access.token);
          return agents.runtime.execute(request, control);
        },
      },
    });
    const org = await researching(agents, "같은 호출 키 조직");
    await t.drain();
    const gate = createGate();
    agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
    await say(org.id, "기다려");
    await gate.reached;
    const token = tokens.get(org.lead.id)!;

    const call = (
      method: string,
      path: string,
      body: unknown,
      key = "task-1"
    ) =>
      t!.request(method, `/api/tools${path}`, body, {
        authorization: `Bearer ${token}`,
        "idempotency-key": key,
      });
    const task = {
      title: "한 번만 만들 작업",
      assigneeAgentId: org.workers[0]!.id,
    };
    // 이 호출이 남기는 Event: 작업 생성과 Lead 실행 시도의 활동. 할당받은 작업자의 실행 시도는 따로 진행된다.
    const events = async () =>
      eventListSchema
        .parse(
          (await t!.request("GET", `/api/organizations/${org.id}/events`)).body
        )
        .filter(
          (e) =>
            e.type === "task.created" ||
            (e.type === "run.activity" && e.payload.agentId === org.lead.id)
        );
    const before = (await events()).length;
    const first = await call("POST", "/tasks", task);
    expect(first.status).toBe(201);
    const recorded = await events();
    expect(recorded.slice(before).map((e) => e.type)).toEqual([
      "task.created",
      "run.activity",
    ]);
    // 같은 키의 재호출은 처음 결과만 돌려주고 기록·Event를 새로 남기지 않는다.
    expect(await call("POST", "/tasks", task)).toEqual(first);
    expect(await events()).toEqual(recorded);
    expect(
      await call("POST", "/tasks", { ...task, title: "다른 작업" })
    ).toEqual({
      status: 409,
      body: { error: { code: "idempotency_conflict" } },
    });
    expect(
      (await call("POST", "/messages", { body: "같은 키의 다른 도구" })).body
    ).toEqual({ error: { code: "idempotency_conflict" } });
    // 키는 에이전트마다 따로이고 다른 키는 새 효과다.
    expect((await call("POST", "/tasks", task, "task-2")).status).toBe(201);
    gate.open();
    await t.drain();

    const tasks = taskListSchema.parse(
      (await t.request("GET", `/api/organizations/${org.id}/tasks`)).body
    );
    expect(tasks.map((x) => x.title)).toEqual([
      "한 번만 만들 작업",
      "한 번만 만들 작업",
    ]);
    // 같은 키로 돌려준 호출은 담당자를 다시 깨우지 않는다(할당 깨우기 두 개: task-1, task-2).
    const worker = agents.of(org.workers[0]!.id);
    expect(
      worker
        .flatMap((r) => r.request.wakeReasons)
        .filter((w) => w.kind === "task_assigned")
    ).toHaveLength(2);
  });
});
