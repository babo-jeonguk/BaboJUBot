import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { createClaudeProvider } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import { createOpenCodeProvider } from "./opencode.ts";
import { request } from "./test-support.ts";

// 서로 독립인 실제 자식 프로세스 시나리오라 겹쳐 돌린다. 지연은 줄이지 않고, 홈은 테스트마다 하나씩 만들어 그 테스트가 끝날 때 지운다.
async function home(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-tolerance-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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

describe.concurrent("slow programs", () => {
  it("lets Claude take longer than a few seconds to start", async ({
    expect,
    onTestFinished,
  }) => {
    const { adapter } = adapters.claude(
      await home(onTestFinished),
      "slow-start"
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Antigravity take longer than a few seconds to start", async ({
    expect,
    onTestFinished,
  }) => {
    const { adapter } = adapters.antigravity(
      await home(onTestFinished),
      "slow-start"
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Codex take longer than a few seconds to answer", async ({
    expect,
    onTestFinished,
  }) => {
    const { adapter } = adapters["codex app-server"](
      await home(onTestFinished),
      "slow-answer"
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("does not lose a Codex run when a steer goes unanswered", async ({
    expect,
    onTestFinished,
  }) => {
    const { adapter } = adapters["codex app-server"](
      await home(onTestFinished),
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

  it("lets OpenCode answer slowly", async ({ expect, onTestFinished }) => {
    const provider = createOpenCodeProvider({
      dataDir: await home(onTestFinished),
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
