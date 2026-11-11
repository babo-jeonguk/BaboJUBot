import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  conversationPageSchema,
  organizationDetailSchema,
  runSummaryListSchema,
  taskListSchema,
} from "@babojubot/contracts";
import {
  createFakeProviders,
  createOpenCodeProvider,
} from "@babojubot/runtime";
import { intentsOf } from "@babojubot/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calls, scriptedAgents, serverHelpers } from "./scenarios.ts";
import {
  authMarker,
  modelSecret,
  refusedPattern,
  rejectMarker,
  startLocalModel,
  wakeText,
  type ModelRequest,
} from "./local-model.ts";
import { startTestServer, type TestServer } from "./support.ts";

// #147: 실제 OpenCode CLI + 이 컴퓨터의 가짜 모델로, 조직 도구 MCP → OpenCode가 모델에 보내는 도구 정의 → 실행 시도 종료·저장·API까지를 본다.
// 가짜 모델은 대상 upstream이 거부한 `\0` 표기의 도구 정의를 400으로 거부한다. 실제 모델 호출·로그인·모델 목록 다운로드는 없다.
// BABOJUBOT_TEST_OPENCODE로 실행 파일을 정하면 그것만 쓰고, 실행되지 않으면 건너뛰지 않고 실패한다(CI는 이 값을 준다).
// 정하지 않았으면 PATH와 기본 설치 위치에서 찾고, 없으면 건너뛰며 그 사실을 출력한다.
const version = (candidate: string) =>
  execFileSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: "pipe",
  }).trim();
const program = (() => {
  const named = process.env.BABOJUBOT_TEST_OPENCODE;
  if (named) {
    console.log(`[opencode] 실제 CLI 검사: ${named} ${version(named)}`);
    return named;
  }
  for (const candidate of [
    "opencode",
    path.join(homedir(), ".opencode/bin/opencode"),
  ]) {
    try {
      console.log(
        `[opencode] 실제 CLI 검사: ${candidate} ${version(candidate)}`
      );
      return candidate;
    } catch {
      /* 다음 후보 */
    }
  }
  console.log(
    "[opencode] OpenCode를 찾지 못해 실제 CLI + 가짜 모델 검사(도구 정의 전달·요청 거부 이유)를 건너뜁니다."
  );
  return null;
})();

const toolNames = (request: ModelRequest) =>
  (request.body.tools ?? []).map((tool) => tool.function.name);
const artifactPath = (request: ModelRequest) =>
  request.body.tools?.find((tool) =>
    tool.function.name.endsWith("record_artifact")
  )?.function.parameters.properties as
    Record<string, Record<string, unknown>> | undefined;
/** 본 실행(도구가 실린 요청)만. 대화 제목 짓기 요청은 도구가 없다. */
const mainRequests = (requests: ModelRequest[]) =>
  requests.filter((request) => (request.body.tools ?? []).length > 0);
const userText = (request: ModelRequest) =>
  JSON.stringify(request.body.messages?.filter((m) => m.role === "user") ?? []);

