import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 실제 OpenCode가 부르는 OpenAI 호환 가짜 모델(#147). 받은 요청 본문을 모두 남기고, 계정·실제 모델 없이 답한다.
 * 대상 upstream이 거부한 것과 같은 도구 정의(`\0` 표기의 pattern)는 HTTP 400으로 거부한다. 그 밖의 거부는 마지막 사용자 메시지의 표지로 고른다.
 * 거부 응답에는 합성 비밀값과 받은 입력을 되돌려 실어, 제품이 원문을 공개하지 않는지 확인할 수 있게 한다.
 */
export const modelSecret = "sk-local-model-secret-147";
export const rejectMarker = "#147-reject";
export const authMarker = "#147-auth";
export type ModelRequest = {
  raw: string;
  body: {
    messages?: { role: string; content: unknown }[];
    tools?: {
      function: { name: string; parameters: Record<string, unknown> };
    }[];
    stream?: boolean;
  };
};
/**
 * 그 요청이 처리하는 깨우기의 본문. 제품은 마지막 사용자 메시지에 실행 맥락 JSON(`wakeReasons`)을 보낸다.
 * 맥락의 대화에는 앞선 메시지도 있으므로 표지는 이번 깨우기에서만 찾는다.
 */
export function wakeText(request: ModelRequest) {
  const content = request.body.messages
    ?.filter((m) => m.role === "user")
    .at(-1)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part?.text === "string" ? (part.text as string) : ""
            )
            .join("")
        : "";
  try {
    const parsed = JSON.parse(text) as { wakeReasons?: { body?: unknown }[] };
    return (parsed.wakeReasons ?? [])
      .map((wake) => (typeof wake.body === "string" ? wake.body : ""))
      .join("\n");
  } catch {
    return "";
  }
}
/** 거부된 `\0` 표기. JSON 본문에서는 역슬래시가 두 번 나온다. */
export const refusedPattern = String.raw`"^[^\\0]*$"`;

export async function startLocalModel() {
  const requests: ModelRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as ModelRequest["body"];
    const request = { raw, body };
    requests.push(request);
    const last = wakeText(request);
    const refuse = (status: number, code: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `${code} ${modelSecret} ${last}`,
            type:
              status === 401 ? "authentication_error" : "invalid_request_error",
            code,
          },
        })
      );
    };
    if (raw.includes(refusedPattern) || last.includes(rejectMarker))
      return refuse(400, "upstream_rejected_request");
    if (last.includes(authMarker)) return refuse(401, "invalid_api_key");
    const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    const base = {
      id: "chatcmpl-local",
      created: 0,
      model: "test",
    };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "완료" },
              finish_reason: "stop",
            },
          ],
          usage,
        })
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: unknown) =>
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({
      ...base,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "완료" },
          finish_reason: null,
        },
      ],
    });
    send({
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
