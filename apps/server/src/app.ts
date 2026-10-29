import { randomUUID } from "node:crypto";
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
  markConversationReadInputSchema,
  organizationCommands,
  orgToolsBasePath,
  sendOwnerMessageInputSchema,
  editQueuedMessageInputSchema,
  conversationPageQuerySchema,
  timeZoneSchema,
  updateAgentProfileInputSchema,
  updateApprovalPolicyInputSchema,
  updateHeartbeatInputSchema,
  updateInboxItemInputSchema,
  type ChannelAnswer,
  type ChannelReplyResult,
  type ChannelResponse,
  type ChannelRoute,
  type Conversation,
  type NotificationChannel,
  type OrganizationDetail,
  type RuntimeAdapter,
  type SendOwnerMessageInput,
  type StreamFrame,
  type StreamScope,
} from "@babojubot/contracts";
import {
  controlAgent,
  controlOrganization,
  decideApproval,
  decideResult,
  editInstructionCopy,
  editQueuedMessage,
  editResearchMap,
  findAgentDetail,
  findAgentInstructions,
  findApproval,
  findArtifact,
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
  findConversation,
  findDefaultConversation,
  listConversationPage,
  listQueuedMessages,
  listConversations,
  markConversationRead,
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
  insertOrganizationCreation,
  insertOwnerMessage,
  insertOwnerTaskComment,
  recordFakeChannelMessage,
  sendQueuedMessageNow,
  updateAgentProfile,
  updateApprovalPolicy,
  updateHeartbeat,
  updateInboxItem,
  withdrawQueuedMessage,
  type Database,
  type MapCommand,
  type Stored,
} from "@babojubot/db";
import {
  findLead,
  planOrganizationCreation,
  planOwnerMessage,
} from "@babojubot/core";
import { createFakeChannel, createScriptedRuntime } from "@babojubot/runtime";
import express, { type ErrorRequestHandler } from "express";
import type { z } from "zod";
import { WebSocketServer, type WebSocket } from "ws";
import { completeStored, type Outcome } from "./after-commit.ts";
import { channelInlet } from "./channel-replies.ts";
import { RunDispatcher } from "./dispatcher.ts";
import { EventHub } from "./event-hub.ts";
import {
  defaultHarnessDir,
  leadRoleOf,
  loadHarnessLibrary,
} from "./harness.ts";
import { HeartbeatScheduler } from "./heartbeat.ts";
import { NotificationRelay } from "./notifications.ts";
import { ownerRefusalResponses, type OwnerRefusal } from "./problems.ts";
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
  /**
   * 알림을 보내고 답을 받는 메시지 앱 채널. 목록으로 받지만 지금은 하나만 허용하며 둘 이상이면 시작 오류다
   * (여러 채널 동시 전송은 후속). 기본은 가짜 채널이고, 테스트는 실패하는 채널을 주입한다.
   */
  notificationChannels?: NotificationChannel[];
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
  /**
   * 진행 중인 실행 시도를 취소하고 실행기가 정리를 끝낸 뒤 서버를 닫는다. DB는 닫지 않는다.
   * 한 부분을 닫다 실패해도 나머지를 닫고, 모두 닫은 뒤 그 실패들을 던진다.
   */
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
  notificationChannels = [
    createFakeChannel({
      record: (n) => recordFakeChannelMessage(db, n),
      list: () => listFakeChannelMessages(db),
      respond: fakeChannelResponse,
    }),
  ],
  notificationPollMs = 5_000,
}: ServerOptions): Promise<RunningServer> {
  if (notificationChannels.length !== 1)
    throw new Error(
      `exactly one notification channel is supported, got ${notificationChannels.length}`
    );
  const channel = notificationChannels[0]!;
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
    channel,
    now,
    pollMs: notificationPollMs,
  });
  const source = { newId: randomUUID, now };
  /**
   * 사용자가 한 일 하나: 저장한 뒤 commit 뒤 할 일(Event 알리기·취소·조직 재개·깨우기)을 하고 돌려줄 값 또는 거부 이유를 돌려준다.
   * 사용자 HTTP 경로가 모두 이 길을 쓴다. 알림이 실패해도 저장된 결과는 그대로다.
   */
  const complete = async <T, R extends string>(result: Promise<Stored<T, R>>) =>
    completeStored({ hub, dispatcher }, await result);
  /**
   * Lead 대화에 사용자 메시지를 남긴다. `conversation`은 같은 조직의 대화(호출한 쪽이 조직 안에서 찾은 것)이고, `new`면 이 메시지로
   * 새 대화를 시작한다. 새 대화는 메시지와 같은 transaction에 남으므로 메시지를 받지 않으면 대화도 남지 않는다.
   * Lead가 실행 중이면 메시지는 다음 실행 시도에 반영된다. `중단하고 보내기`면 commit 뒤 진행 중 실행 시도에 취소를 보내고,
   * 그 실행 시도가 정리를 끝내면 다음 실행 시도가 메시지를 받는다.
   */
  const sendOwnerMessage = (
    organization: OrganizationDetail,
    conversation: Pick<Conversation, "id"> | "new",
    input: Required<SendOwnerMessageInput>
  ) =>
    complete(
      insertOwnerMessage(
        db,
        planOwnerMessage(
          { organizationId: organization.id, agents: organization.agents },
          conversation,
          input,
          source
        )
      )
    );

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

  /**
   * 조직 생성. 사용자가 적은 연구 목표·완료 기준과 함께 조직·Lead·Lead의 Role·Soul 사본·Lead 깨우기·Event를 한 transaction으로
   * 저장한 뒤에만 Event를 알리고 Lead의 실행 시도를 촉진한다. Lead 사본과 기본 heartbeat 간격은 지금의 하네스 라이브러리 Lead Role에서 받는다.
   */
  app.post("/api/organizations", async (req, res) => {
    const input = parseInput(res, createOrganizationInputSchema, req.body);
    if (!input) return;
    const library = await loadHarnessLibrary(harnessDir);
    const creation = planOrganizationCreation(input, leadRoleOf(library), {
      newId: randomUUID,
      now: () => new Date(),
    });
    respond(res, await complete(insertOrganizationCreation(db, creation)), 201);
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
    if (!kind.success) return refuseOwner(res, "not_found");
    const input = parseInput(res, updateInboxItemInputSchema, req.body);
    if (!input) return;
    respond(
      res,
      await complete(
        updateInboxItem(
          db,
          req.params.id,
          kind.data,
          req.params.sourceId,
          input
        )
      )
    );
  });

  /** 알림 outbox와 각 항목의 전송 상태. 쌓인 순서다. */
  app.get("/api/notifications", async (_req, res) => {
    res.json(await listOutbox(db));
  });

  // 채널 adapter의 경로(webhook·가짜 채널 화면 등)는 `/api/channels/<채널 이름>` 아래다. adapter가 받기를 시작할 때 건다.
  const channelRouter = express.Router();
  app.use(`/api/channels/${encodeURIComponent(channel.name)}`, channelRouter);
  const channelRoute =
    (route: ChannelRoute): express.RequestHandler =>
    async (req, res) => {
      const { status, body } = await route({
        params: req.params as Record<string, string>,
        headers: req.headers,
        body: req.body,
      });
      res.status(status).json(body);
    };

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
    const input = parseInput(res, updateApprovalPolicyInputSchema, req.body);
    if (!input) return;
    respond(
      res,
      await complete(updateApprovalPolicy(db, req.params.id, input))
    );
  });

  /** 본문 없는 제어 명령의 입력 검사. 다른 입력 오류와 같은 응답 모양이다. */
  const emptyCommand = (req: express.Request, res: express.Response) =>
    parseInput(res, emptyCommandInputSchema, req.body ?? {}) !== undefined;

  /**
   * 조직 일시정지·재개·중단 제어 명령. 사용자만 내리며 조직 도구가 없다. 명령 뒤의 조직을 돌려주고, 이미 그 상태면 아무것도 남기지 않는다.
   * 최종 완료·중단 조직은 409 `organization_closed`다(이미 중단한 조직의 중단은 그대로 둔다).
   */
  for (const command of organizationCommands)
    app.post(`/api/organizations/:id/${command}`, async (req, res) => {
      if (!emptyCommand(req, res)) return;
      respond(
        res,
        await complete(controlOrganization(db, req.params.id, command))
      );
    });

  /**
   * 에이전트 일시정지·재개·실행 중단(`interrupt`) 제어 명령. 명령 뒤의 에이전트 상세를 돌려준다. 끝난 조직의 에이전트는 409 `organization_closed`다.
   * 실행 중단은 메시지 없이 진행 중 실행 시도만 취소하며, 실행 중이 아니면 아무것도 남기지 않는다.
   */
  for (const command of agentCommands)
    app.post(
      `/api/organizations/:id/agents/:agentId/${command}`,
      async (req, res) => {
        if (!emptyCommand(req, res)) return;
        respond(
          res,
          await complete(
            controlAgent(db, req.params.id, req.params.agentId, command)
          )
        );
      }
    );

  /**
   * 에이전트 heartbeat 설정 변경. 사용자만 바꾸며 조직 도구가 없다. 변경 뒤의 에이전트 상세를 돌려주고, 값이 그대로면 아무것도 남기지 않는다.
   * 일시정지 중에도 바꿀 수 있고, 최종 완료·중단 조직은 409 `organization_closed`다.
   */
  app.put(
    "/api/organizations/:id/agents/:agentId/heartbeat",
    async (req, res) => {
      const input = parseInput(res, updateHeartbeatInputSchema, req.body);
      if (!input) return;
      respond(
        res,
        await complete(
          updateHeartbeat(db, req.params.id, req.params.agentId, input, {
            now,
          })
        )
      );
    }
  );

  /**
   * 에이전트 이름·얼굴 변경. 사용자만 바꾸며 조직 도구가 없다. 변경 뒤의 에이전트 상세를 돌려주고, 값이 그대로면 아무것도 남기지 않는다.
   * 연구 진행에 닿지 않는 표시 정보라 어느 단계에서든 바꿀 수 있다. 같은 조직의 다른 에이전트와 겹치는 이름은 409 `name_taken`이다.
   */
  app.patch("/api/organizations/:id/agents/:agentId", async (req, res) => {
    const input = parseInput(res, updateAgentProfileInputSchema, req.body);
    if (!input) return;
    respond(
      res,
      await complete(
        updateAgentProfile(db, req.params.id, req.params.agentId, input)
      )
    );
  });

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

  /**
   * 조직 안의 대화. 경로에 대화가 없으면 기본 대화다. 다른 조직의 대화는 없는 대화와 같은 404다.
   * 끝난 조직의 대화도 읽을 수 있고, 보내기는 기존 규칙(끝난 조직의 `중단하고 보내기`만 409)을 따른다.
   */
  const findChat = async (organizationId: string, conversationId?: string) => {
    const org = await findOrganization(db, organizationId);
    if (!org || !findLead(org.agents)) return undefined;
    const conversation =
      conversationId === undefined
        ? await findDefaultConversation(db, org.id)
        : await findConversation(db, org.id, conversationId);
    return conversation && { org, conversation };
  };
  /**
   * 대화 기록 한 쪽(`?before=`·`?after=` 커서, 없으면 가장 최근 쪽). 줄 세운 메시지는 따로 `queued-messages`가 준다.
   * 서버가 준 것이 아닌 커서나 둘을 함께 쓴 조회는 422 `invalid_input`이다.
   */
  const listChatMessages = async (
    req: express.Request,
    res: express.Response,
    conversationId?: string
  ) => {
    const chat = await findChat(String(req.params.id), conversationId);
    if (!chat) return notFound(res);
    const query = conversationPageQuerySchema.safeParse(req.query);
    const page =
      query.success &&
      (await listConversationPage(
        db,
        chat.org.id,
        chat.conversation.id,
        query.data
      ));
    if (!page || page === "invalid_cursor") {
      res.status(422).json({
        error: {
          code: "invalid_input",
          issues: query.success ? [] : query.error.issues,
        },
      });
      return;
    }
    res.json(page);
  };
  /** 대화 하나의 줄 세운 메시지 전부(보낸 순서). 대화 기록의 쪽과 상관없다. */
  const listChatQueue = async (
    req: express.Request,
    res: express.Response,
    conversationId?: string
  ) => {
    const chat = await findChat(String(req.params.id), conversationId);
    if (!chat) return notFound(res);
    res.json(await listQueuedMessages(db, chat.org.id, chat.conversation.id));
  };
  const sendChatMessage = async (
    req: express.Request,
    res: express.Response,
    conversationId?: string
  ) => {
    const chat = await findChat(String(req.params.id), conversationId);
    if (!chat) return refuseOwner(res, "not_found");
    const input = parseInput(res, sendOwnerMessageInputSchema, req.body);
    if (!input) return;
    respond(
      res,
      await sendOwnerMessage(chat.org, chat.conversation, input),
      201,
      (sent) => sent.message
    );
  };

  app.get("/api/organizations/:id/conversations", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(await listConversations(db, req.params.id));
  });

  /** 새 대화를 첫 사용자 메시지와 함께 시작한다. 빈 대화는 만들지 않는다. */
  app.post("/api/organizations/:id/conversations", async (req, res) => {
    const org = await findOrganization(db, req.params.id);
    if (!org || !findLead(org.agents)) return refuseOwner(res, "not_found");
    const input = parseInput(res, sendOwnerMessageInputSchema, req.body);
    if (!input) return;
    respond(res, await sendOwnerMessage(org, "new", input), 201);
  });

  app.get(
    "/api/organizations/:id/conversations/:conversationId/messages",
    (req, res) => listChatMessages(req, res, req.params.conversationId)
  );

  app.get(
    "/api/organizations/:id/conversations/:conversationId/queued-messages",
    (req, res) => listChatQueue(req, res, req.params.conversationId)
  );

  app.post(
    "/api/organizations/:id/conversations/:conversationId/messages",
    (req, res) => sendChatMessage(req, res, req.params.conversationId)
  );

  /** 사용자가 대화를 메시지 하나까지 보았다. 목록의 읽지 않음 표시만 바꾸며 Event를 남기지 않는다. 바뀐 대화 목록을 돌려준다. */
  app.put(
    "/api/organizations/:id/conversations/:conversationId/read",
    async (req, res) => {
      const input = parseInput(res, markConversationReadInputSchema, req.body);
      if (!input) return;
      const marked = await markConversationRead(
        db,
        req.params.id,
        req.params.conversationId,
        input.upToMessageId
      );
      if (marked === "not_found") return refuseOwner(res, "not_found");
      res.json(await listConversations(db, req.params.id));
    }
  );

  // 기본 대화. 대화 경로가 생기기 전의 조회·보내기와 같다.
  app.get("/api/organizations/:id/messages", (req, res) =>
    listChatMessages(req, res)
  );

  app.get("/api/organizations/:id/queued-messages", (req, res) =>
    listChatQueue(req, res)
  );

  app.post("/api/organizations/:id/messages", (req, res) =>
    sendChatMessage(req, res)
  );

  /**
   * 줄 세운 메시지(아직 실행 시도가 받지 않은 Lead 대화의 사용자 메시지) 고치기·거두기·지금 보내기. 바뀐 메시지를 돌려준다(거두기는 거두기 전 모양).
   * 고치기는 `{ body }`(보내기와 같은 검사)로 글만 바꾸고 전달 방식·줄 속 위치는 그대로다. 실행 시도가 이미 받았으면 409 `message_delivered`,
   * 다른 조직·거둔 메시지는 404다. 고치기·지금 보내기는 끝난 조직이면 409 `organization_closed`다.
   * 셋 다 일시정지 중에도 되고(일시정지 중 지금 보내기는 재개 뒤 먼저 전달), 거두기는 끝난 조직에서도 된다.
   */
  for (const path of ["edit", "withdraw", "send-now"] as const)
    app.post(
      `/api/organizations/:id/messages/:messageId/${path}`,
      async (req, res) => {
        const { id, messageId } = req.params;
        let result;
        if (path === "edit") {
          const input = parseInput(res, editQueuedMessageInputSchema, req.body);
          if (!input) return;
          result = editQueuedMessage(db, id, messageId, input.body);
        } else {
          if (!emptyCommand(req, res)) return;
          result =
            path === "withdraw"
              ? withdrawQueuedMessage(db, id, messageId, { now })
              : sendQueuedMessageNow(db, id, messageId);
        }
        respond(res, await complete(result));
      }
    );

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
      const input = parseInput(res, editInstructionCopyInputSchema, req.body);
      if (!input) return;
      respond(
        res,
        await complete(editInstructionCopy(db, copyRef(req), input, source))
      );
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
      const input = parseInput(res, addTaskCommentInputSchema, req.body);
      if (!input) return;
      respond(
        res,
        await complete(
          insertOwnerTaskComment(
            db,
            req.params.id,
            req.params.taskId,
            input.body,
            source
          )
        ),
        201
      );
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
      const input = parseInput(res, schema, req.body ?? {});
      if (input === undefined) return;
      respond(
        res,
        await complete(
          editResearchMap(
            db,
            String(req.params.id),
            command(input, req),
            source
          )
        ),
        status
      );
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
      const input = parseInput(res, decideApprovalInputSchema, req.body);
      if (!input) return;
      respond(
        res,
        await complete(
          decideApproval(
            db,
            req.params.id,
            req.params.approvalId,
            input,
            source
          )
        )
      );
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
      const input = parseInput(res, decideResultInputSchema, req.body);
      if (!input) return;
      respond(
        res,
        await complete(
          decideResult(
            db,
            req.params.id,
            req.params.submissionId,
            input,
            source
          )
        )
      );
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
  /**
   * 서버를 끈다. 정상 종료와 시작 실패가 같은 길을 쓴다. 각 부분은 시작하지 않았거나 일부만 시작했어도 닫을 수 있다.
   * heartbeat가 새 깨우기를 만들지 않게 한 뒤 실행 시도를 끝내고, 그 사이 쌓인 알림은 outbox에 남아 다음 시작에 보낸다.
   */
  const stop = async () => {
    // 한 부분을 닫다 실패해도 나머지(특히 포트)는 닫고, 실패는 모두 닫은 뒤에 알린다.
    const failures: unknown[] = [];
    for (const close of [
      () => heartbeats.close(),
      () => dispatcher.close(),
      () => notifications.close(),
      () => channel.close(),
      async () => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    ])
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, "stopping the server failed");
  };
  try {
    // 남은 실행 시도 복구가 끝난 뒤에 heartbeat가 새 깨우기를 만든다.
    await dispatcher.start();
    heartbeats.start();
    notifications.start();
    await channel.listen({
      inlet: channelInlet({
        channel: channel.name,
        db,
        source,
        complete,
        sendOwnerMessage,
      }),
      routes: {
        get: (path, route) => channelRouter.get(path, channelRoute(route)),
        post: (path, route) => channelRouter.post(path, channelRoute(route)),
      },
    });
  } catch (error) {
    // 끄다가 난 오류는 남기고, 호출자에게는 시작을 막은 원래 오류를 돌려준다.
    await stop().catch((stopError) =>
      console.error("[server] stopping after a failed start failed", stopError)
    );
    throw error;
  }

  return {
    url,
    drain: () => dispatcher.drain(),
    tickHeartbeats: () => heartbeats.tick(),
    deliverNotifications: () => notifications.flush(),
    close: stop,
  };
}

