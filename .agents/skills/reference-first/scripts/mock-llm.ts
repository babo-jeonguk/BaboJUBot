#!/usr/bin/env node
// OpenAI-compatible stand-in for a self-hosted reference app, so its AI states render without a real key.
// usage: node .agents/skills/reference-first/scripts/mock-llm.ts [--port <0-65535>] [--rules rules.json] [--log requests.jsonl]
// Serves GET /v1/models and POST /v1/chat/completions (plain and stream: true). Point the app at
// http://127.0.0.1:<port>/v1 with key sk-dummy. The port is 8787 when not given; 0 takes a free one, and the line
// "mock-llm on <address>" names the port it got.
//
// rules.json is an array; the first rule whose `match` regex (case-insensitive; anchor it, "hang" matches "change") hits
// the last user message wins (a rule without `match` hits every message). Each rule answers with one of:
//   { "match": "^shorter", "reply": "A shorter sentence." }        normal answer
//   { "match": "^fail", "status": 500, "error": "upstream down" }   error status with an OpenAI-shaped error body
//   { "match": "^slow", "delay": 8000, "reply": "late" }            answer after a delay
//   { "match": "^empty", "reply": "" }                              empty content
//   { "match": "^hang", "hang": true }                              never answers (client timeout / cancel)
//   { "match": "^tool", "message": { "role": "assistant", "content": null, "tool_calls": [...] } }  raw message
// Without a matching rule the reply is "mock reply". "status" is 200 (with a reply or message) or an error status (400-599).
// A wrong argument ends with exit code 2. A rule whose fields are not these types, or that does not answer, answers 500 naming
// the rule; a request that is not a JSON object with a list of messages with roles answers 400, as the API does.
import { appendFileSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { orIfUnreadable } from "@babojubot/contracts";
import { field, isObject, listField } from "../../../scripts/json-field.ts";

const USAGE =
  "usage: node .agents/skills/reference-first/scripts/mock-llm.ts [--port <0-65535>] [--rules rules.json] [--log requests.jsonl]";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  // The comment lines after the first line (#!) are the help.
  const lines = readFileSync(new URL(import.meta.url), "utf8")
    .split("\n")
    .slice(1);
  const header = lines.slice(
    0,
    lines.findIndex((l) => !l.startsWith("//"))
  );
  console.log(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

function badArgument(message: string): never {
  console.error(`bad argument: ${message}\n${USAGE}`);
  process.exit(2);
}

/** The options given, by name. A name without its value, an unknown name or a name given twice is refused. */
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const name = args[i] ?? "";
  const value = args[i + 1];
  if (!["--port", "--rules", "--log"].includes(name)) badArgument(name);
  if (value === undefined || value === "") badArgument(`${name} needs a value`);
  if (options.has(name)) badArgument(`${name} given twice`);
  options.set(name, value);
}
// 8787 is the documented port when none is given.
const portText = options.get("--port") ?? "8787";
const port = Number(portText);
if (!/^\d+$/.test(portText) || port > 65_535)
  badArgument(`--port ${portText} is not a port (0-65535)`);
const rulesPath = options.get("--rules");
const logPath = options.get("--log");
const MODEL = "mock-model";

/** A rule of the rules file, its fields checked against the documented types. */
interface Rule {
  match: string;
  reply?: string;
  status?: number;
  error?: string;
  delay?: number;
  hang?: boolean;
  /** A raw answer message, and its tool calls if it has any. */
  message?: { value: object; toolCalls: object[] | undefined };
}

/** Reads rule `index`. A field of another type, or a rule that does not say how to answer, is a broken rules file. */
function readRule(rule: unknown, index: number): Rule {
  const broken = (why: string) => new Error(`rule ${index} ${why}`);
  if (!isObject(rule)) throw broken("is not an object");
  const optional = <T>(
    name: string,
    kind: string,
    isKind: (value: unknown) => value is T
  ): T | undefined => {
    const value = field(rule, name);
    if (value === undefined) return undefined;
    if (!isKind(value)) throw broken(`has a ${name} that is not ${kind}`);
    return value;
  };
  const isText = (value: unknown) => typeof value === "string";
  const isNumber = (value: unknown) => typeof value === "number";
  const isFlag = (value: unknown) => typeof value === "boolean";
  const read: Rule = {
    // A rule without match hits every message (the empty pattern).
    match: optional("match", "text", isText) ?? "",
    reply: optional("reply", "text", isText),
    status: optional("status", "a number", isNumber),
    error: optional("error", "text", isText),
    delay: optional("delay", "a number", isNumber),
    hang: optional("hang", "true or false", isFlag),
  };
  const { status } = read;
  if (
    status !== undefined &&
    status !== 200 &&
    !(Number.isInteger(status) && status >= 400 && status <= 599)
  )
    throw broken("has a status that is not 200 or an error status (400-599)");
  const message = optional("message", "an object", isObject);
  if (message) {
    const calls = field(message, "tool_calls");
    const content = field(message, "content");
    if (calls === undefined) {
      if (typeof content !== "string")
        throw broken(
          "has a message without tool_calls whose content is not text"
        );
    } else {
      if (!Array.isArray(calls) || calls.length === 0 || !calls.every(isObject))
        throw broken("has tool_calls that are not a list of tool call objects");
      // Beside tool calls the content is text or null, as the API sends it.
      if (
        content !== undefined &&
        content !== null &&
        typeof content !== "string"
      )
        throw broken(
          "has a message whose content beside tool_calls is not text or null"
        );
    }
    read.message = {
      value: message,
      toolCalls: Array.isArray(calls) ? calls.filter(isObject) : undefined,
    };
  }
  // An error status answers by itself (an error body). A success answers with a reply or a message; or the rule hangs.
  const errorStatus = status !== undefined && status >= 400;
  if (
    !errorStatus &&
    read.reply === undefined &&
    read.message === undefined &&
    !read.hang
  )
    throw broken("does not answer (reply, message, an error status or hang)");
  return read;
}

/** The rules file, read as it is now. No rules file means no rules: every message gets "mock reply". */
function rules(): Rule[] {
  if (!rulesPath) return [];
  const parsed: unknown = JSON.parse(readFileSync(rulesPath, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(`the rules file is not an array: ${rulesPath}`);
  return parsed.map(readRule);
}
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/**
 * The text of the last user message, or why the message list is malformed (the API answers such a request 400). Every message
 * is an object with a role. The last user message's content is text or a list of part objects whose text, when a part has
 * one, is text; a part without text (an image) carries no words to match. Other fields and other messages' content are not
 * read, so they are not checked.
 */
function lastUserText(
  messages: unknown[]
): { text: string } | { malformed: string } {
  for (const [index, message] of messages.entries())
    if (!isObject(message) || typeof field(message, "role") !== "string")
      return { malformed: `message ${index} is not an object with a role` };
  const user = [...messages].reverse().find((m) => field(m, "role") === "user");
  if (!user) return { text: "" };
  const content = field(user, "content");
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content))
    return {
      malformed: "a user message's content is not text or a list of parts",
    };
  const texts: string[] = [];
  for (const part of content) {
    if (!isObject(part))
      return { malformed: "a part of a user message is not an object" };
    const text = field(part, "text");
    if (text === undefined) continue;
    if (typeof text !== "string")
      return { malformed: "a part's text is not text" };
    texts.push(text);
  }
  return { text: texts.join("\n") };
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(value));
}

