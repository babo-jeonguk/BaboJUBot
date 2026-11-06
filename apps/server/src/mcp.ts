import type { ActiveRun } from "@babojubot/db";
import type { ToolDispatch } from "./tools.ts";
import type express from "express";
import { z } from "zod";
import {
  orgToolNames,
  orgTools,
  idempotencyKeyHeader,
  type OrgToolName,
} from "@babojubot/contracts";

/** Stateless Streamable HTTP (2025-03-26/2025-06-18/2025-11-25). Authentication is the parent router's responsibility. */
export function mcpRoutes(
  router: express.Router,
  dispatch: ToolDispatch,
  available: (run: ActiveRun) => Promise<OrgToolName[]>
) {
  router.all("/mcp", async (req, res) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    // 전용 listener는 Docker 네트워크의 gateway 주소로 받는다. 받은 주소 그대로의 Host만 더 허용하므로 다른 이름으로 오는 DNS rebinding은 여전히 막는다.
    const localAddress = req.socket.localAddress;
    const localPort = req.socket.localPort;
    const localHost =
      localAddress === undefined || localPort === undefined
        ? undefined
        : `${localAddress.includes(":") ? `[${localAddress}]` : localAddress}:${localPort}`;
    if (
      !host ||
      (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) &&
        host !== localHost) ||
      (origin && origin !== `http://${host}`)
    ) {
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.sendStatus(405);
      return;
    }
    const message = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(req.body);
    const error = (id: string | number | null, code: number, message: string) =>
      res.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (!message.success) {
      error(null, -32600, "Invalid Request");
      return;
    }
    const { id, method, params = {} } = message.data;
    if (id === undefined) {
      res.status(202).end();
      return;
    }
    const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const revisions = ["2025-03-26", "2025-06-18", "2025-11-25"];
    const revision = req.headers["mcp-protocol-version"];
    if (revision && !revisions.includes(String(revision))) {
      res.status(400);
      error(id, -32600, "Unsupported protocol version");
      return;
    }
    if (method === "initialize") {
      reply({
        protocolVersion: revisions.includes(String(params.protocolVersion))
          ? params.protocolVersion
          : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "babojubot", version: "0.0.0" },
      });
      return;
    }
    if (method === "ping") {
      reply({});
      return;
    }
    if (method === "tools/list") {
      reply({
        tools: (await available(res.locals.run as ActiveRun)).map((name) => ({
          name,
          description: orgTools[name].description,
          inputSchema: z.toJSONSchema(orgTools[name].input),
        })),
      });
      return;
    }
    if (method !== "tools/call") {
      error(id, -32601, "Method not found");
      return;
    }
    if (
      typeof params.name !== "string" ||
      !orgToolNames.includes(params.name as OrgToolName)
    ) {
      error(id, -32602, "Unknown tool");
      return;
    }
    const name = params.name as OrgToolName;
    const args = params.arguments ?? {};
    if (typeof args !== "object" || !args || Array.isArray(args)) {
      error(id, -32602, "Invalid arguments");
      return;
    }
    // Reconstruct the existing HTTP wire representation, preserving field order and omitted defaults for stored receipts.
    const pathParams: Record<string, unknown> = Object.create(null);
    const body: Record<string, unknown> = Object.create(null);
    const names: readonly string[] = orgTools[name].params;
    for (const key of names)
      if (key in args) pathParams[key] = (args as Record<string, unknown>)[key];
    for (const [key, value] of Object.entries(args))
      if (!names.includes(key)) body[key] = value;
    let operationKey: unknown = req.headers[idempotencyKeyHeader];
    const meta = params._meta;
    if (
      meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      idempotencyKeyHeader in meta
    ) {
      const key = (meta as Record<string, unknown>)[idempotencyKeyHeader];
      if (
        typeof key !== "string" ||
        (req.headers[idempotencyKeyHeader] &&
          req.headers[idempotencyKeyHeader] !== key)
      ) {
        error(id, -32602, "Invalid idempotency key");
        return;
      }
      operationKey = key;
    }
    const { status, value } = await dispatch(
      name,
      res.locals.run as ActiveRun,
      { params: pathParams, body, query: body, key: operationKey }
    );
    reply({
      isError: status >= 400,
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent:
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? value
          : { value },
    });
  });
}
