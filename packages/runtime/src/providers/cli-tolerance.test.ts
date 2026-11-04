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

  it("reads an OpenCode event stream that ends lines with CRLF", async () => {
    const provider = createOpenCodeProvider({
      dataDir: await home(),
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--sse-crlf",
      ],
    });
    const result = await provider.adapter.execute(request(), control());
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

describe("Antigravity login", () => {
  const check = async (variant: string) =>
    adapters
      .antigravity(await home(), variant)
      .adapter.checkReadiness(new AbortController().signal);

  it("is judged by what the program does, not by a file", async () => {
    expect(await check("plain")).toEqual({ status: "ready", reason: null });
    expect(await check("logged-out")).toEqual({
      status: "not_ready",
      reason: "product_login_missing",
    });
    expect(await check("offline")).toEqual({
      status: "not_ready",
      reason: "check_failed",
    });
  }, 20_000);

  it("reports a run without a login as needing one", async () => {
    const { adapter } = adapters.antigravity(await home(), "logged-out");
    const result = await adapter.execute(request(), control());
    expect(result).toMatchObject({
      stopReason: "failed",
      errorCode: "login_required",
    });
  }, 20_000);
});

const withSession = (id: string) => ({
  ...request(),
  previousSession: { id },
});

describe("what the program reports", () => {
  it("does not take a Claude error result for a success", async () => {
    const { adapter } = adapters.claude(await home(), "api-error");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("failed");
    expect(result.errorCode).toBeUndefined();
    expect(result.nextSession).toBeNull();
  }, 20_000);

  it.each(["claude", "codex app-server", "codex exec"] as const)(
    "%s reports a rejected login as needing one",
    async (name) => {
      const { adapter } = adapters[name](await home(), "auth-fail");
      const result = await adapter.execute(request(), control());
      expect(result).toMatchObject({
        stopReason: "failed",
        errorCode: "login_required",
      });
    },
    20_000
  );

  it("subtracts what the resumed Codex exec session already counted", async () => {
    const dataDir = await home();
    const { adapter } = adapters["codex exec"](dataDir, "cumulative");
    const first = await adapter.execute(request(), control());
    expect(first.usage).toMatchObject({
      inputTokens: 5219,
      cacheReadTokens: 38400,
      outputTokens: 461,
    });
    const second = await adapter.execute(
      { ...request(), previousSession: first.nextSession },
      control()
    );
    expect(second.usage).toMatchObject({
      inputTokens: 1698,
      cacheReadTokens: 31232,
      outputTokens: 130,
    });
  }, 20_000);
});

describe("a session that cannot be resumed", () => {
  it.each(["claude", "codex app-server", "codex exec"] as const)(
    "%s starts a new one whatever the program said",
    async (name) => {
      const { adapter } = adapters[name](await home(), "fails-on-resume");
      const progress: unknown[] = [];
      const result = await adapter.execute(withSession("old-session"), {
        signal: new AbortController().signal,
        emit: async (activity) => {
          progress.push(activity);
        },
      });
      expect(result.stopReason).toBe("completed");
      expect(JSON.stringify(progress)).toContain("새 세션");
    },
    20_000
  );

  it("OpenCode starts a new one for any refused session", async () => {
    const provider = createOpenCodeProvider({
      dataDir: await home(),
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    const result = await provider.adapter.execute(
      withSession("bad-format"),
      control()
    );
    expect(result.stopReason).toBe("completed");
  }, 20_000);
});

describe("Claude login and steering", () => {
  const check = async (variant: string) =>
    adapters
      .claude(await home(), variant)
      .adapter.checkReadiness(new AbortController().signal);

  it("asks the program whether it is logged in", async () => {
    expect((await check("plain")).status).toBe("unknown");
    expect(await check("logged-out")).toEqual({
      status: "not_ready",
      reason: "product_login_missing",
    });
  }, 20_000);

  it("runs without a token file when the program has another login", async () => {
    const dataDir = await home();
    await rm(path.join(dataDir, "providers/claude/setup-token"));
    const { adapter } = adapters.claude(dataDir, "plain");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 20_000);

  it("refuses a slash command but takes a message starting with a path", async () => {
    const { adapter } = adapters.claude(await home(), "waits-for-steer");
    const input = request();
    const steer = (body: string) =>
      adapter.steer!({
        runId: input.identity.runId,
        messageId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        body,
      });
    const outcomes: string[] = [];
    let started = false;
    const result = await adapter.execute(input, {
      signal: new AbortController().signal,
      emit: async () => {
        if (started) return;
        started = true;
        outcomes.push(await steer("/compact"));
        outcomes.push(await steer("/home/me/notes.md 를 봐 주세요"));
      },
    });
    expect(outcomes).toEqual(["rejected", "accepted"]);
    expect(result.stopReason).toBe("completed");
  }, 20_000);
});

describe("connections", () => {
  it("runs Codex when another login is in use and the status check says no", async () => {
    const { adapter } = adapters["codex app-server"](
      await home(),
      "no-file-login"
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 20_000);

  it("falls back to a listed model when OpenCode has no free one", async () => {
    const provider = createOpenCodeProvider({
      dataDir: await home(),
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--no-free",
      ],
    });
    const result = await provider.adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 20_000);

  it("gives each named connection its own id and folder", async () => {
    const dataDir = await home();
    const provider = createClaudeProvider({
      dataDir,
      id: "claude-work",
      label: "Claude Code (work)",
      command: quirky("claude", "plain"),
    });
    expect([provider.id, provider.label]).toEqual([
      "claude-work",
      "Claude Code (work)",
    ]);
    expect(provider.login?.env.HOME).toBe(
      path.join(dataDir, "providers/claude-work")
    );
    expect(provider.adapter.loginCommand).toContain("claude-work");
  });

  it("lets Claude take models beyond the short list", async () => {
    const { openModels } = adapters.claude(await home(), "plain");
    expect(openModels).toBe(true);
  });
});
