#!/usr/bin/env node
// OpenAI-compatible stand-in for a self-hosted reference app, so its AI states render without a real key.
// usage: node .agents/skills/reference-first/scripts/mock-llm.mjs [--port 8787] [--rules rules.json] [--log requests.jsonl]
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
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const port = Number(option("--port", 8787));
const rulesPath = option("--rules", null);
const logPath = option("--log", null);
const MODEL = "mock-model";

const rules = () => (rulesPath ? JSON.parse(readFileSync(rulesPath, "utf8")) : []);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function lastUserText(body) {
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content ?? []).map((part) => part.text ?? "").join("\n");
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(value));
}

function completion(message) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function stream(res, message) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS });
  const base = { id: `chatcmpl-mock-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL };
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  send({ role: "assistant" });
  if (message.tool_calls) {
    send({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) });
  } else {
    // Word-sized chunks with a small gap, so streaming UIs show their in-progress state.
    for (const piece of String(message.content ?? "").match(/\S+\s*/g) ?? []) {
      send({ content: piece });
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  send({}, message.tool_calls ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  const path = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "");
  if (req.method === "GET" && path.endsWith("/models")) {
    return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "mock" }] });
  }
  if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
    return json(res, 404, { error: { message: `mock-llm does not serve ${req.method} ${path}`, type: "not_found" } });
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const text = lastUserText(body);
  const index = rules().findIndex((r) => new RegExp(r.match ?? "", "i").test(text));
  const rule = index < 0 ? { reply: "mock reply" } : rules()[index];
  console.log([new Date().toISOString(), body.stream ? "stream" : "plain", `rule=${index}`, JSON.stringify(text.slice(0, 80))].join("\t"));
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), rule: index, body })}\n`);

  if (rule.hang) return; // the client's own timeout or cancel decides what happens next
  if (rule.delay) await new Promise((r) => setTimeout(r, rule.delay));
  if (rule.status && rule.status !== 200) {
    return json(res, rule.status, { error: { message: rule.error ?? "mock error", type: "mock_error", code: rule.status } });
  }
  const message = rule.message ?? { role: "assistant", content: rule.reply ?? "" };
  return body.stream ? stream(res, message) : json(res, 200, completion(message));
}).listen(port, "127.0.0.1", () => console.log(`mock-llm on http://127.0.0.1:${port}/v1`));
