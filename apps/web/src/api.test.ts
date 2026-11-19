import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { ApiError, request } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

/** `body`를 오류 응답 본문으로 돌려주는 서버에 요청해 던져진 오류를 받는다. */
async function failureFor(body: string, status = 409) {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
  const error: unknown = await request(z.unknown(), "/api/x").catch(
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

test("a failure keeps the error code the server sent as text", async () => {
  const error = await failureFor(
    JSON.stringify({ error: { code: "organization_closed", message: "끝남" } })
  );
  expect(error.status).toBe(409);
  expect(error.code).toBe("organization_closed");
  expect(error.message).toBe("API 409 organization_closed");
});

test.each([
  ["a number", { error: { code: 42 } }],
  ["an object", { error: { code: { name: "organization_closed" } } }],
  ["null", { error: { code: null } }],
  ["missing", { error: {} }],
])(
  "a failure whose error code is %s is a plain failure without a code",
  async (_shape, body) => {
    const error = await failureFor(JSON.stringify(body), 500);
    expect(error.status).toBe(500);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("API 500");
  }
);

test.each([
  ["is not JSON", "<html>bad gateway</html>"],
  ["has no error object", JSON.stringify({ error: "nope" })],
  ["is not an object", JSON.stringify(["nope"])],
])("a failure whose body %s has no code", async (_shape, body) => {
  const error = await failureFor(body, 502);
  expect(error.status).toBe(502);
  expect(error.code).toBeUndefined();
});

test("a failure whose body cannot be read surfaces that read failure instead of a plain failure", async () => {
  const broken = new Error("connection reset");
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(broken);
          },
        }),
        { status: 500 }
      )
  );
  await expect(request(z.unknown(), "/api/x")).rejects.toBe(broken);
});
