import { mkdtempSync } from "node:fs";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { callArming } from "@babojubot/process/call-arming";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityProvider as unownedAntigravityProvider } from "./antigravity.ts";
import { attemptFolder } from "./attempt-folder.ts";
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
// 결함은 그 시험이 고른 폴더(`in`)에서 제품이 `mkdtemp`로 만든 정확한 경로에만 건다. 대역이 만든 순간 그 경로를 결함 객체에 적고,
// 지우기·쓰기 대역은 불린 순간 잡은 결함의 그 경로만 본다(이름으로 고르지 않는다).
type Fault = {
  /** 제품이 이 폴더 바로 아래에 `mkdtemp`로 만든 폴더에 건다. */
  in: string;
  /** 그 폴더의 지우기가 실패하거나(`remove`), 그 폴더 안의 이 상대 경로 쓰기가 실패한다. */
  fails: "remove" | { write: string };
  /** 대역이 이 결함으로 만든 정확한 경로(만든 순간 적는다). */
  made: string[];
  /** 결함이 실제로 걸린 정확한 경로(실패시킬 때마다 적는다: 제품의 다시 시도도 남음). 시험은 결함이 그 대상에서 났음을 이것으로 본다. */
  failedAt: string[];
};
/**
 * 그 시험만의 경로로 고를 수 없는 결함(공유 임시 폴더에 생기는 폴더)은 그 시험이 부른 제품 호출에 묶는다: 시험이
 * `faultCalls.run(결함, () => 제품 호출, 끝)`으로 감싸고 대역은 불린 순간 `faultCalls.current()`로 그 호출의 결함을 잡는다. 그 호출이
 * 만드는 폴더는 시작 순간 무장에 등록한다(`acquire`). 무장의 끝은 폴더 정리의 단계로 맡겨(`armedRun`) 폴더를 지우기 전에 돈다.
 */
