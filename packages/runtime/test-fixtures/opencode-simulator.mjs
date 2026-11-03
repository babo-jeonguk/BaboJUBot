// Synthetic HTTP/SSE peer for the pinned 2.x public protocol. No model calls.
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
if (process.argv.includes("--version")) {
  console.log("2.2.5");
  process.exit(0);
}
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"),
  subscribers = new Set();
const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };
let session, context, instructions;
const emit = (type) => {
  for (const res of subscribers)
    res.write(
      "data: " +
        JSON.stringify({ type, data: { sessionID: session.id } }) +
        "\n\n"
    );
};
async function finish(body) {
  if (context.context.conversations.length) {
    const mcp = config.mcp.servers.organization;
    const res = await fetch(mcp.url.replace(/\/mcp$/, "/messages"), {
      method: "POST",
      headers: { ...mcp.headers, "content-type": "application/json" },
      body: JSON.stringify({
        body,
        conversationId: context.context.conversations[0].id,
      }),
    });
    if (!res.ok) throw new Error("synthetic tool rejected");
  }
  session.tokens = { input: 12, output: 3, cache: { read: 5, write: 0 } };
  emit("session.execution.succeeded");
}
const server = http.createServer(async (req, res) => {
  try {
    if (
      req.headers.authorization !==
      "Basic " +
        Buffer.from(
          "opencode:" + process.env.OPENCODE_SERVER_PASSWORD
        ).toString("base64")
    ) {
      res.writeHead(401).end();
      return;
    }
    const pathname = new URL(req.url, "http://localhost").pathname;
    const json = (data) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(data));
    };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    if (pathname === "/api/model") {
      json({
        data: [
          {
            id: "synthetic-free",
            providerID: "opencode",
            name: "Synthetic Free",
            cost: [{ input: 0, output: 0 }],
          },
        ],
      });
      return;
    }
    if (pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        "data: " +
          JSON.stringify({ type: "server.connected", data: {} }) +
          "\n\n"
      );
      subscribers.add(res);
      res.on("close", () => subscribers.delete(res));
      return;
    }
    if (pathname === "/api/session" && req.method === "POST") {
      session = { id: "ses_" + crypto.randomUUID(), tokens: zero, cost: 0 };
      json({ data: session });
      return;
    }
    const id = pathname.split("/")[3];
    if (id === "expired") {
      res.writeHead(404).end("{}");
      return;
    }
    if (!session) session = { id, tokens: zero, cost: 0 };
    if (pathname.endsWith("/instructions/entries/babojubot")) {
      if (req.method !== "PUT" || typeof input.value !== "string") {
        res.writeHead(400).end();
        return;
      }
      instructions = input.value;
      res.writeHead(204).end();
      return;
    }
    if (pathname.endsWith("/prompt")) {
      if (instructions === undefined) {
        res.writeHead(409).end("{}");
        return;
      }
      json({ data: { id: "inbox-one" } });
      if (input.delivery === "steer") {
        await finish(input.text);
        return;
      }
      context = JSON.parse(input.text);
      emit("session.execution.started");
      const body = context.wakeReasons[0]?.body ?? "";
      if (body === "실행 유지 연습" || body === "끼워 넣기 연습") return;
      if (body === "느린 작업")
        await new Promise((resolve) => setTimeout(resolve, 10500));
      const noteFile = path.join(
        process.env.XDG_DATA_HOME,
        session.id + ".note"
      );
      await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
      if (body.startsWith("메모해 주세요: "))
        await writeFile(noteFile, body.slice("메모해 주세요: ".length));
      await finish(
        body === "세션 메모를 알려 주세요"
          ? await readFile(noteFile, "utf8")
          : "완료"
      );
      return;
    }
    if (pathname.endsWith("/interrupt")) {
      json({ interrupted: true });
      emit("session.execution.interrupted");
      return;
    }
    if (pathname.endsWith("/model")) {
      res.writeHead(204).end();
      return;
    }
    json({ data: session });
  } catch {
    res.writeHead(500).end("{}");
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    JSON.stringify({ url: "http://127.0.0.1:" + server.address().port })
  )
);
process.stdin.resume();
process.stdin.on("end", () => {
  server.closeAllConnections();
  server.close();
});