const queryString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/**
 * 가짜 채널 답장의 응답. 대시보드 명령과 같은 응답 코드·본문이며, 글 답장은 사용자 메시지 보내기처럼 201이다.
 * 알림 종류에 맞지 않는 답은 422 `reply_not_allowed`다.
 */
function fakeChannelResponse(
  result: ChannelReplyResult,
  answer: ChannelAnswer
): ChannelResponse {
  switch (result.kind) {
    case "ok":
      return { status: answer.kind === "text" ? 201 : 200, body: result.value };
    case "invalid_input":
      return { status: 422, body: invalidInputBody(result.issues) };
    case "refused": {
      const response = ownerRefusalResponses[result.reason as OwnerRefusal];
      if (!response)
        throw new Error(
          `no response code for channel refusal ${result.reason}`
        );
      const [code, status] = response;
      return { status, body: { error: { code } } };
    }
  }
}

/** 조회 경로의 없음(다른 조직의 것도 같다). 명령 경로의 없음은 `refuseOwner`의 표를 거친다. */
function notFound(res: express.Response) {
  res.status(404).json({ error: { code: "not_found" } });
}

/** 입력 계약 검사. 어긋나면 422 `invalid_input`(Zod issues 포함)으로 답하고 `undefined`를 돌려준다. */
function parseInput<S extends z.ZodType>(
  res: express.Response,
  schema: S,
  body: unknown
): z.infer<S> | undefined {
  const input = schema.safeParse(body);
  if (input.success) return input.data;
  res.status(422).json(invalidInputBody(input.error.issues));
  return undefined;
}

const invalidInputBody = (issues: unknown) => ({
  error: { code: "invalid_input", issues },
});

/** 사용자가 한 일의 거부를 `ownerRefusalResponses`의 응답 코드로 답한다. */
function refuseOwner(res: express.Response, reason: OwnerRefusal) {
  const [code, status] = ownerRefusalResponses[reason];
  res.status(status).json({ error: { code } });
}

/** 사용자가 한 일의 결과를 응답으로: 성공이면 `status`와 값(또는 `body`가 고른 것), 거부면 표의 응답 코드. */
function respond<T>(
  res: express.Response,
  outcome: Outcome<T, OwnerRefusal>,
  status = 200,
  body: (value: T) => unknown = (value) => value
) {
  if (outcome.kind === "refused") return refuseOwner(res, outcome.reason);
  res.status(status).json(body(outcome.value));
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
