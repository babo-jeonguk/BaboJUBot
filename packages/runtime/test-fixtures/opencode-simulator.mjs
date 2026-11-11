// Synthetic HTTP/SSE peer for the pinned 2.x public protocol. No model calls.
import http from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
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
// --usage면 그 파일의 세션 누계({ before, after }: { tokens, cost })를 실행 전·후 값으로 쓴다.
const usageAt = process.argv.indexOf("--usage");
const usage =
  usageAt < 0
    ? null
    : JSON.parse(await readFile(process.argv[usageAt + 1], "utf8"));
// --fail면 본 실행 요청에 그 파일의 `error`로 2.2.6 `session.execution.failed`(data.error: type·message·선택 status·response.body)를 낸다.
// 합성 재생이며 실제 SSE 녹화가 아니다. `foreign`이면 먼저 다른 세션의 실패를 낸다. 본 실행 요청마다 `<파일>.prompts`에 한 줄 남긴다.
const failAt = process.argv.indexOf("--fail");
const failFile = failAt < 0 ? null : process.argv[failAt + 1];
const failing = failFile ? JSON.parse(await readFile(failFile, "utf8")) : null;
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"),
  subscribers = new Set();
const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };
let session, context, instructions;
// 표준은 줄 끝으로 CRLF도 허용한다.
const eventEnd = process.argv.includes("--sse-crlf") ? "\r\n\r\n" : "\n\n";
const write = (event) => {
  for (const res of subscribers)
    res.write("data: " + JSON.stringify(event) + eventEnd);
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
  session.tokens = usage
    ? usage.after.tokens
    : { input: 12, output: 3, cache: { read: 5, write: 0 } };
  if (usage) session.cost = usage.after.cost;
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
      if (process.argv.includes("--no-free")) {
        json({
          data: [
            {
              id: "paid",
              providerID: "someone",
              name: "Paid",
              cost: [{ input: 1, output: 1 }],
            },
          ],
        });
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
          eventEnd
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
    // 2.2.5의 `GET`/`POST /api/credential`(Credential.Entry·CreateInput). 로그인은 그 실행의 데이터 폴더에 둔다.
    if (pathname === "/api/credential") {
      const store = path.join(
        process.env.XDG_DATA_HOME,
        "synthetic-credentials.json"
      );
      const stored = JSON.parse(
        await readFile(store, "utf8").catch(() => "[]")
      );
      if (req.method === "GET") {
        json({ data: stored });
        return;
      }
      if (req.method === "POST") {
        if (stored.some((entry) => entry.id === input.id)) {
          res.writeHead(409).end("{}");
          return;
        }
        const entry = {
          id: input.id ?? "cred_" + crypto.randomUUID(),
          integrationID: input.integrationID,
          label: input.label ?? "",
          active: input.activate ?? false,
          value: input.value,
        };
        await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
        await writeFile(store, JSON.stringify([...stored, entry]));
        json({ data: entry });
        return;
      }
    }
    if (pathname === "/api/session" && req.method === "POST") {
      session = {
        ...recording?.session,
        id: "ses_" + crypto.randomUUID(),
        tokens: usage?.before.tokens ?? zero,
        cost: usage ? usage.before.cost : 0,
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
      if (failing) {
        await writeFile(failFile + ".prompts", "prompt\n", { flag: "a" });
        if (failing.foreign)
          write({
            type: "session.execution.failed",
            data: {
              sessionID: "ses_other",
              error: { type: "provider.auth", message: "other", status: 401 },
            },
          });
        write({
          type: "session.execution.failed",
          data: { sessionID: session.id, error: failing.error },
        });
        return;
      }
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
// --startup-race면 같은 데이터 폴더에서 다른 서버가 뜨는 중일 때 끝난다. 실제 2.2.6이 새 폴더의 DB를 둘이 함께 만들다
// 하나가 끝나는 것(`table … already exists`, #147)의 합성이다. 뜨는 데 300ms 걸린다.
if (process.argv.includes("--startup-race")) {
  await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
  const starting = path.join(process.env.XDG_DATA_HOME, "starting");
  try {
    await writeFile(starting, "", { flag: "wx" });
  } catch {
    console.error("synthetic: table already exists");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(starting);
}
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