/** A 400 with an OpenAI-shaped error body, as the API answers a malformed request. */
const invalid = (res: ServerResponse, message: string) =>
  json(res, 400, { error: { message, type: "invalid_request_error" } });

/** The answer message and its tool calls. */
type Answer = { value: object; toolCalls: object[] | undefined };

function completion(answer: Answer) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [
      {
        index: 0,
        message: answer.value,
        finish_reason: answer.toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function stream(res: ServerResponse, answer: Answer) {
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
  if (answer.toolCalls) {
    send({
      tool_calls: answer.toolCalls.map((call, index) => ({ index, ...call })),
    });
  } else {
    // Word-sized chunks with a small gap, so streaming UIs show their in-progress state. A message without tool calls has
    // text content (readRule).
    const content = field(answer.value, "content");
    for (const piece of (typeof content === "string" ? content : "").match(
      /\S+\s*/g
    ) ?? []) {
      send({ content: piece });
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  send({}, answer.toolCalls ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  // A request the server received always has a path; without one there is nothing to serve.
  if (req.url === undefined) return invalid(res, "the request has no path");
  const path = new URL(req.url, "http://localhost").pathname.replace(
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
  const body = orIfUnreadable((): unknown => JSON.parse(raw), undefined);
  if (!isObject(body)) return invalid(res, "the body is not a JSON object");
  const messages = listField(body, "messages");
  if (!messages) return invalid(res, "messages is not a list");
  const stream_ = field(body, "stream");
  if (stream_ !== undefined && typeof stream_ !== "boolean")
    return invalid(res, "stream is not true or false");
  const read = lastUserText(messages);
  if ("malformed" in read) return invalid(res, read.malformed);
  const { text } = read;
  // Read the rules once, so the rule that matched is the rule that answers even if the file changes meanwhile.
  const current = rules();
  const index = current.findIndex((r) => new RegExp(r.match, "i").test(text));
  const rule: Rule = current[index] ?? { match: "", reply: "mock reply" };
  console.log(
    [
      new Date().toISOString(),
      stream_ ? "stream" : "plain",
      `rule=${index}`,
      JSON.stringify(text.slice(0, 80)),
    ].join("\t")
  );
  if (logPath)
    appendFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), rule: index, body })}\n`
    );

  if (rule.hang) return; // the client's own timeout or cancel decides what happens next
  const { delay, status } = rule;
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (status !== undefined && status !== 200) {
    return json(res, status, {
      error: {
        // The rule's own error text, or this when it gives none.
        message: rule.error ?? "mock error",
        type: "mock_error",
        code: status,
      },
    });
  }
  const answer: Answer = rule.message ?? {
    value: { role: "assistant", content: rule.reply ?? "" },
    toolCalls: undefined,
  };
  return stream_ ? stream(res, answer) : json(res, 200, completion(answer));
}

// A broken request body or rules file answers 500 with the reason instead of leaving the client waiting.
const server = createServer((req, res) => {
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
});
server.listen(port, "127.0.0.1", () => {
  // Listening on TCP gives an address with a port (a string is a pipe path). With port 0 it is the port the system picked.
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error(`mock-llm is not on a TCP port (${address})`);
  console.log(`mock-llm on http://127.0.0.1:${address.port}/v1`);
});
