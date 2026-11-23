#!/usr/bin/env node
// OpenAI-compatible stand-in for a self-hosted reference app, so its AI states render without a real key.
// usage: node .agents/skills/reference-first/scripts/mock-llm.ts [--port 8787] [--rules rules.json] [--log requests.jsonl]
// Serves GET /v1/models and POST /v1/chat/completions (plain and stream: true). Point the app at
// http://127.0.0.1:<port>/v1 with key sk-dummy.
//
// rules.json is an array; the first rule whose `match` regex (case-insensitive; anchor it, "hang" matches "change") hits
// the last user message wins:
//   { "match": "^shorter", "reply": "A shorter sentence." }        normal answer
//   { "match": "^fail", "status": 500, "error": "upstream down" }   error status with an OpenAI-shaped error body
//   { "match": "^slow", "delay": 8000, "reply": "late" }            answer after a delay
//   { "match": "^empty", "reply": "" }                              empty content
//   { "match": "^hang", "hang": true }                              never answers (client timeout / cancel)
//   { "match": "^tool", "message": { "role": "assistant", "content": null, "tool_calls": [...] } }  raw message
// Without a matching rule the reply is "mock reply".
import { appendFileSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  field,
  listField,
  numberField,
  textField,
} from "../../../scripts/json-field.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 15)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n")
  );
  process.exit(0);
}
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const port = Number(option("--port") ?? 8787);
const rulesPath = option("--rules");
const logPath = option("--log");
const MODEL = "mock-model";

/** The rules file: an array of rules, read as it is now. */
function rules(): unknown[] {
  if (!rulesPath) return [];
  const parsed: unknown = JSON.parse(readFileSync(rulesPath, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(`the rules file is not an array: ${rulesPath}`);
  return parsed;
}
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function lastUserText(body: unknown) {
  const user = [...(listField(body, "messages") ?? [])]
    .reverse()
    .find((m) => textField(m, "role") === "user");
  if (!user) return "";
  const content = field(user, "content");
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => textField(part, "text") ?? "")
    .join("\n");
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(value));
}

/** The tool calls of an answer message, if it has any. */
const toolCalls = (message: unknown) => listField(message, "tool_calls");

function completion(message: unknown) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls(message) ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function stream(res: ServerResponse, message: unknown) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...CORS,
  });
  const base = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
  };
  const send = (delta: object, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    );
  send({ role: "assistant" });
  const calls = toolCalls(message);
  if (calls) {
    send({
      tool_calls: calls.map((call, index) =>
        typeof call === "object" && call !== null
          ? { index, ...call }
          : { index }
      ),
    });
  } else {
    // Word-sized chunks with a small gap, so streaming UIs show their in-progress state.
    const content = field(message, "content");
    for (const piece of String(content ?? "").match(/\S+\s*/g) ?? []) {
      send({ content: piece });
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  send({}, calls ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(
    /\/+$/,
    ""
  );
  if (req.method === "GET" && path.endsWith("/models")) {
    return json(res, 200, {
      object: "list",
      data: [{ id: MODEL, object: "model", owned_by: "mock" }],
    });
  }
  if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
    return json(res, 404, {
      error: {
        message: `mock-llm does not serve ${req.method} ${path}`,
        type: "not_found",
      },
    });
  }
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  const body: unknown = JSON.parse(raw || "{}");
  const text = lastUserText(body);
  // Read the rules once, so the rule that matched is the rule that answers even if the file changes meanwhile.
  const current = rules();
  const index = current.findIndex((r) =>
    new RegExp(textField(r, "match") ?? "", "i").test(text)
  );
  const rule: unknown = index < 0 ? { reply: "mock reply" } : current[index];
  const streamed = Boolean(field(body, "stream"));
  console.log(
    [
      new Date().toISOString(),
      streamed ? "stream" : "plain",
      `rule=${index}`,
      JSON.stringify(text.slice(0, 80)),
    ].join("\t")
  );
  if (logPath)
    appendFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), rule: index, body })}\n`
    );

  if (field(rule, "hang")) return; // the client's own timeout or cancel decides what happens next
  const delay = numberField(rule, "delay");
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const status = numberField(rule, "status");
  if (status && status !== 200) {
    return json(res, status, {
      error: {
        message: textField(rule, "error") ?? "mock error",
        type: "mock_error",
        code: status,
      },
    });
  }
  const message = field(rule, "message") ?? {
    role: "assistant",
    content: textField(rule, "reply") ?? "",
  };
  return streamed ? stream(res, message) : json(res, 200, completion(message));
}

// A broken request body or rules file answers 500 with the reason instead of leaving the client waiting.
createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`mock-llm failed: ${reason}`);
    if (res.headersSent)
      res.destroy(error instanceof Error ? error : undefined);
    else
      json(res, 500, {
        error: {
          message: `mock-llm failed: ${reason}`,
          type: "mock_failure",
        },
      });
  });
}).listen(port, "127.0.0.1", () =>
  console.log(`mock-llm on http://127.0.0.1:${port}/v1`)
);
