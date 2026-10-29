import {
  idempotencyKeyHeader,
  isOrgToolRead,
  orgToolErrorSchema,
  orgTools,
  orgToolsBasePath,
  splitOrgToolInput,
  type ConversationMessage,
  type OrgToolInput,
  type OrgToolName,
  type OrgToolOutput,
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
  /**
   * 도구 하나를 부른다. 입력은 경로 변수까지 담은 하나이며, 도구 목록대로 경로 변수를 경로에 채우고
   * 나머지를 GET은 query string으로, 그 밖은 본문으로 보낸다. 거부되면 {@link OrgToolError}.
   * `idempotencyKey`는 같은 효과를 한 번만 남기는 호출 키다(contracts `idempotencyKeyHeader`).
   */
  call<T extends OrgToolName>(
    tool: T,
    input?: OrgToolInput<T>,
    options?: { idempotencyKey?: string }
  ): Promise<OrgToolOutput<T>>;
  getRunContext(): Promise<RunContextResponse>;
  /** Lead 대화에 답장한다. `conversationId`가 없으면 서버가 받은 사용자 메시지의 대화(없으면 기본 대화)로 보낸다. */
  sendMessage(
    input: { body: string; conversationId?: string },
    options?: { idempotencyKey?: string }
  ): Promise<ConversationMessage>;
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
    input?: OrgToolInput<T>,
    { idempotencyKey }: { idempotencyKey?: string } = {}
  ): Promise<OrgToolOutput<T>> {
    const { method, output } = orgTools[tool];
    const { path, rest } = splitOrgToolInput(tool, input ?? {});
    const post = !isOrgToolRead(tool);
    const url = new URL(orgToolsBasePath + path, baseUrl);
    if (!post)
      for (const [key, value] of Object.entries(rest))
        url.searchParams.set(key, String(value));
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(post ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { [idempotencyKeyHeader]: idempotencyKey } : {}),
      },
      body: post ? JSON.stringify(rest) : undefined,
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
    return output.parse(json) as OrgToolOutput<T>;
  }
  return {
    call,
    getRunContext: () => call("get_run_context"),
    sendMessage: (input, options) => call("send_message", input, options),
    getMessage: (messageId) => call("get_message", { messageId }),
  };
}
