import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { organizationKeysPluginSource } from "./opencode-keys-plugin.ts";

// 제품이 OpenCode 설정 폴더에 써 넣는 plugin을 OpenCode 없이 그 공개 API 모양(ctx.tool.transform·editor.update)의 가짜로 돌린다.
// 실제 OpenCode 2.2.6에서의 동작은 apps/server/test/opencode-real-cli.test.ts가 본다.

type Captured = { headers: http.IncomingHttpHeaders; body: any };
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  delete process.env.OPENCODE_CONFIG_CONTENT;
});

async function mcpServer(reply: (body: any) => unknown) {
  const captured: Captured[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    captured.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: reply(body) })
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () =>
    new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tools/mcp`,
    captured,
  };
}

/**
 * plugin을 불러 setup하고, 조직 도구 둘과 다른 도구 하나가 있는 가짜 editor에 transform을 적용한다.
 * 권한 확인은 요청을 `permissions`에 남긴 뒤 `check`의 결과를 돌려준다. 시험은 `check`로 확인을 붙잡거나 거부한다.
 */
async function loadPlugin(
  url: string,
  check: (request: unknown) => Promise<void> = async () => {}
) {
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    mcp: {
      servers: {
        organization: {
          url,
          headers: {
            Authorization: "Bearer token-1",
            "babojubot-call-key": "required",
          },
        },
      },
    },
  });
  const module = await import(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(organizationKeysPluginSource)}`
  );
  const tools = new Map<string, any>([
    [
      "organization_send_message",
      {
        id: "organization_send_message",
        name: "send_message",
        options: { namespace: "organization" },
      },
    ],
    [
      "organization_get_run_context",
      {
        id: "organization_get_run_context",
        name: "get_run_context",
        options: { namespace: "organization" },
      },
    ],
    ["bash", { id: "bash", name: "bash", options: {}, execute: "native" }],
  ]);
  const permissions: unknown[] = [];
  const transforms: ((editor: unknown) => void)[] = [];
  const editor = {
    list: () => [...tools.values()],
    update: (id: string, fn: (draft: any) => void) => {
      const tool = tools.get(id);
      if (tool) fn(tool);
    },
  };
  const ctx = {
    permission: {
      assert: (request: unknown) => {
        permissions.push(request);
        return check(request);
      },
    },
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        transforms.push(fn);
        fn(editor);
        return { dispose: async () => {} };
      },
      list: async () => [...tools.values()],
    },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await module.default.setup(ctx);
  return { tools, permissions, cleanup, callKey: module.callKey };
}

const context = (id: string, messageID = "msg-1") => ({
  sessionID: "ses-1",
  messageID,
  id,
  agent: "build",
  signal: new AbortController().signal,
});

describe("OpenCode organization call key plugin", () => {
  it("sends each organization tool call with its own key in params._meta and the input untouched, after the permission check", async () => {
    const server = await mcpServer((body) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: body.params.arguments.body }),
        },
      ],
      structuredContent: { id: body.params.arguments.body },
    }));
    // 세 호출의 권한 확인을 모두 붙잡는다. 셋이 확인에 닿은 뒤 풀어 준다.
    let allow!: () => void;
    const held = new Promise<void>((resolve) => (allow = resolve));
    let checking!: () => void;
    const allChecking = new Promise<void>((resolve) => (checking = resolve));
    let checks = 0;
    const { tools, permissions, cleanup, callKey } = await loadPlugin(
      server.url,
      () => {
        if (++checks === 3) checking();
        return held;
      }
    );
    const send = tools.get("organization_send_message")!.execute;
    const calls = [
      context("call_a"),
      context("call_b"),
      context("call_a", "msg-2"),
    ];
    const sending = Promise.all(
      calls.map((call) => send({ body: "같은 내용" }, call))
    );
    await allChecking;
    // 권한 확인이 끝나기 전에는 아무것도 보내지 않는다.
    expect(server.captured).toEqual([]);
    allow();
    const [a, b, c] = await sending;
    expect(a).toEqual({
      output: { id: "같은 내용" },
      content: [{ type: "text", text: '{"id":"같은 내용"}' }],
    });
    expect([b, c]).toEqual([a, a]);
    const keys = server.captured.map(
      (x) => x.body.params._meta["idempotency-key"]
    );
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(callKey(context("call_a")));
    for (const { headers, body } of server.captured) {
      expect(body.method).toBe("tools/call");
      expect(body.params.name).toBe("send_message");
      expect(body.params.arguments).toEqual({ body: "같은 내용" });
      expect(body.params._meta["ai.opencode/sessionID"]).toBe("ses-1");
      expect(headers.authorization).toBe("Bearer token-1");
      expect(headers["babojubot-call-key"]).toBe("required");
    }
    expect(permissions).toEqual(
      calls.map(({ messageID, id }) =>
        expect.objectContaining({
          action: "organization_send_message",
          source: { type: "tool", messageID, id },
        })
      )
    );
    // 다른 도구는 건드리지 않는다.
    expect(tools.get("bash")!.execute).toBe("native");
    cleanup?.();
  });

  it("does not send a call the permission check refuses", async () => {
    const server = await mcpServer(() => ({
      content: [{ type: "text", text: "{}" }],
    }));
    const refusal = new Error("permission refused");
    const { tools, cleanup, callKey } = await loadPlugin(
      server.url,
      async (request) => {
        if ((request as { source: { id: string } }).source.id === "refused")
          throw refusal;
      }
    );
    const send = tools.get("organization_send_message")!.execute;
    await expect(send({ body: "x" }, context("refused"))).rejects.toBe(refusal);
    // 거부 뒤에 보낸 호출이 끝난 것을 순서 신호로 삼아, 서버가 받은 것이 그 호출 하나뿐인지 본다.
    await send({ body: "y" }, context("allowed"));
    expect(
      server.captured.map((x) => x.body.params._meta["idempotency-key"])
    ).toEqual([callKey(context("allowed"))]);
    cleanup?.();
  });

  it("refuses to send without a call identity and turns an error result into a tool error", async () => {
    const server = await mcpServer(() => ({
      isError: true,
      content: [{ type: "text", text: '{"error":{"code":"stage_closed"}}' }],
      structuredContent: { error: { code: "stage_closed" } },
    }));
    const { tools, cleanup } = await loadPlugin(server.url);
    const send = tools.get("organization_send_message")!.execute;
    await expect(
      send({ body: "x" }, { ...context("call_a"), id: undefined })
    ).rejects.toThrow("no call identity");
    expect(server.captured).toHaveLength(0);
    await expect(send({ body: "x" }, context("call_a"))).rejects.toThrow(
      '{"error":{"code":"stage_closed"}}'
    );
    cleanup?.();
  });
});
