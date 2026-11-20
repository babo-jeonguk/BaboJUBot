import { expect, it } from "vitest";
import { createOrgToolClient, OrgToolError } from "./tools-client.ts";

// 조직 도구 HTTP 응답 본문 읽기. 본문을 받다 끊긴 것은 응답의 거절이 아니므로 그대로 드러낸다.

/** `respond`가 돌려주는 응답을 받는 조직 도구 client. 서버 주소는 쓰지 않는다. */
const clientAnswering = (respond: () => Response) =>
  createOrgToolClient({
    baseUrl: "http://127.0.0.1:9",
    token: "token",
    signal: new AbortController().signal,
    fetch: async () => respond(),
  });

/** 읽기 시작하자마자 `error`로 끊기는 본문. */
const brokenBody = (error: Error) =>
  new ReadableStream({
    pull(controller) {
      controller.error(error);
    },
  });

it("surfaces a body that breaks while it is read instead of taking it as a refusal without a code", async () => {
  const broken = new Error("connection reset");
  const client = clientAnswering(
    () => new Response(brokenBody(broken), { status: 500 })
  );
  await expect(client.getMessage("message-1")).rejects.toBe(broken);
});

it("takes a refusal whose body is not JSON as a refusal without a code", async () => {
  const client = clientAnswering(
    () => new Response("<html>bad gateway</html>", { status: 502 })
  );
  const error: unknown = await client
    .getMessage("message-1")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OrgToolError);
  expect(error).toMatchObject({ status: 502, code: undefined });
});
