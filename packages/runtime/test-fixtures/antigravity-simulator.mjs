// Synthetic behavioral peer for `agy acp` (Agent Client Protocol, newline-delimited JSON-RPC over stdio) and `agy models`.
// No Antigravity or model is invoked. Frame shapes follow agy 1.5.4 transcripts against a mock upstream (#148).
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { bind, recording } from "./recording.mjs";
const args = process.argv
    .slice(2)
    .filter(
      (_, i, all) => all[i] !== "--recording" && all[i - 1] !== "--recording"
    ),
  out = (value) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
if (args.includes("--version")) {
  console.log("9.9.9");
  process.exit(0);
}
// 실제 프로그램(키링 없는 컴퓨터)은 HOME의 이 파일로 로그인한다. 접근 토큰이 만료됐으면 `agy models`가 갱신해 같은 경로에 덮어쓴다
// (링크면 따라가 원본 자리에 쓴다. 1.5.3·1.5.4 확인). 컨테이너 안에서는 실행 시도 전용 파일이 이 자리 위에 들어갈 수 있다.
const loginAt = path.join(
  process.env.HOME,
  ".gemini/antigravity-cli/antigravity-oauth-token"
);
const mounted = JSON.parse(process.env.FAKE_DOCKER_MOUNTS ?? "[]").find(
  (mount) => mount.target === loginAt
);
const login = await readFile(mounted?.source ?? loginAt, "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);
/** 만료된 로그인을 갱신해 같은 자리에 덮어쓴다(링크면 원본 자리). 컨테이너에 넣은 실행 시도 전용 파일은 읽기만 된다. */
async function refresh() {
  if (!login?.expired || mounted) return;
  login.expired = false;
  login.refreshed = (login.refreshed ?? 0) + 1;
  if (login.token)
    login.token = {
      ...login.token,
      access_token: `refreshed-${login.refreshed}`,
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    };
  await writeFile(loginAt, JSON.stringify(login), { mode: 0o600 });
}
if (args[0] === "models") {
  if (!login) {
    console.error(
      "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."
    );
    process.exit(1);
  }
  await refresh();
  console.log("simulated-model\tSimulated Model");
  process.exit(0);
}
const conversations = path.join(
  process.env.HOME,
  ".gemini/antigravity-cli/conversations"
);
const models = ["simulated-model", "other-model"];
let session, mcp, waiting;
const update = (value) =>
  out({
    method: "session/update",
    params: { sessionId: session.id, update: value },
  });
const say = (text) =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
/** 인증 중계를 거치는 모델 호출(CLOUD_CODE_URL이 있을 때). 실제 프로그램처럼 저장된 접근 토큰을 Bearer로 싣는다. */
const callModel = () =>
  fetch(
    `${process.env.CLOUD_CODE_URL}/v1internal:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${login.token?.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: session.model }),
    }
  ).then(
    async (response) => {
      await response.arrayBuffer().catch(() => undefined);
      return response.status;
    },
    () => 0
  );
async function prompt(id, text) {
  const context = JSON.parse(text.slice(text.indexOf('{"identity"'))),
    body = context.wakeReasons[0]?.body ?? "";
  if (body === "실행 유지 연습") {
    waiting = id;
    return;
  }
  if (process.env.CLOUD_CODE_URL && (await callModel()) !== 200) {
    // 실제 프로그램은 오류를 실패 종료로 알리지 않는다. 문구 한 줄과 end_turn만 보낸다.
    say("\n⚠ Agent execution terminated due to error.\n");
    out({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (body.startsWith("메모해 주세요: ")) {
    session.note = body.slice("메모해 주세요: ".length);
    await writeFile(session.file, session.note);
  }
  const server = mcp.find((entry) => entry.name === "organization");
  const response = !context.context.conversations.length
    ? { ok: true }
    : await fetch(server.url.replace(/\/mcp$/, "/messages"), {
        method: "POST",
        headers: {
          ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          body:
            body === "세션 메모를 알려 주세요"
              ? session.note || "없음"
              : "완료",
          conversationId: context.context.conversations[0].id,
        }),
      });
  if (!response.ok) process.exit(23);
  if (recording) {
    for (const frame of recording.updates) out(bind(frame, session.id));
    out({ id, result: recording.promptResult });
    return;
  }
  say("완료");
  out({
    id,
    result: {
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 12,
      },
    },
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialize")
    out({
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  else if (method === "session/new" || method === "session/load") {
    // 로그인이 없거나 쓸 수 없으면 실제 프로그램(1.5.4)은 세션을 열 때 이 오류를 낸다.
    if (!login) {
      out({ id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    // 실제 프로그램은 세션을 열 때 만료된 로그인을 갱신한다(갱신 값이 있으면).
    await refresh();
    await mkdir(conversations, { recursive: true });
    const sessionId =
      method === "session/load" ? params.sessionId : crypto.randomUUID();
    const file = path.join(conversations, sessionId + ".db");
    const note = await readFile(file, "utf8").catch(() => null);
    if (method === "session/load" && note === null) {
      out({ id, error: { code: -32603, message: "conversation not found" } });
      continue;
    }
    session = { id: sessionId, file, note: note ?? "", model: models[0] };
    if (note === null) await writeFile(file, "");
    // 실제 프로그램은 불러온 대화를 응답 전에 다시 보낸다.
    else
      update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "earlier" },
      });
    mcp = params.mcpServers ?? [];
    out({
      id,
      result: {
        ...(method === "session/new" ? { sessionId } : {}),
        models: {
          availableModels: models.map((modelId) => ({
            modelId,
            name: modelId,
          })),
          currentModelId: session.model,
        },
      },
    });
  } else if (method === "session/set_model") {
    if (!models.includes(params.modelId))
      out({ id, error: { code: -32602, message: "Unknown model ID" } });
    else {
      session.model = params.modelId;
      out({ id, result: {} });
    }
  } else if (method === "session/prompt")
    await prompt(id, params.prompt.map((part) => part.text ?? "").join(""));
  else if (method === "session/cancel") {
    if (waiting !== undefined) {
      out({ id: waiting, result: { stopReason: "cancelled" } });
      waiting = undefined;
    }
  } else if (id !== undefined) out({ id, result: {} });
}
