/**
 * OpenCode 2.2.6 plugin: 조직 도구(MCP 서버 `organization`)의 `execute`를 바꿔, 호출마다 같은 호출 키(`idempotency-key`)를
 * MCP 요청의 `params._meta`에 넣어 보낸다(#150). 키는 OpenCode가 준 호출 신원(세션·assistant 메시지·도구 호출 ID)으로 만들므로
 * 같은 구체적 호출의 재전송은 같은 키이고, 내용이 같아도 다른 호출은 다른 키다. 도구 입력(`arguments`)에는 아무것도 더하지 않는다.
 * 호출 신원이 없으면 키 없이 보내지 않고 도구 오류로 끝낸다. 제품 서버는 이 연결의 키 없는 쓰기를 거부한다(contracts `callKeyRequiredHeader`).
 *
 * 근거(OpenCode v2.2.6, `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`): 설정 폴더의 `plugins/*.js`를 자동으로 읽고 기본 내보내기
 * `{ id, setup(ctx) }`를 쓴다(`core/src/plugin/source-directory.ts`, `core/src/plugin/module.ts`). `ctx.tool.transform`의 editor는
 * `update(id, draft => draft.execute = …)`로 실행을 바꾸며, MCP 도구 ID는 `organization_<도구>`이고 `options.namespace`가 서버 이름이다
 * (`plugin/src/promise/tool.ts`, `core/src/tool/mcp.ts`). 바꾼 실행은 원래 실행처럼 먼저 권한을 확인하고(`permission.assert`),
 * 원래 MCP 실행의 기본 시한(12시간, `core/src/mcp/client.ts`)을 지키고, 결과의 `structuredContent`를 `output`으로, 글 조각을 `content`로 돌려주며 `isError`면 그 글로 던진다(`core/src/tool/mcp.ts` 84–105).
 * 제품 서버는 글 조각과 `structuredContent`만 보내므로 그 밖의 조각(이미지·자원)은 옮기지 않는다.
 * transform은 등록 순서대로 다시 적용되므로, MCP 도구가 나중에 등록돼 이 transform이 그 도구를 보지 못했으면 다시 등록해 뒤로 보낸다.
 *
 * 제품은 실행 시도마다 OpenCode 설정 폴더의 `plugins/`에 이 글을 파일로 써 넣는다. Bun이 그대로 읽는 ESM JavaScript다.
 */
export const organizationKeysPluginSource = String.raw`// BaboJUBot이 실행 시도마다 써 넣는 파일이다. 고치지 않는다.
import { createHash } from "node:crypto";

const server = "organization";
/** OpenCode 원래 MCP 실행의 기본 시한(설정 timeout.execution이 없을 때 12시간). */
const executionTimeoutMs = 12 * 60 * 60 * 1000;
const keyField = "idempotency-key";

/** 호출 신원으로 만든 같은 호출 키. 신원이 하나라도 없으면 던진다. */
export function callKey(context) {
  const parts = [context?.sessionID, context?.messageID, context?.id];
  if (!parts.every((part) => typeof part === "string" && part.length > 0))
    throw new Error("BaboJUBot organization tool call has no call identity; it was not sent");
  return "oc1:" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** 제품이 준 설정의 조직 도구 MCP 서버(주소·header). */
function organizationServer() {
  try {
    return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")?.mcp?.servers?.[server];
  } catch {
    return undefined;
  }
}

/** 조직 도구 하나를 그 MCP 서버에 직접 부른다. */
async function callTool(target, name, input, context, key) {
  let response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: {
        ...(target.headers ?? {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: input ?? {},
          _meta: { "ai.opencode/sessionID": context.sessionID, [keyField]: key },
        },
      }),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(executionTimeoutMs)]),
    });
  } catch (error) {
    throw new Error('MCP tool "' + name + '" on server "' + server + '" failed: ' + (error?.message ?? String(error)));
  }
  if (!response.ok)
    throw new Error('MCP tool "' + name + '" on server "' + server + '" failed: HTTP ' + response.status);
  const message = await response.json();
  if (message.error)
    throw new Error('MCP tool "' + name + '" on server "' + server + '" failed: ' + message.error.message);
  const result = message.result ?? {};
  const texts = (result.content ?? []).flatMap((part) => (part?.type === "text" ? [part.text] : []));
  if (result.isError === true) throw new Error(texts.join("\n").trim() || "MCP tool returned an error");
  const text = texts.join("\n");
  const output = result.structuredContent !== undefined ? result.structuredContent : text === "" ? null : text;
  return { output, ...(texts.length ? { content: texts.map((t) => ({ type: "text", text: t })) } : {}) };
}

export default {
  id: "babojubot.organization-keys",
  async setup(ctx) {
    const target = organizationServer();
    if (!target?.url) return;
    let applied = false;
    const transform = (editor) => {
      applied = false;
      for (const tool of editor.list()) {
        if (tool.options?.namespace !== server) continue;
        const id = tool.id;
        const name = tool.name;
        editor.update(id, (draft) => {
          draft.execute = async (input, context) => {
            const key = callKey(context);
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: id,
              resources: ["*"],
              save: ["*"],
              metadata: { input: input ?? {} },
              source: { type: "tool", messageID: context.messageID, id: context.id },
            });
            return callTool(target, name, input, context, key);
          };
        });
        applied = true;
      }
    };
    let registration = await ctx.tool.transform(transform);
    // MCP 도구가 이 transform보다 나중에 등록됐으면 이 transform은 그 도구를 보지 못한다. 보일 때까지 확인해 다시 등록한다.
    const ensure = async () => {
      const tools = await ctx.tool.list();
      if (applied || !tools.some((tool) => tool.options?.namespace === server)) return applied;
      await registration.dispose?.();
      registration = await ctx.tool.transform(transform);
      await ctx.tool.list();
      return applied;
    };
    const stop = new AbortController();
    void (async () => {
      for (let attempt = 0; attempt < 600 && !stop.signal.aborted; attempt++) {
        try {
          if (await ensure()) break;
        } catch {
          /* 다음 확인에서 다시 본다. */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["mcp.tools.changed"], signal: stop.signal })) {
          if (event?.data?.server !== server) continue;
          await new Promise((resolve) => setTimeout(resolve, 300));
          await ensure().catch(() => {});
        }
      } catch {
        /* 목록 바뀜 알림을 받지 못하는 판이면 처음 확인만 한다. */
      }
    })();
    return () => stop.abort();
  },
};
`;
