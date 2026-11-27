// Synthetic behavioral ACP v1 peer for contract tests (Kiro CLI / Grok Build).
// No external CLI or model is invoked. Persists synthetic session notes in a test-owned folder
// and invokes the local contract-test tool server using the MCP organization server header.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { hasErrorCode, orIfMissing } from "@babojubot/contracts/failure";
import { afterOutput } from "../../../scripts/exit-after-output.ts";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const rawArgs = process.argv.slice(2);
const mode = flagValue(rawArgs, "--mode") ?? "kiro";
const storeDir = flagValue(rawArgs, "--store");
const cliArgs: string[] = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === "--mode" || arg === "--store") {
    i += 1;
    continue;
  }
  if (arg !== undefined) cliArgs.push(arg);
}

const out = (value: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");

if (mode === "kiro") {
  if (cliArgs[0] === "whoami") {
    if (cliArgs.includes("json"))
      console.log(JSON.stringify({ account: { id: "synthetic-user" } }));
    else console.log("Logged in with synthetic account");
    process.exit(await afterOutput(0));
  }
  if (cliArgs[0] === "chat" && cliArgs.includes("--list-models")) {
    console.log(
      JSON.stringify({
        models: [
          { model_id: "auto", model_name: "auto" },
          { model_id: "simulated-model", model_name: "Simulated Model" },
        ],
      })
    );
    process.exit(await afterOutput(0));
  }
  if (cliArgs[0] !== "acp") process.exit(await afterOutput(24));
} else if (mode === "grok") {
  if (cliArgs[0] === "models") {
    console.log("You are logged in with grok.com.");
    console.log("  * simulated-model (default)");
    console.log("  - other-model");
    process.exit(await afterOutput(0));
  }
  if (
    cliArgs[0] !== "agent" ||
    !cliArgs.includes("--no-leader") ||
    !cliArgs.includes("stdio")
  )
    process.exit(await afterOutput(24));
} else {
  process.exit(await afterOutput(24));
}

if (!storeDir) throw new Error("acp-simulator: --store is required");
const sessionsDir = path.join(storeDir, `${mode}-sessions`);

type McpServer = {
  name?: string;
  url?: string;
  headers?: { name?: string; value?: string }[];
};
type Session = { id: string; file: string; note: string; model: string };

let session: Session | undefined;
let mcpServers: McpServer[] = [];
let waitingPromptId: number | undefined;
let permissionCounter = 0;
const pendingPermissions = new Map<string, () => void>();

const allowedModels = new Set(["auto", "simulated-model", "other-model"]);

async function askPermission(sessionId: string): Promise<void> {
  // 문자열 ID를 섞어 에이전트→클라이언트 요청 ID 처리 일반화를 함께 확인한다.
  const permId = `perm-${++permissionCounter}`;
  await new Promise<void>((resolve) => {
    pendingPermissions.set(permId, resolve);
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

async function handlePrompt(id: number, text: string) {
  if (!session) {
    out({ id, error: { code: -32602, message: "No active session" } });
    return;
  }
  const parsed = JSON.parse(text.slice(text.indexOf('{"identity"'))) as {
    wakeReasons?: { body?: string }[];
    context?: { conversations?: { id: string }[] };
  };
  const body = parsed.wakeReasons?.[0]?.body ?? "";
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
  const conversations = parsed.context?.conversations ?? [];
  if (conversations.length > 0 && server?.url) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    for (const h of server.headers ?? [])
      if (h.name && h.value) headers[h.name] = h.value;
    const response = await fetch(server.url.replace(/\/mcp$/, "/messages"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        body:
          body === "세션 메모를 알려 주세요" ? session.note || "없음" : "완료",
        conversationId: conversations[0]?.id,
      }),
    });
    if (!response.ok) process.exit(await afterOutput(23));
  }
  out({ id, result: { stopReason: "end_turn" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
  };
  if (typeof frame.id === "string" && !frame.method) {
    const waiter = pendingPermissions.get(frame.id);
    if (waiter) {
      pendingPermissions.delete(frame.id);
      waiter();
    }
    continue;
  }
  const { id, method, params = {} } = frame;
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
    mcpServers = Array.isArray(params.mcpServers)
      ? (params.mcpServers as McpServer[])
      : [];
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
    const first = prompt[0] as { text?: string } | undefined;
    void handlePrompt(id, first?.text ?? "");
  } else if (method === "session/cancel") {
    if (waitingPromptId !== undefined) {
      const pendingId = waitingPromptId;
      waitingPromptId = undefined;
      out({ id: pendingId, result: { stopReason: "cancelled" } });
    }
  }
}
