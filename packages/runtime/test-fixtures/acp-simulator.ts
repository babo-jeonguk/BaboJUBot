// Synthetic behavioral ACP v1 peer for runtime contract tests.
// No external CLI or model is invoked. CLI invocation flags and probe output are passed by the caller
// via --acp-args / --probe-args / --probe-stdout / --store so this simulator stays provider-agnostic.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts/failure";
import { afterOutput } from "../../../scripts/exit-after-output.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.assign({}, value)
    : {};
}

const configFlags = new Set([
  "--store",
  "--acp-args",
  "--probe-args",
  "--probe-stdout",
]);
const options = new Map<string, string>();
const cliArgs: string[] = [];
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg !== undefined && configFlags.has(arg)) {
    const value = rawArgs[i + 1];
    if (value !== undefined) options.set(arg, value);
    i += 1;
    continue;
  }
  if (arg !== undefined) cliArgs.push(arg);
}

const splitArgs = (raw: string | undefined): string[] =>
  raw ? raw.split(",").filter((part) => part.length > 0) : [];
const expectedAcpArgs = splitArgs(options.get("--acp-args"));
const expectedProbeArgs = splitArgs(options.get("--probe-args"));
const probeStdout = options.get("--probe-stdout") ?? "";
const storeDir = options.get("--store");

const sameArgs = (actual: readonly string[], expected: readonly string[]) =>
  expected.length > 0 &&
  actual.length === expected.length &&
  actual.every((part, index) => part === expected[index]);

if (sameArgs(cliArgs, expectedProbeArgs)) {
  console.log(probeStdout);
  process.exit(await afterOutput(0));
}
if (!sameArgs(cliArgs, expectedAcpArgs)) process.exit(await afterOutput(24));
if (!storeDir) throw new Error("acp-simulator: --store is required");

const sessionsDir = path.join(storeDir, "acp-sessions");
const out = (value: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");

type McpHeader = { name: string; value: string };
type McpServer = { name: string; url: string; headers: McpHeader[] };
type Session = { id: string; file: string; note: string; model: string };

function parseMcpServers(raw: unknown): McpServer[] {
  if (!Array.isArray(raw)) return [];
  const servers: McpServer[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (typeof entry.name !== "string" || typeof entry.url !== "string")
      continue;
    const headers: McpHeader[] = [];
    if (Array.isArray(entry.headers)) {
      for (const h of entry.headers) {
        const pair = asRecord(h);
        if (typeof pair.name === "string" && typeof pair.value === "string")
          headers.push({ name: pair.name, value: pair.value });
      }
    }
    servers.push({ name: entry.name, url: entry.url, headers });
  }
  return servers;
}

let session: Session | undefined;
let mcpServers: McpServer[] = [];
let waitingPromptId: number | undefined;
let permissionCounter = 0;
const pendingPermissions = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void }
>();
let activePrompt: Promise<void> | undefined;

const allowedModels = new Set(["auto", "simulated-model", "other-model"]);

async function askPermission(sessionId: string): Promise<void> {
  // 문자열 ID를 섞어 에이전트→클라이언트 요청 ID 처리 일반화와 allow_once 우선 선택을 함께 검증한다.
  const permId = `perm-${++permissionCounter}`;
  await new Promise<void>((resolve, reject) => {
    pendingPermissions.set(permId, { resolve, reject });
    out({
      id: permId,
      method: "session/request_permission",
      params: {
        sessionId,
        options: [
          { optionId: "allow-always", kind: "allow_always", name: "Always" },
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject", kind: "reject_once", name: "Deny" },
        ],
      },
    });
  });
}

