import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import {
  cliAdapters,
  control,
  createCliHome,
} from "./cli-tolerance-support.ts";
import { ProtocolTimeout } from "./codex-connection.ts";
import { createOpenCodeProvider as unownedOpenCodeProvider } from "./opencode.ts";
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
    const adapters = cliAdapters(folders);
    const { adapter } = adapters.claude(await home(folders), "slow-start");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Antigravity take longer than a few seconds to start", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const adapters = cliAdapters(folders);
    const { adapter } = adapters.antigravity(await home(folders), "slow-start");
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("lets Codex take longer than a few seconds to answer", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const adapters = cliAdapters(folders);
    const { adapter } = adapters["codex app-server"](
      await home(folders),
      "slow-answer"
    );
    const result = await adapter.execute(request(), control());
    expect(result.stopReason).toBe("completed");
  }, 30_000);

  it("does not lose a Codex run when a steer goes unanswered", async ({
    expect,
    onTestFinished,
  }) => {
    const folders = testFolders(onTestFinished);
    const adapters = cliAdapters(folders);
    const { adapter } = adapters["codex app-server"](
      await home(folders),
      "ignores-steer"
    );
    // 프로그램은 받은 끼워 넣기를 작업 폴더에 남긴다.
    const cwd = await folders.make("babojubot-steer-");
    const input = { ...request(), workspace: { cwd, organization: cwd } };
    const messageId = crypto.randomUUID();
    // 프로그램은 adapter가 응답을 기다리다 그만둔 뒤에야 턴을 끝낸다. 끼워 넣기가 그 전에 결과로 돌아오면(보내지 않았거나
    // 답을 받았으면) 턴이 끝나지 않으므로, 실행을 멈춰 시험이 그 결과로 실패하게 한다.
    const stop = new AbortController();
    let steered: Promise<{ outcome: unknown } | { error: unknown }> | undefined;
    const result = await adapter.execute(input, {
      signal: stop.signal,
      emit: async () => {
        steered ??= adapter.steer!({
          runId: input.identity.runId,
          messageId,
          conversationId: crypto.randomUUID(),
          body: "말",
        }).then(
          (outcome) => {
            stop.abort();
            return { outcome };
          },
          (error: unknown) => ({ error })
        );
      },
    });
    // 응답이 없으면 거절("rejected")이 아니라 전달 여부를 모르는 시한 초과다.
    expect(await steered).toEqual({ error: expect.any(ProtocolTimeout) });
    expect(result.stopReason).toBe("completed");
    const received = await readFile(
      path.join(cwd, "steers-received.jsonl"),
      "utf8"
    );
    expect(
      received
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    ).toEqual([{ messageId }]);
  }, 30_000);

  it("lets OpenCode answer slowly", async ({ expect, onTestFinished }) => {
    const folders = testFolders(onTestFinished);
    const createOpenCodeProvider = folders.owning(unownedOpenCodeProvider);
    const provider = createOpenCodeProvider({
      dataDir: await home(folders),
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
