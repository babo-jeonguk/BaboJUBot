import path from "node:path";
import { describe, it } from "vitest";
import { adapters, control, createCliHome } from "./cli-tolerance-support.ts";
import { createOpenCodeProvider } from "./opencode.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// 서로 독립인 실제 자식 프로세스 시나리오라 겹쳐 돌린다. 지연은 줄이지 않고, 홈은 테스트마다 하나씩 만들어 그 테스트가 끝날 때 지운다.
// 시험마다 정리를 따로 둔다(onTestFinished). 그 시험의 실행이 끝난 뒤 그 홈만 지운다.
const home = (folders: ReturnType<typeof testFolders>) =>
  createCliHome((root) => void folders.adopt(root));

describe.concurrent("slow programs", () => {
  it("lets Claude take longer than a few seconds to start", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const { adapter } = folders.ownProvider(
      adapters.claude(await home(folders), "slow-start")
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Antigravity take longer than a few seconds to start", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const { adapter } = folders.ownProvider(
      adapters.antigravity(await home(folders), "slow-start")
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Codex take longer than a few seconds to answer", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const { adapter } = folders.ownProvider(
      adapters["codex app-server"](await home(folders), "slow-answer")
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("does not lose a Codex run when a steer goes unanswered", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const { adapter } = folders.ownProvider(
      adapters["codex app-server"](await home(folders), "ignores-steer")
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
    const folders = testFolders(onTestFinished);
    const provider = folders.ownProvider(
      createOpenCodeProvider({
        dataDir: await home(folders),
        command: [
          process.execPath,
          path.resolve("test-fixtures/opencode-simulator.mjs"),
          "--slow-model",
        ],
      })
    );
    const result = await provider.adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 40_000);
});
