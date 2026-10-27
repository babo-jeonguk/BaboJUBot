import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  addResearchLinkInputSchema,
  addTaskCommentInputSchema,
  agentCommands,
  artifactContentMaxLength,
  changeResearchNodeParentInputSchema,
  createResearchNodeInputSchema,
  emptyCommandInputSchema,
  instructionMaxBytes,
  updateResearchNodeInputSchema,
  createOrganizationInputSchema,
  decideApprovalInputSchema,
  decideResultInputSchema,
  editInstructionCopyInputSchema,
  eventStreamPath,
  inboxItemKindSchema,
  organizationCommands,
  orgToolsBasePath,
  sendOwnerMessageInputSchema,
  timeZoneSchema,
  updateApprovalPolicyInputSchema,
  updateHeartbeatInputSchema,
  updateInboxItemInputSchema,
  type NotificationChannel,
  type RuntimeAdapter,
  type StreamFrame,
  type StreamScope,
} from "@babojubot/contracts";
import {
  findAgentDetail,
  findAgentInstructions,
  findApproval,
  findArtifact,
  findFakeChannelMessage,
  findFlowTemplate,
  findInstructionRevision,
  findOrganization,
  findResearchNodeDetail,
  findResultSubmission,
  findRunDetail,
  findTaskDetail,
  getOrganizationDashboard,
  getOverview,
  getResearchMap,
  listApprovals,
  listConversation,
  listFakeChannelMessages,
  listInbox,
  listInstructionRevisions,
  listOutbox,
  listOrganizationEvents,
  listOrganizations,
  listResultSubmissions,
  listRunningRuns,
  listRuns,
  listTasks,
  recordFakeChannelMessage,
  updateInboxItem,
  type Database,
  type MapCommand,
  type OwnerMapEditResult,
} from "@babojubot/db";
import { findLead } from "@babojubot/core";
import {
  createFakeChannel,
  createScriptedRuntime,
  replyThroughFakeChannel,
} from "@babojubot/runtime";
import express, { type ErrorRequestHandler } from "express";
import type { z } from "zod";
import { WebSocketServer, type WebSocket } from "ws";
import { decideApproval } from "./approvals.ts";
import { controlAgent, controlOrganization } from "./control.ts";
import { sendOwnerMessage } from "./conversation.ts";
import { RunDispatcher } from "./dispatcher.ts";
import { EventHub } from "./event-hub.ts";
import { defaultHarnessDir } from "./harness.ts";
import { HeartbeatScheduler, updateHeartbeat } from "./heartbeat.ts";
import { editInstructionCopyAsOwner } from "./instructions.ts";
import { createOrganization, updateApprovalPolicy } from "./organizations.ts";
import { NotificationRelay } from "./notifications.ts";
import { editResearchMapAsOwner } from "./research-map.ts";
import { decideResult } from "./results.ts";
import { addOwnerTaskComment } from "./tasks.ts";
import { problemResponses } from "./problems.ts";
import { orgToolsRouter } from "./tools.ts";

/**
 * JSON 요청 본문 크기 상한(바이트). 계약상 가장 큰 본문은 지침 사본 편집(UTF-8 {@link instructionMaxBytes}바이트)과
 * 산출물(최대 {@link artifactContentMaxLength}자)이다. 한 바이트(제어 문자)나 한 글자(UTF-16 code unit)는 JSON에서 최대
 * 6바이트(`\uXXXX`)이므로 그만큼과 나머지 필드의 여유를 둔다. 크기 제한은 Zod 계약이 맡고, 이 상한은 그 계약을 막지 않는 바깥 경계다.
 */
export const jsonBodyLimitBytes =
  Math.max(artifactContentMaxLength, instructionMaxBytes) * 6 + 64 * 1024;