const faultCalls = callArming<Fault>();
const inject = vi.hoisted(() => ({
  /** 이 시험이 고른 결함. */
  fault: undefined as Fault | undefined,
  /** 끝난 파일 쓰기의 이름(실제 쓰기가 이행한 뒤 넣는다). */
  written: [] as string[],
  /** 지우기마다 그 대상과, 불린 순간 이미 끝나 있던 쓰기의 이름(첫 await 전에 기록한다). */
  removed: vi.fn<(target: string, writtenBefore: string[]) => void>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof real.rm = async (target, options) => {
    const fault = inject.fault ?? faultCalls.current();
    inject.removed(String(target), [...inject.written]);
    if (fault?.fails === "remove" && fault.made.includes(String(target))) {
      fault.failedAt.push(String(target));
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm`), {
        code: "EBUSY",
      });
    }
    return real.rm(target, options);
  };
  const writeFile: typeof real.writeFile = async (target, ...rest) => {
    // 기록 칸은 불린 순간 잡는다. 쓰기가 끝난 뒤 칸을 다시 찾으면 그 사이 afterEach가 연 다음 시험의 칸에 남는다.
    const { written } = inject;
    const fault = inject.fault ?? faultCalls.current();
    const fails = fault?.fails;
    if (
      fault &&
      typeof fails === "object" &&
      fault.made.some(
        (folder) => path.join(folder, fails.write) === String(target)
      )
    ) {
      fault.failedAt.push(String(target));
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    }
    await real.writeFile(target, ...rest);
    written.push(path.basename(String(target)));
  };
  // 만들기와 결함의 기록을 한 동기 구간에서 한다. 경로로 고른 결함(`inject.fault`)의 폴더는 그 시험의 폴더(`root`) 아래에 생겨 그
  // 폴더의 정리가 지운다. 무장의 문맥에서 만드는 폴더는 시작 순간 무장에 등록하고(끝난 무장이면 던진다), 그 시험의 정리가 맡는다.
  const mkdtemp = (async (prefix: string) => {
    const record = (fault: Fault | undefined) => {
      const made = mkdtempSync(prefix);
      if (fault && path.dirname(prefix) === fault.in) fault.made.push(made);
      return made;
    };
    const { fault } = inject;
    if (fault) return record(fault);
    return (
      faultCalls.acquire(async (armed) => record(armed)) ?? record(undefined)
    );
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

/**
 * 결함 `fault`로 무장한 제품 호출. 정리는 호출 전에 폴더 정리의 단계로 맡긴다(늦게 맡긴 단계부터 돈다): 무장이 만든 폴더 맡기기를 먼저,
 * 무장의 끝(`run`이 호출 전에 맡김)을 그 뒤에 등록해, 무장이 먼저 끝나고(진행 중인 만들기를 기다림) 그 폴더를 맡은 뒤 지운다.
 */
function armedRun<T>(fault: Fault, call: () => T): T {
  folders.own(async () => {
    for (const made of fault.made) folders.adopt(made);
  }, "the folders the call arming made");
  return faultCalls.run(fault, call, (end) =>
    folders.own(end, "the call arming")
  );
}

afterEach(() => {
  inject.fault = undefined;
  inject.written = [];
  inject.removed.mockReset();
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
    // Claude Code의 실행 시도 폴더는 그 조직 폴더(이 시험의 `root` 아래) 바로 아래에 생긴다.
    const fault: Fault = {
      in: path.join(
        root,
        "providers",
        "claude",
        "organizations",
        input.identity.organizationId
      ),
      fails: "remove",
      made: [],
      failedAt: [],
    };
    inject.fault = fault;

    const result = await provider.adapter.execute(input, control());

    expect(result.stopReason).toBe("completed");
    expect(fault.made).toHaveLength(1);
    // 결함이 그 폴더의 지우기에 걸렸다: 지우지 못한 그 폴더와 결함의 원인 코드가 남는다.
    expect([...new Set(fault.failedAt)]).toEqual(fault.made);
    expect(logged()).toContainEqual(
      expect.stringContaining(`it is left at ${fault.made[0]} (EBUSY)`)
    );
    expectDiagnostic(logged(), "claude", input.identity.runId);
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
    // 실행의 OpenCode 서버는 그 조직 폴더(이 시험의 `root` 아래) 바로 아래에 실행 시도 폴더를 만든다(연결 폴더의 서버는 로그인을
    // 옮길 때만 쓴다).
    const fault: Fault = {
      in: path.join(
        root,
        "providers",
        "opencode",
        "organizations",
        input.identity.organizationId
      ),
      fails: "remove",
      made: [],
      failedAt: [],
    };
    inject.fault = fault;

    const result = await provider.adapter.execute(input, control());

    expect(result.stopReason).toBe("completed");
    expect(fault.made).toHaveLength(1);
    expect([...new Set(fault.failedAt)]).toEqual(fault.made);
    expect(logged()).toContainEqual(
      expect.stringContaining(`it is left at ${fault.made[0]} (EBUSY)`)
    );
    expectDiagnostic(logged(), "opencode", input.identity.runId);
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
    // Antigravity의 기록 폴더는 이 컴퓨터의 임시 폴더 바로 아래에 생긴다. 그 폴더는 시험끼리 같아 경로로 가를 수 없으므로, 결함을 이
    // 시험이 부른 제품 호출에 묶는다(앞 시험의 늦은 만들기는 그 호출의 문맥이 아니라 걸리지 않는다).
    const fault: Fault = {
      in: tmpdir(),
      fails: "remove",
      made: [],
      failedAt: [],
    };

    const result = await armedRun(fault, () =>
      provider.adapter.execute(input, control())
    );

    expect(result.stopReason).toBe("completed");
    expect(fault.made).toHaveLength(1);
    expect([...new Set(fault.failedAt)]).toEqual(fault.made);
    // 결함이 그 폴더의 지우기에 걸렸다: 지우지 못한 그 폴더와 결함의 원인 코드가 남는다.
    expect(logged()).toContainEqual(
      expect.stringContaining(`it is left at ${fault.made[0]} (EBUSY)`)
    );
    expectDiagnostic(logged(), "antigravity", input.identity.runId);
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
    // 실행의 OpenCode 서버는 그 조직 폴더 바로 아래의 실행 시도 폴더 안 `plugins/` 아래에 설정을 쓴다.
    const input = request();
    const fault: Fault = {
      in: path.join(
        root,
        "providers",
        "opencode",
        "organizations",
        input.identity.organizationId
      ),
      fails: { write: path.join("plugins", "babojubot-organization-keys.js") },
      made: [],
      failedAt: [],
    };
    inject.fault = fault;

    const result = await provider.adapter.execute(input, control());

    expect(fault.made).toHaveLength(1);
    // 결함이 그 실행 시도 폴더 안의 그 설정 쓰기에 걸렸다.
    expect(fault.failedAt).toEqual([
      path.join(fault.made[0]!, "plugins", "babojubot-organization-keys.js"),
    ]);
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

// 실행 시도 폴더는 프로그램 띄우기와 자격 증명 사본 쓰기를 스스로 한다(#286 PR #299 외부 리뷰 1회차 SPEC-2와 같은 종류: 얻은 뒤에
// 등록받으면 지우기가 시작된 뒤의 등록이 정리 밖에 남는다). 지우기가 시작되면 띄우지도 쓰지도 않고, 지우기는 진행 중인 쓰기의 끝을
// 본 뒤 지운다. 지우기는 한 번이고, 다시 불러도 같은 지우기다.
describe("an attempt folder being removed", () => {
  const removingCode = { code: "attempt_folder_removing" };
  /** 끝을 확인한 프로그램 하나(지우기가 폴더를 통째로 지우는 길). */
  const endedProgram = () => ({
    end: vi.fn(),
    done: Promise.resolve({ ended: true, causes: [] as string[] }),
  });
  const made = async () => {
    const folder = await folders.make("attempt-removing-");
    return {
      folder,
      attempt: attemptFolder(folder, {
        kind: "attempt folder",
        connection: "test",
      }),
    };
  };

  it("starts no program and writes no credential copy once its removal began", async () => {
    const { folder, attempt } = await made();
    const removing = attempt.remove();
    const start = vi.fn(endedProgram);
    expect(() => attempt.usedBy(start)).toThrow(
      expect.objectContaining(removingCode)
    );
    expect(start).not.toHaveBeenCalled();
    await expect(
      attempt.credential("auth.json", "secret")
    ).rejects.toMatchObject(removingCode);
    expect(attempt.remove()).toBe(removing);
    await removing;
    expect(inject.written).toEqual([]);
    expect(await readdir(path.dirname(folder))).not.toContain(
      path.basename(folder)
    );
  });

  it("removes the folder only after a credential copy being written has been written", async () => {
    const { folder, attempt } = await made();
    attempt.usedBy(endedProgram);
    // 결과를 만들 때 바로 값으로 받는다(거절을 처리하지 않은 채 두지 않는다).
    const writing = attempt.credential("auth.json", "secret").then(
      (at) => ({ at }),
      (error: unknown) => ({ error })
    );
    const removing = attempt.remove();
    await removing;
    const removals = inject.removed.mock.calls.filter(
      ([target]) => target === folder
    );
    expect(removals[0]).toEqual([folder, ["auth.json"]]);
    expect(await writing).toMatchObject({ error: removingCode });
    expect(await readdir(path.dirname(folder))).not.toContain(
      path.basename(folder)
    );
  });
});
