import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { createClaudeProvider } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import { createOpenCodeProvider } from "./opencode.ts";
import { request } from "./test-support.ts";

// 실제 프로그램이 흔히 하는 행동 때문에 멀쩡한 실행 시도를 버리지 않는다. 최종 결과를 받았으면 성공이고, 모르는 출력은 건너뛴다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-tolerance-"));
  roots.push(root);
  await mkdir(path.join(root, "providers/claude"), { recursive: true });
  await writeFile(path.join(root, "providers/claude/setup-token"), "login");
  await mkdir(path.join(root, "providers/antigravity/.gemini"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "providers/antigravity/.gemini/oauth_creds.json"),
    "{}"
  );
  return root;
}
const quirky = (kind: string, variant: string) =>
  [
    process.execPath,
    path.resolve("test-fixtures/quirky-cli.synthetic.mjs"),
    kind,
    variant,
  ] as [string, ...string[]];
const control = (emit: () => Promise<void> = async () => {}) => ({
  signal: new AbortController().signal,
  emit,
});

const adapters = {
  claude: (dataDir: string, variant: string) =>
    createClaudeProvider({ dataDir, command: quirky("claude", variant) }),
  "codex app-server": (dataDir: string, variant: string) =>
    createCodexProvider({ dataDir, command: quirky("codex", variant) }),
  "codex exec": (dataDir: string, variant: string) =>
    createCodexProvider({
      dataDir,
      mode: "exec",
      command: quirky("codex", variant),
    }),
  antigravity: (dataDir: string, variant: string) =>
    createAntigravityProvider({
      dataDir,
      command: quirky("antigravity", variant),
    }),
};

describe.each(Object.keys(adapters) as (keyof typeof adapters)[])(
  "%s keeps a finished result",
  (name) => {
    it.each(["plain", "banner", "exits-1", "slow-exit"])(
      "when the program behaves: %s",
      async (variant) => {
        const { adapter } = adapters[name](await home(), variant);
        const result = await adapter.execute(request(), control());
        expect(result.stopReason).toBe("completed");
      },
      20_000
    );
  }
);

describe("slow programs", () => {
  it("lets Claude take longer than a few seconds to start", async () => {
    const { adapter } = adapters.claude(await home(), "slow-start");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Antigravity take longer than a few seconds to start", async () => {
    const { adapter } = adapters.antigravity(await home(), "slow-start");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Codex take longer than a few seconds to answer", async () => {
    const { adapter } = adapters["codex app-server"](
      await home(),
      "slow-answer"
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("does not lose a Codex run when a steer goes unanswered", async () => {
    const { adapter } = adapters["codex app-server"](
      await home(),
      "ignores-steer"
    );
    const input = request();
    let steered: Promise<unknown> | undefined;
    const result = await adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {
        steered ??= adapter.steer!({
          runId: input.identity.runId,
          messageId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          body: "말",
        }).catch(() => "rejected");
      },
    });
    expect(result.stopReason).toBe("completed");
    expect(await steered).toBe("rejected");
  }, 30_000);

  it("lets OpenCode answer slowly", async () => {
    const provider = createOpenCodeProvider({
      dataDir: await home(),
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--slow-model",
      ],
    });
    const result = await provider.adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 40_000);
});

describe("unknown output", () => {
  it("lets Claude print a line longer than a few megabytes", async () => {
    const { adapter } = adapters.claude(await home(), "long-line");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 20_000);

  it("ignores an OpenCode event that is not JSON", async () => {
    const provider = createOpenCodeProvider({
      dataDir: await home(),
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--sse-noise",
      ],
    });
    const result = await provider.adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 20_000);
});

describe("failures around the run", () => {
  it("finishes the run when recording an activity fails", async () => {
    const { adapter } = adapters.claude(await home(), "plain");
    const result = await adapter.execute(
      request(),
      control(async () => {
        throw new Error("activity store is down");
      })
    );
    expect(result.stopReason).toBe("completed");
  }, 20_000);

  it.each(["codex app-server", "antigravity"] as const)(
    "%s runs when only the version probe fails",
    async (name) => {
      const { adapter } = adapters[name](await home(), "version-fails");
      const result = await adapter.execute(request(), control());
      expect(result.stopReason).toBe("completed");
    },
    20_000
  );

  it("still reports nothing as success when the program ends without a result", async () => {
    const dataDir = await home();
    const { adapter } = createClaudeProvider({
      dataDir,
      command: [process.execPath, "-e", "process.stdin.pause()"],
    });
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("failed");
  }, 20_000);
});