async function handlePrompt(id: number, text: string): Promise<void> {
  if (!session) {
    out({ id, error: { code: -32602, message: "No active session" } });
    return;
  }
  const marker = text.indexOf('{"identity"');
  if (marker < 0) {
    out({ id, error: { code: -32602, message: "Missing request payload" } });
    return;
  }
  const parsed = asRecord(
    orIfUnreadable((): unknown => JSON.parse(text.slice(marker)), {})
  );
  const wakeReasons = Array.isArray(parsed.wakeReasons)
    ? parsed.wakeReasons.map(asRecord)
    : [];
  const body =
    typeof wakeReasons[0]?.body === "string" ? wakeReasons[0].body : "";
  if (body === "실행 유지 연습") {
    waitingPromptId = id;
    return;
  }
  if (body.startsWith("메모해 주세요: ")) {
    session.note = body.slice("메모해 주세요: ".length);
    await writeFile(session.file, session.note);
  }
  out({
    method: "session/update",
    params: {
      sessionId: session.id,
      update: { sessionUpdate: "tool_call", title: "send_message" },
    },
  });
  await askPermission(session.id);
  const server = mcpServers.find((entry) => entry.name === "organization");
  const context = asRecord(parsed.context);
  const conversations = Array.isArray(context.conversations)
    ? context.conversations.map(asRecord)
    : [];
  const firstConversationId = conversations[0]?.id;
  if (typeof firstConversationId === "string" && server) {
    const headers = new Headers({ "content-type": "application/json" });
    for (const h of server.headers) headers.set(h.name, h.value);
    const response = await fetch(server.url.replace(/\/mcp$/, "/messages"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        body:
          body === "세션 메모를 알려 주세요" ? session.note || "없음" : "완료",
        conversationId: firstConversationId,
      }),
    });
    if (!response.ok) process.exit(await afterOutput(23));
  }
  out({ id, result: { stopReason: "end_turn" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const frame = asRecord(
    orIfUnreadable((): unknown => JSON.parse(line), undefined)
  );
  if (typeof frame.id === "string" && typeof frame.method !== "string") {
    const waiter = pendingPermissions.get(frame.id);
    if (waiter) {
      pendingPermissions.delete(frame.id);
      const outcome = asRecord(asRecord(frame.result).outcome);
      if (
        frame.error === undefined &&
        outcome.outcome === "selected" &&
        outcome.optionId === "allow-once"
      )
        waiter.resolve();
      else
        waiter.reject(
          new Error("acp-simulator: expected allow-once permission selection")
        );
    }
    continue;
  }
  const id = frame.id;
  const method = typeof frame.method === "string" ? frame.method : "";
  const params = asRecord(frame.params);
  if (method === "initialize") {
    out({
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  } else if (method === "session/new" || method === "session/load") {
    await mkdir(sessionsDir, { recursive: true });
    const sessionId =
      method === "session/load" && typeof params.sessionId === "string"
        ? params.sessionId
        : crypto.randomUUID();
    const file = path.join(sessionsDir, `${sessionId}.txt`);
    const note = await orIfMissing(
      () => readFile(file, "utf8"),
      hasErrorCode("ENOENT"),
      null
    );
    if (method === "session/load" && note === null) {
      out({ id, error: { code: -32004, message: "Session not found" } });
      continue;
    }
    if (note === null) await writeFile(file, "");
    mcpServers = parseMcpServers(params.mcpServers);
    session = {
      id: sessionId,
      file,
      note: note ?? "",
      model: "simulated-model",
    };
    out({
      id,
      result: {
        ...(method === "session/new" ? { sessionId } : {}),
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: session.model,
          },
        ],
      },
    });
  } else if (method === "session/set_config_option") {
    const value = typeof params.value === "string" ? params.value : "";
    if (!session || params.configId !== "model" || !allowedModels.has(value)) {
      out({ id, error: { code: -32602, message: "Model unavailable" } });
      continue;
    }
    session.model = value;
    out({ id, result: {} });
  } else if (method === "session/prompt" && typeof id === "number") {
    const prompt = Array.isArray(params.prompt) ? params.prompt : [];
    const first = asRecord(prompt[0]);
    const text = typeof first.text === "string" ? first.text : "";
    const task = handlePrompt(id, text).catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(await afterOutput(27));
    });
    activePrompt = task;
  } else if (method === "session/cancel") {
    if (waitingPromptId !== undefined) {
      const pendingId = waitingPromptId;
      waitingPromptId = undefined;
      out({ id: pendingId, result: { stopReason: "cancelled" } });
    }
  }
}

for (const waiter of pendingPermissions.values())
  waiter.reject(new Error("acp-simulator: stdin closed before permission"));
pendingPermissions.clear();
if (activePrompt) await activePrompt;
