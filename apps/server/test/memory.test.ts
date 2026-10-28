import {
  eventListSchema,
  memoryEntryListSchema,
  organizationDetailSchema,
  type MemoryEntry,
} from "@babojubot/contracts";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { calls, goal, ok, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const { say, researching } = serverHelpers(() => t!);

const write = (scope: "organization" | "agent", content: string) => ({
  tool: "write_memory" as const,
  input: { scope, content },
});
const recall = (
  scope: "organization" | "agent",
  query?: Record<string, string>
) => ({ tool: "recall_memory" as const, input: { scope, ...query } });

/** 그 에이전트 마지막 실행 시도의 도구 호출 결과. */
const lastCalls = (
  agents: ReturnType<typeof scriptedAgents>,
  agentId: string
) => agents.of(agentId).at(-1)!.state.calls;
const recalled = (output: unknown) =>
  memoryEntryListSchema.parse(output).map((m: MemoryEntry) => m.content);

/** 사용자가 목표를 적어 만든 조직. 생성으로 깨어난 Lead의 실행 시도가 끝날 때까지 기다린다. */
async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name, ...goal });
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  return { id: org.id, lead: org.agents.find((a) => a.role === "lead")! };
}

describe("organization and agent memory", () => {
  it("keeps agent memory to its writer and shares organization memory within the organization", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "기억 조직");
    const [worker] = org.workers;

    agents.queue(
      org.lead.id,
      calls(
        write("agent", "Lead만 아는 메모: 사용자는 짧은 보고를 좋아함"),
        write("organization", "조직 공통: 평가셋은 공개 평가셋"),
        {
          tool: "message_agent",
          input: { recipientAgentId: worker!.id, body: "기억을 확인해 줘" },
        }
      )
    );
    agents.queue(
      worker!.id,
      calls(
        recall("agent"),
        recall("organization"),
        write("agent", "작업자 메모")
      )
    );
    await say(org.id, "기억을 남겨 줘");
    await t.drain();

    const [lead1, lead2] = lastCalls(agents, org.lead.id);
    expect(ok(lead1)).toMatchObject({
      scope: "agent",
      agentId: org.lead.id,
      source: { agentId: org.lead.id },
    });
    expect(ok(lead2)).toMatchObject({ scope: "organization", agentId: null });
    const [ownMemory, shared] = lastCalls(agents, worker!.id);
    expect(recalled(ok(ownMemory))).toEqual([]);
    expect(recalled(ok(shared))).toEqual(["조직 공통: 평가셋은 공개 평가셋"]);

    // Lead는 자기 에이전트 기억만 회수한다. 작업자의 에이전트 기억은 보이지 않는다.
    agents.queue(org.lead.id, calls(recall("agent")));
    await say(org.id, "다시 확인");
    await t.drain();
    expect(recalled(ok(lastCalls(agents, org.lead.id)[0]))).toEqual([
      "Lead만 아는 메모: 사용자는 짧은 보고를 좋아함",
    ]);

    // 기억 쓰기는 Event로 남고 내용은 담지 않는다.
    const events = eventListSchema.parse(
      (await t.request("GET", `/api/organizations/${org.id}/events`)).body
    );
    const written = events.filter((e) => e.type === "memory.written");
    expect(written.map((e) => e.payload)).toEqual([
      expect.objectContaining({ agentId: org.lead.id, scope: "agent" }),
      expect.objectContaining({ agentId: org.lead.id, scope: "organization" }),
      expect.objectContaining({ agentId: worker!.id, scope: "agent" }),
    ]);
    expect(JSON.stringify(written)).not.toContain("Lead만 아는 메모");
  });

  it("cannot recall another organization's memory with this organization's token", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const a = await createOrganization("조직 A");
    const b = await createOrganization("조직 B");

    agents.queue(
      b.lead.id,
      calls(write("organization", "B 조직 비밀"), write("agent", "B Lead 비밀"))
    );
    await say(b.id, "기억해");
    await t.drain();

    agents.queue(
      a.lead.id,
      calls(
        recall("organization", { query: "비밀" }),
        recall("agent", { query: "비밀" }),
        recall("organization", { organizationId: b.id })
      )
    );
    await say(a.id, "B의 기억을 찾아봐");
    await t.drain();
    const [orgMemory, agentMemory, chosen] = lastCalls(agents, a.lead.id);
    expect(recalled(ok(orgMemory))).toEqual([]);
    expect(recalled(ok(agentMemory))).toEqual([]);
    // 조직을 고르는 입력은 없다.
    expect(chosen).toMatchObject({ ok: false, status: 422 });

    // 끝난 실행 시도의 토큰으로는 읽지도 쓰지도 못한다.
    const token = agents.of(b.lead.id).at(-1)!.request.access.token;
    expect(
      (await t.tool(token, "GET", "/memories?scope=organization")).status
    ).toBe(401);
    expect(
      (
        await t.tool(token, "POST", "/memories", {
          scope: "organization",
          content: "늦은 쓰기",
        })
      ).status
    ).toBe(401);
  });

  it("recalls the latest first and matches the query letter for letter, ignoring case", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("회수 조직");
    agents.queue(
      org.lead.id,
      calls(
        write("organization", "WER 100% 달성 기준"),
        write("organization", "wer_target 정리"),
        write("organization", "werx 기록"),
        write("organization", "관련 없는 메모"),
        recall("organization", { query: "wer" }),
        recall("organization", { query: "%" }),
        recall("organization", { query: "r_t" }),
        recall("organization", { limit: "2" }),
        recall("organization", { limit: "51" })
      )
    );
    await say(org.id, "정리해");
    await t.drain();
    const [, , , , byWord, percent, underscore, latest, tooMany] = lastCalls(
      agents,
      org.lead.id
    );
    expect(recalled(ok(byWord))).toEqual([
      "werx 기록",
      "wer_target 정리",
      "WER 100% 달성 기준",
    ]);
    expect(recalled(ok(percent))).toEqual(["WER 100% 달성 기준"]);
    expect(recalled(ok(underscore))).toEqual(["wer_target 정리"]);
    expect(recalled(ok(latest))).toEqual(["관련 없는 메모", "werx 기록"]);
    expect(tooMany).toMatchObject({ ok: false, status: 422 });
  });

  it("writes a memory once for the same idempotency key and refuses the key with different content", async () => {
    const gate = createGate();
    const agents = scriptedAgents();
    let token = "";
    t = await startTestServer({
      runtime: {
        execute(request, control) {
          token = request.access.token;
          return agents.runtime.execute(request, control);
        },
      },
    });
    const org = await createOrganization("한 번만 쓰기");
    agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
    await say(org.id, "기다려");
    await gate.reached;

    const post = (content: string, key = "memo-1") =>
      t!.request(
        "POST",
        "/api/tools/memories",
        { scope: "organization", content },
        { authorization: `Bearer ${token}`, "idempotency-key": key }
      );
    const first = await post("한 번만 남길 메모");
    const again = await post("한 번만 남길 메모");
    expect(first.status).toBe(201);
    expect(again).toEqual(first);
    expect(await post("다른 내용")).toEqual({
      status: 409,
      body: { error: { code: "idempotency_conflict" } },
    });
    expect((await post("메모", "key with spaces")).status).toBe(422);
    gate.open();
    await t.drain();

    const events = eventListSchema.parse(
      (await t.request("GET", `/api/organizations/${org.id}/events`)).body
    );
    expect(events.filter((e) => e.type === "memory.written")).toHaveLength(1);
  });
});
