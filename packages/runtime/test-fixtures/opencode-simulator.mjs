// Synthetic HTTP/SSE peer for the pinned 2.x public protocol. No model calls.
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
if (process.argv.includes("--version")) {
  console.log("opencode v9.9.9");
  process.exit(0);
}
// --recording이면 응답과 이벤트는 실제 출력의 정제본(opencode-recorded.json)을 쓰고, 동작만 이 파일이 연기한다.
const recordingAt = process.argv.indexOf("--recording");
const recording =
  recordingAt < 0
    ? null
    : JSON.parse(await readFile(process.argv[recordingAt + 1], "utf8"));
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"),
  subscribers = new Set();
const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };
let session, context, instructions;
const write = (event) => {
  for (const res of subscribers)
    res.write("data: " + JSON.stringify(event) + "\n\n");
};
const bound = (event) =>
  JSON.parse(JSON.stringify(event).replaceAll("<session>", session.id));
const emit = (type) => {
  const recorded =
    recording?.started.type === type
      ? recording.started
      : recording?.succeeded.type === type
        ? recording.succeeded
        : null;
  write(recorded ? bound(recorded) : { type, data: { sessionID: session.id } });
  if (type === "session.execution.started")
    for (const event of recording?.turn ?? []) write(bound(event));
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
      if (process.argv.includes("--slow-model"))
        await new Promise((resolve) => setTimeout(resolve, 11_000));
      if (recording) {
        json({ data: recording.models });
        return;
      }
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
      if (process.argv.includes("--sse-noise"))
        res.write(": keep-alive\n\ndata: not json\n\n");
      for (const event of recording?.connected ?? [])
        res.write(
          "data: " +
            JSON.stringify(event).replaceAll("<session>", "ses_other") +
            "\n\n"
        );
      subscribers.add(res);
      res.on("close", () => subscribers.delete(res));
      return;
    }
    if (pathname === "/api/session" && req.method === "POST") {
      session = {
        ...recording?.session,
        id: "ses_" + crypto.randomUUID(),
        tokens: zero,
        cost: 0,
      };
      json({ data: session });
      return;
    }
    const id = pathname.split("/")[3];
    if (id === "expired") {
      res.writeHead(404).end("{}");
      return;
    }
    if (id === "bad-format") {
      res.writeHead(400).end("{}");
      return;
    }
    if (!session)
      session = { ...recording?.session, id, tokens: zero, cost: 0 };
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
      json(recording?.prompt ?? { data: { id: "inbox-one" } });
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