export type ServerOptions = {
  db: Database;
  port: number;
  host?: string;
  /** 빌드한 대시보드. 있으면 API 밖의 경로에 SPA로 제공한다. */
  webDistDir?: string;
  /** 실행기 adapter. 첫 판은 가짜 실행기뿐이고, 테스트는 시나리오를 주입한다. */
  runtime?: RuntimeAdapter;
  /** 기록 시각에 쓰는 시계. 테스트가 주입한다. */
  now?: () => Date;
  /** 하네스 라이브러리 디렉터리. 기본은 저장소의 `harness/`. */
  harnessDir?: string;
  /** 지난 heartbeat를 확인하는 간격(ms). heartbeat 간격은 분 단위이므로 그보다 충분히 짧다. */
  heartbeatPollMs?: number;
  /** 알림을 보낼 메시지 앱 채널. 첫 판은 가짜 채널뿐이고, 테스트는 실패하는 채널을 주입한다. */
  notificationChannel?: NotificationChannel;
  /** 신호 없이 알림 outbox를 확인하는 간격(ms). 실패한 전송의 재시도 예정도 이때 확인한다. */
  notificationPollMs?: number;
};

export type RunningServer = {
  url: string;
  /** 깨우기 대기열이 비고 실행 중인 실행 시도가 모두 끝날 때까지 기다린다. 테스트 helper. */
  drain: () => Promise<void>;
  /** 주입한 시계의 지금 시각으로 지난 heartbeat를 처리한다. 테스트 helper(서버는 주기적으로 스스로 확인한다). */
  tickHeartbeats: () => Promise<void>;
  /** 주입한 시계의 지금 시각으로 보낼 차례인 알림을 모두 보내 본다. 테스트 helper(서버는 스스로 보낸다). */
  deliverNotifications: () => Promise<void>;
  /** 진행 중인 실행 시도를 취소하고 실행기가 정리를 끝낸 뒤 서버를 닫는다. DB는 닫지 않는다. */
  close: () => Promise<void>;
};

