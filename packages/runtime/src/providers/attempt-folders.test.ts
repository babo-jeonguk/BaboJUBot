import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityProvider as unownedAntigravityProvider } from "./antigravity.ts";
import { createClaudeProvider as unownedClaudeProvider } from "./claude.ts";
import { createOpenCodeProvider as unownedOpenCodeProvider } from "./opencode.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// 이 파일이 띄우는 트리는 공용 실행 경계 대역이 띄운 직후 정리에 맡긴다. 장면(`treeScene`)으로 제품의 끄기를 실패로 답하게 한다.
vi.mock("@babojubot/process", async (original) =>
  (await import("./test-folders.ts")).owningLaunchTree(await original())
);
// 실행 시도가 쓰고 지우는 폴더(실행 시도 폴더, Antigravity 기록 폴더)를 지우다 실패하게 한다. 실패는 Windows에서 파일이
// 잠깐 잠겼을 때와 같은 오류(EBUSY)로, 다시 시도해도 계속 실패한다. 설정 파일 쓰기 실패도 같은 방법으로 만든다.
const inject = vi.hoisted(() => ({
  /** 이 이름이 경로에 든 폴더 지우기가 실패한다. */
  removeFails: undefined as RegExp | undefined,
  /** 이 이름으로 끝나는 파일 쓰기가 실패한다. */
  writeFails: undefined as string | undefined,
  /** 시험 중에 만들어진 임시 폴더. 지우지 못하게 한 폴더도 시험 정리가 지운다. */
  made: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof real.rm = async (target, options) => {
    if (inject.removeFails?.test(String(target)))
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm`), {
        code: "EBUSY",
      });
    return real.rm(target, options);
  };
  const writeFile: typeof real.writeFile = async (target, ...rest) => {
    if (inject.writeFails && String(target).endsWith(inject.writeFails))
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    return real.writeFile(target, ...rest);
  };
  const mkdtemp = (async (prefix: string) => {
    const made = await real.mkdtemp(prefix);
    inject.made.push(made);
    return made;
  }) as typeof real.mkdtemp;
  return {
    ...real,
    rm,
    writeFile,
    mkdtemp,
    default: { ...real, rm, writeFile, mkdtemp },
  };
});

const folders = testFolders();
const createClaudeProvider = folders.owning(unownedClaudeProvider);
const createOpenCodeProvider = folders.owning(unownedOpenCodeProvider);
const createAntigravityProvider = folders.owning(unownedAntigravityProvider);

afterEach(() => {
  inject.removeFails = undefined;
  inject.writeFails = undefined;
  for (const made of inject.made.splice(0)) folders.adopt(made);
  vi.restoreAllMocks();
});

const control = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});

/** console.warn·error로 남긴 줄. 지우지 못한 폴더의 진단을 본다. */
function diagnostics() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return () =>
    [...warn.mock.calls, ...error.mock.calls].map((call) =>
      call.map((part) => String(part)).join(" ")
    );
}

/** 지우지 못한 폴더의 진단: 연결과 실행 시도 ID가 보이고, 실행 시도의 토큰은 담기지 않는다. */
function expectDiagnostic(lines: string[], connection: string, runId: string) {
  expect(
    lines.some((line) => line.includes(connection) && line.includes(runId)),
    lines.join("\n")
  ).toBe(true);
  expect(lines.join("\n")).not.toContain("private-run-token");
}

/** `root` 아래 어디든 남은 `attempt-*` 폴더. */
async function attemptFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isDirectory() && entry.name.startsWith("attempt-"))
      found.push(path.join(entry.parentPath, entry.name));
  return found;
}

// 실행 시도 폴더를 끝내 지우지 못해도 이미 정해진 실행 결과는 그대로이고, 운영자가 찾을 수 있게 진단을 남긴다.
describe("an attempt folder that cannot be removed", () => {
  it("keeps a finished Claude Code run's result and records the folder", async () => {
    const root = await folders.make("babojubot-claude-");
    await mkdir(path.join(root, "providers/claude"), { recursive: true });
    await writeFile(
      path.join(root, "providers/claude/setup-token"),
      "synthetic-login",
      { mode: 0o600 }
    );
    const provider = createClaudeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        path.resolve("test-fixtures/claude-finish.synthetic.json"),
      ],
    });
    const input = request();
    const logged = diagnostics();
    inject.removeFails = /[\\/]attempt-/;

    const result = await provider.adapter.execute(input, control());

    expect(result.stopReason).toBe("completed");
    expectDiagnostic(logged(), "claude", input.identity.runId);
    inject.removeFails = undefined;
  });

  it("keeps a finished OpenCode run's result and records the folder", async () => {
    const root = await folders.make("opencode-test-");
    const provider = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    const input = request();
    const logged = diagnostics();
    inject.removeFails = /[\\/]attempt-/;

    const result = await provider.adapter.execute(input, control());

    expect(result.stopReason).toBe("completed");
    expectDiagnostic(logged(), "opencode", input.identity.runId);
    inject.removeFails = undefined;
  }, 20_000);

  it("keeps a finished Antigravity run's result and records its log folder", async () => {
    const root = await folders.make("agy-acp-");
    const fixture = path.join(root, "fixture.json");
    const rpc = (id: number, body: Record<string, unknown>) => ({
      frame: { jsonrpc: "2.0", id, ...body },
    });
    await writeFile(
      fixture,
      JSON.stringify({
        version: "9.9.9",
        argv: { acp: true, "--dangerously-skip-permissions": true },
        steps: [
          { input: { method: "initialize" } },
          rpc(1, { result: { protocolVersion: 1 } }),
          { input: { method: "session/new" } },
          rpc(2, { result: { sessionId: "saved" } }),
          {
            input: {
              method: "session/prompt",
              params: { sessionId: "saved" },
            },
          },
          rpc(3, { result: { stopReason: "end_turn" } }),
          { inputEnd: true },
          { exit: 0 },
        ],
      })
    );
    const provider = createAntigravityProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        fixture,
      ],
    });
    const input = {
      ...request(),
      workspace: { cwd: root, organization: root, personal: root, peers: [] },
    };
    const logged = diagnostics();
    inject.removeFails = /babojubot-agy-log-/;

    const result = await provider.adapter.execute(input, control());

    expect(result.stopReason).toBe("completed");
    expectDiagnostic(logged(), "antigravity", input.identity.runId);
    inject.removeFails = undefined;
  });
});

// OpenCode가 서버를 띄우기 전에 실패하면 그때까지 만든 실행 시도 폴더를 지운다.
describe("an OpenCode server that cannot be prepared", () => {
  it("leaves no attempt folder when writing its configuration fails", async () => {
    const root = await folders.make("opencode-test-");
    const provider = createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
      ],
    });
    inject.writeFails = "babojubot-organization-keys.js";

    const result = await provider.adapter.execute(request(), control());

    inject.writeFails = undefined;
    expect(result.stopReason).toBe("failed");
    expect(await attemptFolders(root)).toEqual([]);
  }, 20_000);
});

// 프로그램의 끝을 확인하지 못한 실행 시도(`done.ended`가 거짓)의 폴더는 그 프로그램이 아직 쓸 수 있다. 폴더는 남기고, 제품이 그 안에
// 넣은 자격 증명 사본(Claude Code는 조직 도구 토큰이 든 MCP 설정)만 지운 뒤 폴더 위치와 원인을 알린다(#286 3b-3, 사용자 결정).
// 공용 실행 경계 대역이 제품의 끄기를 실패로 답하게 해(트리는 실제로 끈다) 그런 실행 시도를 결정적으로 만든다. 끝을 확인한 실행
// 시도는 시작에 실패했어도 폴더를 지운다.
describe("an attempt whose programs were not confirmed ended", () => {
  /** 연결의 로그인을 둔 Claude Code 연결. */
  async function claude(command: [string, ...string[]]) {
    const root = await folders.make("babojubot-claude-");
    await mkdir(path.join(root, "providers/claude"), { recursive: true });
    await writeFile(
      path.join(root, "providers/claude/setup-token"),
      "synthetic-login",
      { mode: 0o600 }
    );
    return { root, provider: createClaudeProvider({ dataDir: root, command }) };
  }

  it("keeps the Claude Code attempt folder without its credential copy, and says where and why", async () => {
    const { root, provider } = await claude([
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      path.resolve("test-fixtures/claude-finish.synthetic.json"),
    ]);
    folders.treeScene({ failProductStop: "after-stopping" });
    const input = request();
    const logged = diagnostics();

    await provider.adapter.execute(input, control());

    const kept = await attemptFolders(root);
    expect(kept).toHaveLength(1);
    expect(await readdir(kept[0]!)).toEqual(["instructions.md"]);
    expect(
      logged().filter((line) => line.includes("were not confirmed ended"))
    ).toEqual([
      `[provider] the programs of run ${input.identity.runId} on connection claude were not confirmed ended (TREE_LEFT); its attempt folder is kept at ${kept[0]} without the credential copies put in it`,
    ]);
    expect(logged().join("\n")).not.toContain("private-run-token");
  });

  it("removes the folder of an attempt whose program could not start, since nothing is left to use it", async () => {
    const { root, provider } = await claude([
      path.resolve("test-fixtures/no-such-program"),
    ]);
    const logged = diagnostics();

    const result = await provider.adapter.execute(request(), control());

    expect(result.stopReason).toBe("failed");
    expect(await attemptFolders(root)).toEqual([]);
    expect(logged()).toContain(
      "[provider] the program could not start (ENOENT)"
    );
    expect(
      logged().filter((line) => line.includes("were not confirmed ended"))
    ).toEqual([]);
  });
});
