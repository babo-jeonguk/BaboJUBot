import { afterEach, expect, it, vi } from "vitest";
import { commandFor, providerEnvironment } from "./process.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("passes network, certificate and locale settings but no personal secrets", () => {
  vi.stubEnv("HTTPS_PROXY", "http://proxy");
  vi.stubEnv("NODE_EXTRA_CA_CERTS", "/certs.pem");
  vi.stubEnv("LANG", "ko_KR.UTF-8");
  vi.stubEnv("ANTHROPIC_API_KEY", "personal-key");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "this-session");
  const env = providerEnvironment("claude", "/product", { HOME: "/product" });
  expect(env).toMatchObject({
    HTTPS_PROXY: "http://proxy",
    NODE_EXTRA_CA_CERTS: "/certs.pem",
    LANG: "ko_KR.UTF-8",
    HOME: "/product",
    PATH: process.env.PATH,
  });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
});

it("passes only the variables named for that connection", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "chosen");
  vi.stubEnv("OPENAI_API_KEY", "other");
  vi.stubEnv("BABOJUBOT_CLAUDE_WORK_PASS_ENV", "ANTHROPIC_API_KEY, MISSING");
  expect(
    providerEnvironment("claude-work", "/product", {}).ANTHROPIC_API_KEY
  ).toBe("chosen");
  expect(
    providerEnvironment("claude-work", "/product", {}).OPENAI_API_KEY
  ).toBeUndefined();
  expect(
    providerEnvironment("codex", "/product", {}).ANTHROPIC_API_KEY
  ).toBeUndefined();
});

// 이름은 사용자 설정에서 온다. process.env도 물려받은 이름(constructor·toString)에 함수를 돌려주므로 그 이름은 환경에 없는 변수다
// (#281 리뷰 REC-1과 같은 모양).
it("passes no inherited name written in the connection's list", () => {
  vi.stubEnv("BABOJUBOT_CLAUDE_WORK_PASS_ENV", "constructor, toString");
  const env = providerEnvironment("claude-work", "/product", {});
  expect(Object.hasOwn(env, "constructor")).toBe(false);
  expect(Object.hasOwn(env, "toString")).toBe(false);
});

it("lets the program location be chosen for a connection", () => {
  expect(commandFor("claude", "claude")).toEqual(["claude"]);
  vi.stubEnv("BABOJUBOT_CLAUDE_WORK_COMMAND", "/opt/claude/bin/claude");
  expect(commandFor("claude-work", "claude")).toEqual([
    "/opt/claude/bin/claude",
  ]);
});