export async function startServer({
  db,
  port,
  host = "127.0.0.1",
  webDistDir,
  runtime = createScriptedRuntime(),
  now = () => new Date(),
  harnessDir = defaultHarnessDir,
  heartbeatPollMs = 5_000,
  notificationChannel = createFakeChannel((n) =>
    recordFakeChannelMessage(db, n)
  ),
  notificationPollMs = 5_000,
}: ServerOptions): Promise<RunningServer> {
  const hub = new EventHub();
  let url = "";
  const dispatcher = new RunDispatcher({
    db,
    hub,
    runtime,
    now,
    toolsBaseUrl: () => url,
  });
  const heartbeats = new HeartbeatScheduler({
    db,
    hub,
    dispatcher,
    now,
    pollMs: heartbeatPollMs,
  });
  const notifications = new NotificationRelay({
    db,
    hub,
    channel: notificationChannel,
    now,
    pollMs: notificationPollMs,
  });
  const app = express();
  app.use(express.json({ limit: jsonBodyLimitBytes }));
  app.use(
    orgToolsBasePath,
    orgToolsRouter({ db, hub, dispatcher, now, harnessDir })
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/organizations", async (_req, res) => {
    res.json(await listOrganizations(db));
  });

  app.post("/api/organizations", async (req, res) => {
    const input = createOrganizationInputSchema.safeParse(req.body);
    if (!input.success) {
      res
        .status(422)
        .json({ error: { code: "invalid_input", issues: input.error.issues } });
      return;
    }
    res
      .status(201)
      .json(await createOrganization({ db, hub, harnessDir }, input.data));
  });

  /** 홈 개요. 모든 조직의 진행 중 실행 시도 수와 합계(취소 정리 중은 따로 센 수도). */
  app.get("/api/overview", async (_req, res) => {
    res.json(await getOverview(db, now()));
  });

  /** Inbox. 모든 조직의 승인 요청·결과 제출(결정한 것 포함)과 실패한 실행 시도, 각 항목의 읽음·보관. */
  app.get("/api/inbox", async (_req, res) => {
    res.json(await listInbox(db));
  });

  /**
   * 알림 정리 명령(읽음·보관). 준 값을 그대로 대입하고 정리 뒤 상태를 돌려준다. 원본의 결정·단계·깨우기는 바뀌지 않는다.
   * 다른 조직의 원본, 없는 원본·종류는 404다. 결정을 기다리는 승인 요청·결과 제출의 보관은 422 `archive_not_allowed`다.
   * 사용자 API에는 아직 인증이 없다(로컬 신뢰 운영, README 참고).
   */
  app.put("/api/organizations/:id/inbox/:kind/:sourceId", async (req, res) => {
    const kind = inboxItemKindSchema.safeParse(req.params.kind);
    if (!kind.success) return notFound(res);
    const input = updateInboxItemInputSchema.safeParse(req.body);
    if (!input.success) {
      res.status(422).json({
        error: { code: "invalid_input", issues: input.error.issues },
      });
      return;
    }
    const result = await updateInboxItem(
      db,
      req.params.id,
      kind.data,
      req.params.sourceId,
      input.data
    );
    if (result.kind === "not_found") return notFound(res);
    if (result.kind === "archive_not_allowed") {
      res.status(422).json({ error: { code: "archive_not_allowed" } });
      return;
    }
    if (result.event) hub.publish(result.event);
    res.json(result.state);
  });

  /** 알림 outbox와 각 항목의 전송 상태. 쌓인 순서다. */
  app.get("/api/notifications", async (_req, res) => {
    res.json(await listOutbox(db));
  });

  /** 가짜 채널이 받은 알림의 전송 기록. 받은 순서다. */
  app.get("/api/channels/fake/messages", async (_req, res) => {
    res.json(await listFakeChannelMessages(db));
  });

  /**
   * 가짜 채널의 알림에 사용자가 답한다. 승인 요청 알림에만 승인 결정 입력으로 답하며, 대시보드와 같은 승인 결정 명령으로
   * 보내 그 응답(200·409·422 등)을 그대로 돌려준다. 다른 알림은 422 `reply_not_allowed`다.
   */
  app.post("/api/channels/fake/messages/:messageId/reply", async (req, res) => {
    const message = await findFakeChannelMessage(db, req.params.messageId);
    if (!message) return notFound(res);
    const result = await replyThroughFakeChannel(url, message, req.body);
    if (result.kind === "reply_not_allowed") {
      res.status(422).json({ error: { code: "reply_not_allowed" } });
      return;
    }
    if (result.kind === "invalid_input") {
      res
        .status(422)
        .json({ error: { code: "invalid_input", issues: result.issues } });
      return;
    }
    res.status(result.status).json(result.body);
  });

  app.get("/api/organizations/:id", async (req, res) => {
    const org = await findOrganization(db, req.params.id);
    if (!org) return notFound(res);
    res.json(org);
  });

  /**
   * 승인 정책 변경 제어 명령. 사용자만 바꾸며 조직 도구가 없다. 바꾼 뒤의 조직을 돌려주고, 값이 그대로면 아무것도 남기지 않는다.
   * 사용자 API에는 아직 인증이 없다(로컬 신뢰 운영, README 참고).
   */
  app.put("/api/organizations/:id/approval-policy", async (req, res) => {
    const input = updateApprovalPolicyInputSchema.safeParse(req.body);
    if (!input.success) {
      res
        .status(422)
        .json({ error: { code: "invalid_input", issues: input.error.issues } });
      return;
    }
    const result = await updateApprovalPolicy(
      { db, hub },
      req.params.id,
      input.data
    );
    if (result.kind === "not_found") return notFound(res);
    res.json(result.organization);
  });

  /** 본문 없는 제어 명령의 입력 검사. 다른 입력 오류와 같은 응답 모양이다. */
  const emptyCommand = (req: express.Request, res: express.Response) => {
    const input = emptyCommandInputSchema.safeParse(req.body ?? {});
    if (!input.success)
      res
        .status(422)
        .json({ error: { code: "invalid_input", issues: input.error.issues } });
    return input.success;
  };

  /**
   * 조직 일시정지·재개·중단 제어 명령. 사용자만 내리며 조직 도구가 없다. 명령 뒤의 조직을 돌려주고, 이미 그 상태면 아무것도 남기지 않는다.
   * 최종 완료·중단 조직은 409 `organization_closed`다(이미 중단한 조직의 중단은 그대로 둔다).
   */
  for (const command of organizationCommands)
    app.post(`/api/organizations/:id/${command}`, async (req, res) => {
      if (!emptyCommand(req, res)) return;
      const result = await controlOrganization(
        { db, hub, dispatcher },
        req.params.id,
        command
      );
      if (result.kind === "not_found") return notFound(res);
      if (result.kind === "organization_closed") return closed(res);
      res.json(result.value);
    });

  /** 에이전트 일시정지·재개 제어 명령. 명령 뒤의 에이전트 상세를 돌려준다. 끝난 조직의 에이전트는 409 `organization_closed`다. */
  for (const command of agentCommands)
    app.post(
      `/api/organizations/:id/agents/:agentId/${command}`,
      async (req, res) => {
        if (!emptyCommand(req, res)) return;
        const result = await controlAgent(
          { db, hub, dispatcher },
          req.params.id,
          req.params.agentId,
          command
        );
        if (result.kind === "not_found") return notFound(res);
        if (result.kind === "organization_closed") return closed(res);
        res.json(result.value);
      }
    );

  /**
   * 에이전트 heartbeat 설정 변경. 사용자만 바꾸며 조직 도구가 없다. 변경 뒤의 에이전트 상세를 돌려주고, 값이 그대로면 아무것도 남기지 않는다.
   * 일시정지 중에도 바꿀 수 있고, 최종 완료·중단 조직은 409 `organization_closed`다.
   */
  app.put(
    "/api/organizations/:id/agents/:agentId/heartbeat",
    async (req, res) => {
      const input = updateHeartbeatInputSchema.safeParse(req.body);
      if (!input.success) {
        res.status(422).json({
          error: { code: "invalid_input", issues: input.error.issues },
        });
        return;
      }
      const result = await updateHeartbeat(
        { db, hub, now },
        req.params.id,
        req.params.agentId,
        input.data
      );
      if (result.kind === "not_found") return notFound(res);
      if (result.kind === "organization_closed") return closed(res);
      res.json(result.agent);
    }
  );

  /**
   * 조직 대시보드 요약. `timeZone`(IANA 이름, 기본 UTC)의 달력 날짜로 오늘까지 14일을 자른다.
   * 서버가 모르는 시간대는 422 `invalid_time_zone`이다.
   */
  app.get("/api/organizations/:id/dashboard", async (req, res) => {
    const timeZone = timeZoneSchema.safeParse(
      queryString(req.query.timeZone) ?? "UTC"
    );
    const result = timeZone.success
      ? await getOrganizationDashboard(db, req.params.id, {
          now: now(),
          timeZone: timeZone.data,
        })
      : ({ kind: "invalid_time_zone" } as const);
    if (result.kind === "not_found") return notFound(res);
    if (result.kind === "invalid_time_zone") {
      res.status(422).json({ error: { code: "invalid_time_zone" } });
      return;
    }
    res.json(result.dashboard);
  });

  app.get("/api/organizations/:id/events", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(
      await listOrganizationEvents(db, req.params.id, {
        agentId: queryString(req.query.agentId),
      })
    );
  });

  app.get("/api/organizations/:id/messages", async (req, res) => {
    const org = await findOrganization(db, req.params.id);
    const lead = org && findLead(org.agents);
    if (!org || !lead) return notFound(res);
    res.json(await listConversation(db, org.id, lead.id));
  });

  app.post("/api/organizations/:id/messages", async (req, res) => {
    const org = await findOrganization(db, req.params.id);
    if (!org) return notFound(res);
    const input = sendOwnerMessageInputSchema.safeParse(req.body);
    if (!input.success) {
      res
        .status(422)
        .json({ error: { code: "invalid_input", issues: input.error.issues } });
      return;
    }
    const sent = await sendOwnerMessage(
      { db, hub, dispatcher, now },
      org,
      input.data
    );
    if (sent.kind === "organization_closed") return closed(res);
    res.status(201).json(sent.message);
  });

  // `?status=running`은 최근 목록과 달리 진행 중 실행 시도를 모두 돌려준다(대시보드의 실행 중·취소 정리 중 개수).
  app.get("/api/organizations/:id/runs", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(
      req.query.status === "running"
        ? await listRunningRuns(db, req.params.id)
        : await listRuns(db, req.params.id, {
            agentId: queryString(req.query.agentId),
          })
    );
  });

  app.get("/api/organizations/:id/runs/:runId", async (req, res) => {
    const run = await findRunDetail(db, req.params.id, req.params.runId);
    if (!run) return notFound(res);
    res.json(run);
  });

  app.get("/api/organizations/:id/agents/:agentId", async (req, res) => {
    const agent = await findAgentDetail(db, req.params.id, req.params.agentId);
    if (!agent) return notFound(res);
    res.json(agent);
  });

  /** 에이전트의 Role·Soul·Skill 사본과 지금 revision 번호, 그 내용의 지침 bundle 버전. */
  app.get(
    "/api/organizations/:id/agents/:agentId/instructions",
    async (req, res) => {
      const found = await findAgentInstructions(
        db,
        req.params.id,
        req.params.agentId
      );
      if (!found) return notFound(res);
      res.json(found);
    }
  );

  const copyRef = (req: express.Request) => ({
    organizationId: String(req.params.id),
    agentId: String(req.params.agentId),
    copyId: String(req.params.copyId),
  });

  /**
   * 사용자의 사본 편집(본문 전체). 사용자만 고치며 조직 도구가 없다. 저장마다 revision을 남기고 편집 사유로 Lead를 깨우며,
   * 바뀐 사본을 돌려준다. 편집을 시작한 revision이 지금 것이 아니면 409 `revision_conflict`, 최종 완료·중단 조직은
   * 409 `organization_closed`, 라이브러리처럼 읽을 수 없는 Skill frontmatter는 422 `invalid_skill`이다.
   */
  app.put(
    "/api/organizations/:id/agents/:agentId/instructions/:copyId",
    async (req, res) => {
      const input = editInstructionCopyInputSchema.safeParse(req.body);
      if (!input.success) {
        res.status(422).json({
          error: { code: "invalid_input", issues: input.error.issues },
        });
        return;
      }
      const result = await editInstructionCopyAsOwner(
        { db, hub, dispatcher, now },
        copyRef(req),
        input.data
      );
      switch (result.kind) {
        case "ok":
          res.json(result.copy);
          return;
        case "not_found":
          return notFound(res);
        case "organization_closed":
          return closed(res);
        case "revision_conflict":
          res.status(409).json({ error: { code: "revision_conflict" } });
          return;
        case "invalid_skill":
          res.status(422).json({ error: { code: "invalid_skill" } });
          return;
      }
    }
  );

  /** 사본의 revision 목록(최근 것부터, 본문 없음). */
  app.get(
    "/api/organizations/:id/agents/:agentId/instructions/:copyId/revisions",
    async (req, res) => {
      const list = await listInstructionRevisions(db, copyRef(req));
      if (!list) return notFound(res);
      res.json(list);
    }
  );

  /** 사본 revision 하나의 전체 본문. 읽기 전용이다. */
  app.get(
    "/api/organizations/:id/agents/:agentId/instructions/:copyId/revisions/:number",
    async (req, res) => {
      const number = /^[1-9]\d*$/.test(req.params.number)
        ? Number(req.params.number)
        : 0;
      const revision = await findInstructionRevision(db, copyRef(req), number);
      if (!revision) return notFound(res);
      res.json(revision);
    }
  );

  app.get("/api/organizations/:id/flow-template", async (req, res) => {
    const template = await findFlowTemplate(db, req.params.id);
    if (!template) return notFound(res);
    res.json(template);
  });

  app.get("/api/organizations/:id/tasks", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(await listTasks(db, req.params.id));
  });

  app.get("/api/organizations/:id/tasks/:taskId", async (req, res) => {
    const task = await findTaskDetail(db, req.params.id, req.params.taskId);
    if (!task) return notFound(res);
    res.json(task);
  });

  /** 사용자의 작업 댓글. 그 작업 담당자를 깨운다. 사용자는 작업자와 작업 댓글로만 이야기한다. */
  app.post(
    "/api/organizations/:id/tasks/:taskId/comments",
    async (req, res) => {
      const input = addTaskCommentInputSchema.safeParse(req.body);
      if (!input.success) {
        res.status(422).json({
          error: { code: "invalid_input", issues: input.error.issues },
        });
        return;
      }
      const result = await addOwnerTaskComment(
        { db, hub, dispatcher, now },
        req.params.id,
        req.params.taskId,
        input.data.body
      );
      if (result.kind === "not_found") return notFound(res);
      res.status(201).json(result.comment);
    }
  );

  app.get("/api/organizations/:id/artifacts/:artifactId", async (req, res) => {
    const artifact = await findArtifact(
      db,
      req.params.id,
      req.params.artifactId
    );
    if (!artifact) return notFound(res);
    res.json(artifact);
  });

  app.get("/api/organizations/:id/research-map", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(await getResearchMap(db, req.params.id));
  });

  app.get("/api/organizations/:id/research-nodes/:nodeId", async (req, res) => {
    const node = await findResearchNodeDetail(
      db,
      req.params.id,
      req.params.nodeId
    );
    if (!node) return notFound(res);
    res.json(node);
  });

  /**
   * 사용자의 연구 지도 편집 하나: 입력 계약 → 명령 → 저장. 편집은 편집자(사용자)를 기록하고 Lead를 깨운다.
   * 초기 연구 승인 전·최종 완료·중단 단계에서는 409 `stage_closed`, 지도 규칙의 거부는 조직 도구와 같은 응답 코드다.
   */
  const mapEdit =
    <S extends z.ZodType>(
      schema: S,
      command: (input: z.infer<S>, req: express.Request) => MapCommand,
      status = 200
    ): express.RequestHandler =>
    async (req, res) => {
      const input = schema.safeParse(req.body ?? {});
      if (!input.success) {
        res.status(422).json({
          error: { code: "invalid_input", issues: input.error.issues },
        });
        return;
      }
      const result: OwnerMapEditResult<unknown> = await editResearchMapAsOwner(
        { db, hub, dispatcher, now },
        String(req.params.id),
        command(input.data, req)
      );
      if (result.kind === "stage_closed") {
        res.status(409).json({ error: { code: "stage_closed" } });
        return;
      }
      if (result.kind === "invalid") {
        const [code, httpStatus] = problemResponses[result.problem];
        res.status(httpStatus).json({ error: { code } });
        return;
      }
      res.status(status).json(result.value);
    };
  const nodeId = (req: express.Request) => String(req.params.nodeId);

  app.post(
    "/api/organizations/:id/research-nodes",
    mapEdit(
      createResearchNodeInputSchema,
      (input) => ({ op: "create_node", input }),
      201
    )
  );
  app.patch(
    "/api/organizations/:id/research-nodes/:nodeId",
    mapEdit(updateResearchNodeInputSchema, (input, req) => ({
      op: "update_node",
      nodeId: nodeId(req),
      input,
    }))
  );
  app.post(
    "/api/organizations/:id/research-nodes/:nodeId/parent",
    mapEdit(changeResearchNodeParentInputSchema, (input, req) => ({
      op: "change_parent",
      nodeId: nodeId(req),
      parentNodeId: input.parentNodeId,
    }))
  );
  app.post(
    "/api/organizations/:id/research-links",
    mapEdit(
      addResearchLinkInputSchema,
      (input) => ({ op: "add_link", input }),
      201
    )
  );
  for (const op of ["discard_node", "restore_node"] as const)
    app.post(
      `/api/organizations/:id/research-nodes/:nodeId/${op === "discard_node" ? "discard" : "restore"}`,
      mapEdit(emptyCommandInputSchema, (_input, req) => ({
        op,
        nodeId: nodeId(req),
      }))
    );

  app.get("/api/organizations/:id/approvals", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(await listApprovals(db, req.params.id));
  });

  app.get("/api/organizations/:id/approvals/:approvalId", async (req, res) => {
    const approval = await findApproval(
      db,
      req.params.id,
      req.params.approvalId
    );
    if (!approval) return notFound(res);
    res.json(approval);
  });

  /**
   * 승인 결정 제어 명령. 결정은 한 번만 할 수 있고, 이미 결정한 요청은 409 `already_decided`다.
   * 그 종류에 없는 결정(작업자 추가의 수정 요청)은 422 `decision_not_allowed`다.
   * 일시정지 중의 초기 연구 승인 결정은 조직을 재개하고, 중단된 조직의 초기 연구 승인 결정은 409 `organization_closed`다.
   */
  app.post(
    "/api/organizations/:id/approvals/:approvalId/decision",
    async (req, res) => {
      const input = decideApprovalInputSchema.safeParse(req.body);
      if (!input.success) {
        res.status(422).json({
          error: { code: "invalid_input", issues: input.error.issues },
        });
        return;
      }
      const result = await decideApproval(
        { db, hub, dispatcher, now },
        req.params.id,
        req.params.approvalId,
        input.data
      );
      if (result.kind === "not_found") return notFound(res);
      if (result.kind === "already_decided") {
        res.status(409).json({ error: { code: "already_decided" } });
        return;
      }
      if (result.kind === "decision_not_allowed") {
        res.status(422).json({ error: { code: "decision_not_allowed" } });
        return;
      }
      if (result.kind === "organization_closed") return closed(res);
      res.json(result.approval);
    }
  );

  app.get("/api/organizations/:id/results", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(await listResultSubmissions(db, req.params.id));
  });

  app.get("/api/organizations/:id/results/:submissionId", async (req, res) => {
    const submission = await findResultSubmission(
      db,
      req.params.id,
      req.params.submissionId
    );
    if (!submission) return notFound(res);
    res.json(submission);
  });

  /**
   * 결과 검토 제어 명령: 수정 요청 또는 최종 완료. 최종 완료는 이 사용자 명령으로만 일어나며 조직 도구가 없다.
   * 결정은 한 번만 할 수 있고, 이미 결정한 제출(재제출 뒤의 옛 제출 포함)은 409 `already_decided`다.
   * 일시정지 중의 결정은 조직을 재개하고(최종 완료는 곧바로 완료), 중단된 조직은 409 `organization_closed`다.
   * 사용자 API에는 아직 인증이 없다(로컬 신뢰 운영, README 참고).
   */
  app.post(
    "/api/organizations/:id/results/:submissionId/decision",
    async (req, res) => {
      const input = decideResultInputSchema.safeParse(req.body);
      if (!input.success) {
        res.status(422).json({
          error: { code: "invalid_input", issues: input.error.issues },
        });
        return;
      }
      const result = await decideResult(
        { db, hub, dispatcher, now },
        req.params.id,
        req.params.submissionId,
        input.data
      );
      if (result.kind === "not_found") return notFound(res);
      if (result.kind === "already_decided") {
        res.status(409).json({ error: { code: "already_decided" } });
        return;
      }
      if (result.kind === "organization_closed") return closed(res);
      res.json(result.submission);
    }
  );

  app.use("/api", (_req, res) => notFound(res));

  if (webDistDir && fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.join(webDistDir, "index.html"))
    );
  }

  app.use(((error, _req, res, _next) => {
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "invalid_json" } });
      return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: { code: "body_too_large" } });
      return;
    }
    console.error("[server]", error);
    res.status(500).json({ error: { code: "internal" } });
  }) satisfies ErrorRequestHandler);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    void upgrade(req, socket, head).catch((error) => {
      console.error("[event-stream]", error);
      refuse(socket, 500);
    });
  });

  async function upgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== eventStreamPath) return refuse(socket, 404);
    if (!isSameOrigin(req)) return refuse(socket, 403);
    const organizationId = url.searchParams.get("organizationId");
    let scope: StreamScope = { kind: "all" };
    if (organizationId !== null) {
      if (!(await findOrganization(db, organizationId)))
        return refuse(socket, 404);
      scope = { kind: "organization", organizationId };
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, scope));
  }

  function attach(ws: WebSocket, scope: StreamScope) {
    const send = (frame: StreamFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const unsubscribe = hub.subscribe(scope, (event) =>
      send({ type: "event", event })
    );
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
    send({ type: "ready" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as net.AddressInfo;
  url = `http://${host}:${address.port}`;
  try {
    // 남은 실행 시도 복구가 끝난 뒤에 heartbeat가 새 깨우기를 만든다.
    await dispatcher.start();
    heartbeats.start();
    notifications.start();
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    url,
    drain: () => dispatcher.drain(),
    tickHeartbeats: () => heartbeats.tick(),
    deliverNotifications: () => notifications.flush(),
    close: async () => {
      await heartbeats.close();
      await dispatcher.close();
      // 실행 시도를 끝내며 쌓인 알림은 outbox에 남아 다음 시작에 보낸다.
      await notifications.close();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const queryString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

function notFound(res: express.Response) {
  res.status(404).json({ error: { code: "not_found" } });
}

/** 최종 완료·중단 조직이라 받을 수 없는 제어 명령·결정. */
function closed(res: express.Response) {
  res.status(409).json({ error: { code: "organization_closed" } });
}

/**
 * 브라우저는 WebSocket에 동일 출처 정책을 적용하지 않으므로, 다른 사이트의 페이지가 Event stream을 읽지 못하게 한다.
 * Origin이 없는 연결(브라우저가 아닌 client)은 허용한다. 인증은 하지 않는다.
 */
function isSameOrigin(req: http.IncomingMessage) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number) {
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
}
