import {
  orgToolErrorSchema,
  orgToolOutputSchemas,
  orgToolPaths,
  orgToolsBasePath,
  type ConversationMessage,
  type OrgToolName,
  type RunContextResponse,
} from "@babojubot/contracts";

/** 조직 도구가 요청을 거부했다. 메시지에 토큰을 담지 않는다. */
export class OrgToolError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(tool: OrgToolName, status: number, code: string | undefined) {
    super(`조직 도구 ${tool} 거부: HTTP ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

export type OrgToolClient = {
  getRunContext(): Promise<RunContextResponse>;
  sendMessage(body: string): Promise<ConversationMessage>;
  getMessage(messageId: string): Promise<ConversationMessage>;
};

/** 실행 시도별 토큰으로 조직 도구 HTTP를 부른다. 조직·에이전트는 토큰이 정하므로 따로 보내지 않는다. */
export function createOrgToolClient({
  baseUrl,
  token,
  signal,
  fetch = globalThis.fetch,
}: {
  baseUrl: string;
  token: string;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): OrgToolClient {
  async function call<T extends OrgToolName>(
    tool: T,
    path: string,
    body?: unknown
  ) {
    const res = await fetch(new URL(orgToolsBasePath + path, baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const refusal = orgToolErrorSchema.safeParse(json);
      throw new OrgToolError(
        tool,
        res.status,
        refusal.success ? refusal.data.error.code : undefined
      );
    }
    return orgToolOutputSchemas[tool].parse(json);
  }
  return {
    getRunContext: () =>
      call(
        "get_run_context",
        orgToolPaths.get_run_context
      ) as Promise<RunContextResponse>,
    sendMessage: (body) =>
      call("send_message", orgToolPaths.send_message, {
        body,
      }) as Promise<ConversationMessage>,
    getMessage: (messageId) =>
      call(
        "get_message",
        orgToolPaths.get_message.replace(
          ":messageId",
          encodeURIComponent(messageId)
        )
      ) as Promise<ConversationMessage>,
  };
}
