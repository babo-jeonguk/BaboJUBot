import {
  conversationMessageListSchema,
  conversationSummaryListSchema,
  organizationDetailSchema,
  outboxSchema,
  startConversationResultSchema,
} from "@babojubot/contracts";
import { createScriptedRuntime, leadReplyScript } from "@babojubot/runtime";
import { createGate, type Gate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { insertLegacyOrganization } from "@babojubot/db/testing";
import { goal, quietCreation } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** 사용자가 목표를 적어 만든 조직. 이 파일의 서버는 `quietCreation`이라 생성으로 깨어난 Lead는 맥락만 읽고 끝난다. */
async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name, ...goal });
  expect(res.status).toBe(201);
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}
const conversationsOf = async (orgId: string) => {
  const res = await t!.request(
    "GET",
    `/api/organizations/${orgId}/conversations`
  );
  expect(res.status).toBe(200);
  return conversationSummaryListSchema.parse(res.body);
};
const messagesOf = async (orgId: string, conversationId?: string) => {
  const res = await t!.request(
    "GET",
    conversationId
      ? `/api/organizations/${orgId}/conversations/${conversationId}/messages`
      : `/api/organizations/${orgId}/messages`
  );
  expect(res.status).toBe(200);
  return conversationMessageListSchema.parse(res.body);
};
const start = async (
  orgId: string,
  body: string,
  delivery: "next_run" | "interrupt" = "next_run"
) =>
  t!.request("POST", `/api/organizations/${orgId}/conversations`, {
    body,
    delivery,
  });
const startOk = async (orgId: string, body: string) => {
  const res = await start(orgId, body);
  expect(res.status).toBe(201);
  return startConversationResultSchema.parse(res.body);
};
const sendTo = (orgId: string, conversationId: string, body: string) =>
  t!.request(
    "POST",
    `/api/organizations/${orgId}/conversations/${conversationId}/messages`,
    { body }
  );

/** 첫 실행 시도만 gate에서 멈추고 그 뒤에는 기본 답장 시나리오를 쓰는 가짜 실행기. */
function holdFirstRun(gate: Gate) {
  let calls = 0;
  return createScriptedRuntime({
    select: () =>
      calls++ === 0
        ? {
            ...leadReplyScript,
            steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
          }
        : leadReplyScript,
  });
}