describe.skipIf(!program)(
  "real OpenCode CLI with a local fake model (#147)",
  () => {
    let t: TestServer;
    let model: Awaited<ReturnType<typeof startLocalModel>>;
    let dataDir: string;
    const agents = scriptedAgents();
    const { get, researching, create, say } = serverHelpers(() => t);
    beforeAll(async () => {
      model = await startLocalModel();
      dataDir = await mkdtemp(path.join(tmpdir(), "opencode-real-"));
      const [fake] = createFakeProviders(1, { adapter: () => agents.runtime });
      t = await startTestServer({
        providers: [
          fake!,
          createOpenCodeProvider({
            dataDir,
            command: [
              process.execPath,
              path.resolve("test/fixtures/opencode-local-model.mjs"),
              program!,
              model.url,
            ],
          }),
        ],
      });
    });
    afterAll(async () => {
      await t?.close();
      await model?.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const useOpenCode = async (orgId: string, agentId: string) => {
      const res = await t.request(
        "PUT",
        `/api/organizations/${orgId}/agents/${agentId}/provider`,
        { provider: "opencode", model: "fixture/test" }
      );
      expect(res.status).toBe(200);
    };
    const runsOf = async (orgId: string, agentId: string) =>
      runSummaryListSchema
        .parse(await get(`/api/organizations/${orgId}/runs?agentId=${agentId}`))
        .filter((run) => run.provider === "opencode");
    const comment = async (orgId: string, taskId: string, body: string) => {
      const res = await t.request(
        "POST",
        `/api/organizations/${orgId}/tasks/${taskId}/comments`,
        { body }
      );
      expect(res.status).toBe(201);
    };
    /** 그 조직 ID만 나오는 본 실행 요청. 다른 조직의 ID가 섞이면 실패한다. */
    const requestsOf = (orgId: string, others: string[]) => {
      const own = mainRequests(model.requests).filter((request) =>
        userText(request).includes(orgId)
      );
      for (const request of own)
        for (const other of others)
          expect(userText(request)).not.toContain(other);
      return own;
    };

    it("sends the planning tools without record_artifact and the research tools with the accepted NUL rule, resumes the session, and keeps organizations apart under concurrency", async () => {
      // 연구 진행 전: 초기 연구 승인을 기다리는 조직의 Lead가 실제 OpenCode로 돈다.
      const planning = await create("계획 조직");
      const planningLead = planning.agents.find((a) => a.role === "lead")!;
      await useOpenCode(planning.id, planningLead.id);
      await say(planning.id, "계획 단계 확인");
      await t.drain();
      expect((await runsOf(planning.id, planningLead.id))[0]).toMatchObject({
        status: "completed",
        error: null,
      });
      const [planned] = requestsOf(planning.id, []);
      expect(
        toolNames(planned!).some((n) => n.endsWith("get_run_context"))
      ).toBe(true);
      expect(artifactPath(planned!)).toBeUndefined();

      // 연구 단계: 초기 연구 승인을 받은 조직 둘. 조직 A는 Lead와 작업자 하나, 조직 B는 Lead가 실제 OpenCode로 돈다.
      const a = await researching(agents, "조직 A");
      const b = await researching(agents, "조직 B");
      const worker = a.workers[0]!;
      agents.queue(
        a.lead.id,
        calls({
          tool: "create_task",
          input: { title: "근거 정리", assigneeAgentId: worker.id },
        })
      );
      await say(a.id, "작업 분담");
      await t.drain();
      const task = taskListSchema.parse(
        await get(`/api/organizations/${a.id}/tasks`)
      )[0]!;
      await useOpenCode(a.id, a.lead.id);
      await useOpenCode(a.id, worker.id);
      await useOpenCode(b.id, b.lead.id);
      const limit = await t.request("PUT", "/api/providers/opencode/limit", {
        maxConcurrentRuns: 3,
      });
      expect(limit.status).toBe(200);

      // 같은 조직의 서로 다른 에이전트와 다른 조직의 Lead가 동시에 돈다.
      await Promise.all([
        say(a.id, "조직 A 첫 질문"),
        comment(a.id, task.id, "조직 A 작업자 첫 댓글"),
        say(b.id, "조직 B 첫 질문"),
      ]);
      await t.drain();
      // 이어서 각자 후속 실행 시도.
      await Promise.all([
        say(a.id, "조직 A 후속 질문"),
        comment(a.id, task.id, "조직 A 작업자 후속 댓글"),
        say(b.id, "조직 B 후속 질문"),
      ]);
      await t.drain();

      const concurrent = [
        [a.id, a.lead.id],
        [a.id, worker.id],
        [b.id, b.lead.id],
      ] as const;
      const runsPerAgent = await Promise.all(
        concurrent.map(([orgId, agentId]) => runsOf(orgId, agentId))
      );
      for (const [index, runs] of runsPerAgent.entries()) {
        const agentId = concurrent[index]![1];
        expect(runs).toHaveLength(2);
        for (const run of runs)
          expect(run, agentId).toMatchObject({
            status: "completed",
            error: null,
          });
      }
      // 첫 실행 시도 셋은 실제로 겹쳤다.
      // 목록은 최근 순이므로 마지막이 첫 실행 시도다.
      const firstRuns = runsPerAgent.map((runs) => runs.at(-1)!);
      const latestStart = Math.max(
        ...firstRuns.map((r) => Date.parse(r.startedAt))
      );
      const earliestEnd = Math.min(
        ...firstRuns.map((r) => Date.parse(r.finishedAt!))
      );
      expect(latestStart).toBeLessThan(earliestEnd);

      const ofA = requestsOf(a.id, [b.id, planning.id]);
      const ofB = requestsOf(b.id, [a.id, planning.id]);
      for (const request of [...ofA, ...ofB]) {
        // 연구 단계 도구에는 record_artifact가 있고, 경로 규칙은 모델 서비스가 받은 `\x00` 표기다.
        expect(artifactPath(request)?.path).toMatchObject({
          type: "string",
          maxLength: 4096,
          pattern: "^[^\\x00]*$",
        });
        expect(request.raw).not.toContain(refusedPattern);
      }
      // 후속 실행 시도는 같은 세션을 이어 가 앞선 대화를 함께 보낸다. 다른 에이전트의 대화는 섞이지 않는다.
      const leadFollowUp = ofA.find((r) =>
        userText(r).includes("조직 A 후속 질문")
      )!;
      expect(userText(leadFollowUp)).toContain("조직 A 첫 질문");
      expect(userText(leadFollowUp)).not.toContain("작업자");
      const workerFollowUp = ofA.find((r) =>
        userText(r).includes("작업자 후속 댓글")
      )!;
      expect(userText(workerFollowUp)).toContain("작업자 첫 댓글");
      expect(userText(workerFollowUp)).not.toContain("조직 A 첫 질문");
      const bFollowUp = ofB.find((r) =>
        userText(r).includes("조직 B 후속 질문")
      )!;
      expect(userText(bFollowUp)).toContain("조직 B 첫 질문");

      // 조직 상태·승인은 그대로다. 실행 시도가 조직을 끝내거나 승인을 바꾸지 않는다.
      for (const orgId of [a.id, b.id])
        expect(
          organizationDetailSchema.parse(
            await get(`/api/organizations/${orgId}`)
          ).stage
        ).toBe("researching");
      expect(
        organizationDetailSchema.parse(
          await get(`/api/organizations/${planning.id}`)
        ).stage
      ).toBe("awaiting_approval");
    });

    // #150: 실제 OpenCode가 이 제품의 plugin으로 조직 쓰기 도구 호출마다 같은 호출 키를 MCP `params._meta`에 넣는다.
    // 가짜 모델은 한 응답에 내용이 같은 send_message 두 개를 병렬로 내고, 다음 메시지에도 같은 호출 ID로 같은 내용을 낸다.
    it("injects a separate call key into every organization write call without touching the tool input, also for parallel calls and a resumed session", async () => {
      const org = await researching(agents, "호출 키 조직");
      await useOpenCode(org.id, org.lead.id);
      const marker = "#150-keys";
      const sendName = (request: ModelRequest) =>
        toolNames(request).find((n) => n.endsWith("send_message"))!;
      model.respondWithTools((request) =>
        wakeText(request).includes(marker)
          ? [
              {
                id: "call_a",
                name: sendName(request),
                arguments: { body: "같은 내용" },
              },
              {
                id: "call_b",
                name: sendName(request),
                arguments: { body: "같은 내용" },
              },
            ]
          : undefined
      );
      try {
        await say(org.id, `${marker} 첫 번째`);
        await t.drain();
        await say(org.id, `${marker} 이어서`);
        await t.drain();
      } finally {
        model.respondWithTools(undefined);
      }
      const runs = await runsOf(org.id, org.lead.id);
      expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
      const opencodeRuns = new Set(runs.map((r) => r.id));
      const intents = (await intentsOf(t.db, org.lead.id)).filter(
        (i) => i.tool === "send_message" && opencodeRuns.has(i.runId)
      );
      // 네 호출 모두 키가 있고 서로 다르다. 같은 호출 ID라도 다음 assistant 메시지의 호출은 새 실행 의도다.
      expect(intents).toHaveLength(4);
      for (const intent of intents) {
        expect(intent.key).toMatch(/^oc1:[0-9a-f]{64}$/);
        expect(intent.status).toBe("completed");
        // 모델이 준 입력 그대로다. 키나 `_meta`가 도구 입력에 섞이지 않았다.
        expect(JSON.parse(intent.request!)).toEqual({
          params: {},
          body: { body: "같은 내용" },
        });
      }
      expect(new Set(intents.map((i) => i.key)).size).toBe(4);
      expect(new Set(intents.map((i) => i.runId))).toEqual(opencodeRuns);
      const replies = conversationPageSchema
        .parse(await get(`/api/organizations/${org.id}/messages`))
        .messages.filter((m) => m.author === "agent" && m.body === "같은 내용");
      expect(replies).toHaveLength(4);
      // 모델은 각 호출의 결과(저장된 메시지)를 도구 결과로 받았다.
      const followUps = mainRequests(model.requests).filter(
        (r) =>
          r.body.messages?.at(-1)?.role === "tool" &&
          userText(r).includes(org.id)
      );
      expect(followUps).toHaveLength(2);
      for (const request of followUps)
        expect(
          request.body.messages!.filter((m) => m.role === "tool").length
        ).toBeGreaterThanOrEqual(2);
    });

    it("ends a refused request as a failed attempt with a safe reason, once, and an authentication refusal as login required", async () => {
      const org = await researching(agents, "거부 조직");
      await useOpenCode(org.id, org.lead.id);
      const secretInput = "비공개 연구 입력";
      await say(org.id, `${rejectMarker} ${secretInput}`);
      await t.drain();
      const [refused] = await runsOf(org.id, org.lead.id);
      expect(refused).toMatchObject({
        status: "failed",
        error:
          "모델 서비스가 요청을 거부했습니다(HTTP 400). 도구 정의나 입력이 이 모델과 맞지 않을 수 있습니다.",
      });
      // 같은 요청을 다시 보내지 않았다.
      expect(
        mainRequests(model.requests).filter(
          (r) =>
            wakeText(r).includes(rejectMarker) && userText(r).includes(org.id)
        )
      ).toHaveLength(1);

      await say(org.id, `${authMarker} ${secretInput}`);
      await t.drain();
      const [denied] = await runsOf(org.id, org.lead.id);
      expect(denied).toMatchObject({
        status: "failed",
        error:
          "모델 서비스가 인증을 거부했습니다(HTTP 401). 프로바이더 로그인을 확인해 주세요.",
      });

      // 원문 오류(합성 비밀값·되돌려 준 연구 입력)는 실행 시도 상세·목록·Event 어디에도 없다.
      const published = JSON.stringify([
        await get(`/api/organizations/${org.id}/runs`),
        await get(`/api/organizations/${org.id}/runs/${refused!.id}`),
        await get(`/api/organizations/${org.id}/runs/${denied!.id}`),
        await get(`/api/organizations/${org.id}/events`),
      ]);
      expect(published).not.toContain(modelSecret);
      expect(published).not.toContain("upstream_rejected_request");
      expect(published).not.toContain("invalid_api_key");

      // 거부 뒤에도 조직은 그대로 다음 메시지를 처리한다.
      await say(org.id, "거부 뒤 질문");
      await t.drain();
      expect((await runsOf(org.id, org.lead.id))[0]).toMatchObject({
        status: "completed",
      });
    });
  }
);
