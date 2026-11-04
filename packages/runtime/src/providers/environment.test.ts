import { afterEach, expect, it } from "vitest";
import { commandFor, providerEnvironment } from "./process.ts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

it("passes network, certificate and locale settings but no personal secrets", () => {
  process.env.HTTPS_PROXY = "http://proxy";
  process.env.NODE_EXTRA_CA_CERTS = "/certs.pem";
  process.env.LANG = "ko_KR.UTF-8";
  process.env.ANTHROPIC_API_KEY = "personal-key";
  process.env.CLAUDE_CODE_SESSION_ID = "this-session";
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
  process.env.ANTHROPIC_API_KEY = "chosen";
  process.env.OPENAI_API_KEY = "other";
  process.env.BABOJUBOT_CLAUDE_WORK_PASS_ENV = "ANTHROPIC_API_KEY, MISSING";
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

it("lets the program location be chosen for a connection", () => {
  expect(commandFor("claude", "claude")).toEqual(["claude"]);
  process.env.BABOJUBOT_CLAUDE_WORK_COMMAND = "/opt/claude/bin/claude";
  expect(commandFor("claude-work", "claude")).toEqual([
    "/opt/claude/bin/claude",
  ]);
});
