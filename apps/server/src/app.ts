import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  addTaskCommentInputSchema,
  artifactContentMaxLength,
  createOrganizationInputSchema,
  decideApprovalInputSchema,
  eventStreamPath,
  orgToolsBasePath,
  sendOwnerMessageInputSchema,
  type RuntimeAdapter,
  type StreamFrame,
  type StreamScope,
} from "@babojubot/contracts";
import {
  findAgentDetail,
  findAgentInstructions,
  findApproval,
  findArtifact,
  findFlowTemplate,
  findOrganization,
  findRunDetail,
  findTaskDetail,
  listApprovals,
  listConversation,
  listInbox,
  listOrganizationEvents,
  listOrganizations,
  listRuns,
  listTasks,
  type Database,
} from "@babojubot/db";
import { findLead } from "@babojubot/core";
import { createScriptedRuntime } from "@babojubot/runtime";
import express, { type ErrorRequestHandler } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { decideApproval } from "./approvals.ts";
import { sendOwnerMessage } from "./conversation.ts";
import { RunDispatcher } from "./dispatcher.ts";
import { EventHub } from "./event-hub.ts";
import { defaultHarnessDir } from "./harness.ts";
import { createOrganization } from "./organizations.ts";
import { addOwnerTaskComment } from "./tasks.ts";
import { orgToolsRouter } from "./tools.ts";

/**
 * JSON 요청 본문 크기 상한(바이트). 계약상 가장 큰 본문인 산출물(최대 {@link artifactContentMaxLength}자)은
 * 한 글자(UTF-16 code unit)가 JSON에서 최대 6바이트(`\uXXXX`)이므로 그만큼과 나머지 필드의 여유를 둔다.
 * 문자 수 제한은 Zod 계약이 맡고, 이 상한은 그 계약을 막지 않는 바깥 경계다.
 */
export const jsonBodyLimitBytes = artifactContentMaxLength * 6 + 64 * 1024;

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
};

export type RunningServer = {
  url: string;
  /** 깨우기 대기열이 비고 실행 중인 실행 시도가 모두 끝날 때까지 기다린다. 테스트 helper. */
  drain: () => Promise<void>;
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

  /** Inbox. 첫 판은 모든 조직에서 결정을 기다리는 승인 요청뿐이다. */
  app.get("/api/inbox", async (_req, res) => {
    res.json(await listInbox(db));
  });

  app.get("/api/organizations/:id", async (req, res) => {
    const org = await findOrganization(db, req.params.id);
    if (!org) return notFound(res);
    res.json(org);
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
    res
      .status(201)
      .json(
        await sendOwnerMessage({ db, hub, dispatcher, now }, org, input.data)
      );
  });

  app.get("/api/organizations/:id/runs", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(
      await listRuns(db, req.params.id, {
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

  /** 에이전트의 Role·Soul·Skill 사본 읽기. 편집은 #64. */
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

  /** 승인 결정 제어 명령. 결정은 한 번만 할 수 있고, 이미 결정한 요청은 409 `already_decided`다. */
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
      res.json(result.approval);
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
    await dispatcher.start();
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    url,
    drain: () => dispatcher.drain(),
    close: async () => {
      await dispatcher.close();
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
