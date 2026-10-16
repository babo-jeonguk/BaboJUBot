import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  createOrganizationInputSchema,
  eventStreamPath,
  type StreamFrame,
  type StreamScope,
} from "@babojubot/contracts";
import {
  findOrganization,
  listOrganizationEvents,
  listOrganizations,
  type Database,
} from "@babojubot/db";
import express, { type ErrorRequestHandler } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { EventHub } from "./event-hub.ts";
import { createOrganization } from "./organizations.ts";

export type ServerOptions = {
  db: Database;
  port: number;
  host?: string;
  /** 빌드한 대시보드. 있으면 API 밖의 경로에 SPA로 제공한다. */
  webDistDir?: string;
};

export type RunningServer = {
  url: string;
  close: () => Promise<void>;
};

export async function startServer({
  db,
  port,
  host = "127.0.0.1",
  webDistDir,
}: ServerOptions): Promise<RunningServer> {
  const hub = new EventHub();
  const app = express();
  app.use(express.json());

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
    res.status(201).json(await createOrganization(db, hub, input.data));
  });

  app.get("/api/organizations/:id", async (req, res) => {
    const org = await findOrganization(db, req.params.id);
    if (!org) return notFound(res);
    res.json(org);
  });

  app.get("/api/organizations/:id/events", async (req, res) => {
    if (!(await findOrganization(db, req.params.id))) return notFound(res);
    res.json(await listOrganizationEvents(db, req.params.id));
  });

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

  return {
    url: `http://${host}:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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
