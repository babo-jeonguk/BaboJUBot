import {
  orgToolErrorSchema,
  orgToolMethods,
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

export type OrgToolOutput<T extends OrgToolName> = ReturnType<
  (typeof orgToolOutputSchemas)[T]["parse"]
>;

export type OrgToolClient = {
  /** 도구 하나를 부른다. POST 도구는 `input`을 본문으로 보낸다. 거부되면 {@link OrgToolError}. */
  call<T extends OrgToolName>(
    tool: T,
    input?: unknown,
    params?: Record<string, string>
  ): Promise<OrgToolOutput<T>>;
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
    input?: unknown,
    params: Record<string, string> = {}
  ): Promise<OrgToolOutput<T>> {
    const path = Object.entries(params).reduce<string>(
      (p, [key, value]) => p.replace(`:${key}`, encodeURIComponent(value)),
      orgToolPaths[tool]
    );
    const post = orgToolMethods[tool] === "POST";
    const res = await fetch(new URL(orgToolsBasePath + path, baseUrl), {
      method: orgToolMethods[tool],
      headers: {
        authorization: `Bearer ${token}`,
        ...(post ? { "content-type": "application/json" } : {}),
      },
      body: post ? JSON.stringify(input ?? {}) : undefined,
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
    return orgToolOutputSchemas[tool].parse(json) as OrgToolOutput<T>;
  }
  return {
    call,
    getRunContext: () => call("get_run_context"),
    sendMessage: (body) => call("send_message", { body }),
    getMessage: (messageId) => call("get_message", undefined, { messageId }),
  };
}