describe("Lead conversations", () => {
  it("starts a conversation on the first send, and the Lead replies there while the default conversation stays as it was", async () => {
    const now = new Date("2026-10-27T09:00:00.000Z");
    t = await startTestServer({ now: () => now, runtime: quietCreation() });
    const org = await createOrganization("여러 대화 조직");

    // 처음에는 기본 대화 하나뿐이다.
    const [initial, ...none] = await conversationsOf(org.id);
    expect(none).toEqual([]);
    expect(initial).toMatchObject({
      title: "기본 대화",
      isDefault: true,
      unread: false,
    });

    await t.request("POST", `/api/organizations/${org.id}/messages`, {
      body: "기본 대화의 첫 메시지",
    });
    await t.drain();
    const defaultBefore = await messagesOf(org.id);
    expect(defaultBefore.map((m) => m.author)).toEqual(["owner", "agent"]);

    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    const started = await startOk(
      org.id,
      "  학습 데이터 후보를 세 가지 골라 비교해 줄 수 있나요? 라이선스도 같이  "
    );
    expect(started.conversation).toMatchObject({
      organizationId: org.id,
      isDefault: false,
      title: "학습 데이터 후보를 세 가지 골라 비교해 줄 수 있나…",
    });
    expect(started.message).toMatchObject({
      conversationId: started.conversation.id,
      author: "owner",
    });
    await t.drain();

    const thread = await messagesOf(org.id, started.conversation.id);
    expect(thread.map((m) => m.author)).toEqual(["owner", "agent"]);
    expect(thread[1]!.body).toContain("학습 데이터 후보");
    expect(thread[1]!.conversationId).toBe(started.conversation.id);
    // 기본 대화는 그대로다.
    expect(await messagesOf(org.id)).toEqual(defaultBefore);
    expect(
      await messagesOf(org.id, initial!.id),
      "기본 대화는 ID 경로로도 같은 메시지"
    ).toEqual(defaultBefore);
    // 새 대화의 메시지 Event는 그 대화를 가리킨다.
    expect(stream.events.filter((e) => e.type === "message.created")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          conversationId: started.conversation.id,
          author: "owner",
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          conversationId: started.conversation.id,
          author: "agent",
        }),
      }),
    ]);
    stream.close();

    // 목록: 기본 대화가 맨 위, 새 대화는 Lead 답장을 아직 보지 않았다.
    const listed = await conversationsOf(org.id);
    expect(listed.map((c) => [c.id, c.unread])).toEqual([
      [initial!.id, true],
      [started.conversation.id, true],
    ]);
    const read = await t.request(
      "PUT",
      `/api/organizations/${org.id}/conversations/${started.conversation.id}/read`,
      { upToMessageId: thread[1]!.id }
    );
    expect(read.status).toBe(200);
    expect(conversationSummaryListSchema.parse(read.body)).toEqual(
      await conversationsOf(org.id)
    );
    expect((await conversationsOf(org.id)).map((c) => c.unread)).toEqual([
      true,
      false,
    ]);

    // Lead 메시지 알림은 그 메시지의 대화로 간다.
    const outbox = outboxSchema
      .parse((await t.request("GET", "/api/notifications")).body)
      .filter((n) => n.organizationId === org.id);
    expect(
      outbox
        .filter((n) => n.kind === "lead_message")
        .map((n) => n.sourceId)
        .sort()
    ).toEqual([defaultBefore[1]!.id, thread[1]!.id].sort());
    await t.deliverNotifications();
    const channel = (
      await t.request("GET", "/api/channels/fake/messages")
    ).body.filter(
      (m: { organizationId: string }) => m.organizationId === org.id
    ) as { sourceId: string; link: string }[];
    expect(channel.find((m) => m.sourceId === thread[1]!.id)?.link).toBe(
      `/orgs/${org.id}/chat/${started.conversation.id}`
    );
    expect(channel.find((m) => m.sourceId === defaultBefore[1]!.id)?.link).toBe(
      `/orgs/${org.id}/chat/${initial!.id}`
    );
  });

  it("lets one run reply to each conversation whose messages woke it, keeping delivery per message", async () => {
    const gate = createGate();
    t = await startTestServer({ runtime: quietCreation(holdFirstRun(gate)) });
    const org = await createOrganization("여러 대화 깨우기");

    await t.request("POST", `/api/organizations/${org.id}/messages`, {
      body: "첫 메시지",
    });
    await gate.reached;
    // Lead가 실행 중일 때 두 대화에 보낸 메시지는 다음 실행 시도 하나에 묶인다.
    const a = await startOk(org.id, "A 대화 질문");
    const b = await startOk(org.id, "B 대화 질문");
    expect((await sendTo(org.id, a.conversation.id, "A 추가")).status).toBe(
      201
    );
    gate.open();
    await t.drain();

    // 가장 오래된 실행 시도는 생성 깨우기를 받은 것이다.
    const runs = (
      (await t.request("GET", `/api/organizations/${org.id}/runs`)).body as {
        id: string;
        wakeCount: number;
      }[]
    ).slice(0, -1);
    expect(runs.map((r) => r.wakeCount)).toEqual([3, 1]);
    const bodies = async (conversationId: string) =>
      (await messagesOf(org.id, conversationId)).map((m) => m.body);
    const inA = await bodies(a.conversation.id);
    const inB = await bodies(b.conversation.id);
    expect(inA).toHaveLength(3);
    expect(inA[2]).toContain("A 대화 질문");
    expect(inA[2]).toContain("A 추가");
    expect(inA[2]).not.toContain("B 대화 질문");
    expect(inB).toHaveLength(2);
    expect(inB[1]).toContain("B 대화 질문");
    expect(inB[1]).not.toContain("A 대화 질문");
    // 기본 대화에는 첫 실행 시도의 답장만 있다.
    expect((await messagesOf(org.id)).map((m) => m.author)).toEqual([
      "owner",
      "agent",
    ]);
    // 전달 표시는 메시지마다 받은 실행 시도를 가리킨다.
    expect(
      (await messagesOf(org.id, a.conversation.id))
        .filter((m) => m.author === "owner")
        .map((m) => m.deliveredToRunId)
    ).toEqual([runs[0]!.id, runs[0]!.id]);
  });

  it("reports the initial research request drafted on creation in the default conversation", async () => {
    t = await startTestServer();
    const res = await t.request("POST", "/api/organizations", {
      name: "생성 뒤 알리는 조직",
      ...goal,
    });
    const org = organizationDetailSchema.parse(res.body);
    await t.drain();
    const inDefault = await messagesOf(org.id);
    expect(inDefault.map((m) => m.author)).toEqual(["agent"]);
    expect(inDefault[0]!.body).toContain("초기 연구 승인을 요청했습니다");
    expect(await conversationsOf(org.id)).toHaveLength(1);
  });

  it("answers the goal of an organization created without one in the conversation it came from and reports work it starts on its own in the default conversation", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await insertLegacyOrganization(t.db, "기본 대화로 알리는 조직");
    const thread = await startOk(
      org.id,
      "목표: 오류 유형을 정리한다\n완료 기준: 유형 목록"
    );
    await t.drain();
    const inThread = await messagesOf(org.id, thread.conversation.id);
    expect(inThread.map((m) => m.author)).toEqual(["owner", "agent"]);
    expect(inThread[1]!.body).toContain("초기 연구 승인을 요청했습니다");
    expect(await messagesOf(org.id)).toEqual([]);

    const [approval] = (
      await t.request("GET", `/api/organizations/${org.id}/approvals`)
    ).body as { id: string }[];
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${org.id}/approvals/${approval!.id}/decision`,
          { decision: "approve" }
        )
      ).status
    ).toBe(200);
    await t.drain();

    // 승인 결정으로 깨어난 Lead의 분담 알림과 작업 완료 보고는 사용자 메시지가 없으니 기본 대화로 간다.
    const inDefault = await messagesOf(org.id);
    expect(inDefault.length).toBeGreaterThan(1);
    expect(inDefault.every((m) => m.author === "agent")).toBe(true);
    expect(inDefault[0]!.body).toContain("초기 연구 승인을 받아");
    expect(inDefault.at(-1)!.body).toContain("완료");
    expect(await messagesOf(org.id, thread.conversation.id)).toEqual(inThread);
  });

  it("treats another organization's conversation as nonexistent everywhere", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const a = await createOrganization("조직 A");
    const b = await createOrganization("조직 B");
    const bThread = await startOk(b.id, "B의 비밀 대화");
    await t.drain();
    const bMessages = await messagesOf(b.id, bThread.conversation.id);

    const foreign = `/api/organizations/${a.id}/conversations/${bThread.conversation.id}`;
    expect((await t.request("GET", `${foreign}/messages`)).status).toBe(404);
    expect(
      (await t.request("POST", `${foreign}/messages`, { body: "x" })).status
    ).toBe(404);
    expect(
      (
        await t.request("PUT", `${foreign}/read`, {
          upToMessageId: bMessages[0]!.id,
        })
      ).status
    ).toBe(404);
    for (const id of ["nope", crypto.randomUUID()])
      expect(
        (
          await t.request(
            "GET",
            `/api/organizations/${a.id}/conversations/${id}/messages`
          )
        ).status
      ).toBe(404);
    expect(
      (
        await t.request(
          "GET",
          `/api/organizations/${crypto.randomUUID()}/conversations`
        )
      ).status
    ).toBe(404);
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${crypto.randomUUID()}/conversations`,
          { body: "x" }
        )
      ).status
    ).toBe(404);
    // A의 목록·메시지에는 B의 대화가 없다.
    expect((await conversationsOf(a.id)).map((c) => c.title)).toEqual([
      "기본 대화",
    ]);
    expect(await messagesOf(b.id, bThread.conversation.id)).toEqual(bMessages);
  });

  it("refuses input outside the contract without leaving an empty conversation", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await createOrganization("입력 조직");
    for (const body of [
      { body: "  " },
      {},
      { body: "x", delivery: "steer" },
      { body: "x", title: "제목" },
    ])
      expect(
        (
          await t.request(
            "POST",
            `/api/organizations/${org.id}/conversations`,
            body
          )
        ).status
      ).toBe(422);
    expect(await conversationsOf(org.id)).toHaveLength(1);
  });

  it("keeps conversations of a stopped organization readable and takes no more messages there", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await createOrganization("끝난 조직");
    const thread = await startOk(org.id, "중단 전 대화");
    await t.drain();
    expect(
      (await t.request("POST", `/api/organizations/${org.id}/stop`, {})).status
    ).toBe(200);

    expect(await messagesOf(org.id, thread.conversation.id)).toHaveLength(2);
    // 끝난 조직은 줄 세우기·중단하고 보내기 모두 받지 않고, 새 대화도 남지 않는다.
    for (const delivery of ["next_run", "interrupt"] as const) {
      const refused = await start(org.id, "멈춰", delivery);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: { code: "organization_closed" } });
    }
    const followUp = await sendTo(org.id, thread.conversation.id, "이어서");
    expect(followUp.status).toBe(409);
    expect(followUp.body).toEqual({ error: { code: "organization_closed" } });
    expect(await conversationsOf(org.id)).toHaveLength(2);
    expect(await messagesOf(org.id, thread.conversation.id)).toHaveLength(2);
  });
});
