import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  cleanupAntigravityWorkspaces,
  createAntigravityProvider as unownedAntigravityProvider,
} from "./antigravity.ts";
import {
  clearOwnedConfig,
  configScriptFile,
  ownerMark,
  readCleanupReasons,
} from "./antigravity-config.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

/**
 * 공용 실행(`runTree`)의 결과를 갈음한다. 비어 있으면 실제로 돈다. 상한에 닿아 끈 명령은 끈 이유(`stopped`)와 그 트리를 끝낸 신호를
 * 함께 가질 수 있다. 두 값을 함께 가진 결과를 주입해 둘 다 남는지 본다(#286 리뷰 1회차 STD-2).
 */
const tree = vi.hoisted(() => ({
  run: undefined as undefined | (() => unknown),
}));
vi.mock("@babojubot/process", async (importOriginal) => {
  const real = await importOriginal<typeof import("@babojubot/process")>();
  return {
    ...real,
    runTree: (...args: Parameters<typeof real.runTree>) =>
      tree.run ? Promise.resolve(tree.run()) : real.runTree(...args),
  };
});
/** 상한에 닿아 끈 트리의 결과: 끈 이유와 끝낸 신호를 함께 가진다. */
const stoppedBySignal = () => ({
  started: true,
  code: null,
  signal: "SIGKILL",
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  stopped: "limit",
});
afterEach(() => {
  tree.run = undefined;
});

// 예전 판이 작업 폴더에 둔 설정의 남은 것만 서버 시작 때 지운다(#148부터 실행은 설정 파일을 쓰지 않는다). 우리 표시가 없는 파일은
// 비어 있어도 건드리지 않는다. 지우기는 처음 확인한 .agents 폴더 안에서만 일어난다. 그 폴더를 다른 조직으로 바꿔치기해도 그곳에는 닿지 않는다.
const folders = testFolders();
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createAntigravityProvider = folders.owning(unownedAntigravityProvider);
const ownedLeftover = JSON.stringify({ babojubotOwner: ownerMark });
async function workspace() {
  const created = await folders.make("agy-config-");
  const root = await realpath(created);
  const cwd = path.join(root, "organizations/one/shared");
  const agents = path.join(cwd, ".agents");
  const otherCwd = path.join(root, "organizations/two/shared");
  const otherAgents = path.join(otherCwd, ".agents");
  await mkdir(agents, { recursive: true });
  await mkdir(otherAgents, { recursive: true });
  const execute = () =>
    createAntigravityProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/quirky-cli.synthetic.mjs"),
        "antigravity",
        "plain",
      ],
    }).adapter.execute(
      {
        ...request(),
        workspace: { cwd, organization: cwd, personal: cwd, peers: [] },
      },
      { signal: new AbortController().signal, emit: async () => {} }
    );
  return {
    root,
    cwd,
    agents,
    otherAgents,
    config: path.join(agents, "mcp_config.json"),
    otherConfig: path.join(otherAgents, "mcp_config.json"),
    execute,
  };
}

// 스크립트의 파일 작업(작업 폴더 옮기기와 node:fs/promises의 확인·열기·지우기) 앞마다 끼어들 수 있게 해서 돌린다. 바꾼 함수가
// 스크립트가 가져오는 ES module(@babojubot/files 포함)에도 보이게 한다(node:module syncBuiltinESMExports).
const interrupt = `{
  const fs = process.getBuiltinModule("node:fs");
  const plan = JSON.parse(process.env.PLAN);
  let step = 0, busy = false;
  const quietly = (work) => {
    busy = true;
    try { work(); } catch {}
    busy = false;
  };
  const tick = () => {
    if (busy) return;
    step++;
    if (step === plan.swapAt)
      quietly(() => {
        fs.renameSync(plan.from, plan.from + "-kept");
        fs.symlinkSync(plan.to, plan.from, "dir");
      });
    if (step === plan.restoreAt)
      quietly(() => {
        fs.unlinkSync(plan.from);
        fs.renameSync(plan.from + "-kept", plan.from);
      });
  };
  for (const name of ["lstat", "stat", "open", "readdir", "unlink"]) {
    const real = fs.promises[name];
    fs.promises[name] = (...args) => { tick(); return real(...args); };
  }
  const chdir = process.chdir;
  process.chdir = (directory) => { tick(); chdir(directory); };
  process.getBuiltinModule("node:module").syncBuiltinESMExports();
}
`;
const script = (
  cwd: string,
  plan: Record<string, unknown> = {},
  preload = interrupt
) =>
  new Promise<{ status: number; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        configScriptFile,
        JSON.stringify([ownerMark]),
      ],
      {
        cwd,
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          PLAN: JSON.stringify(plan),
        },
      },
      (error, _stdout, stderr) =>
        resolve({
          status: error
            ? typeof error.code === "number"
              ? error.code
              : -1
            : 0,
          stderr: String(stderr),
        })
    );
    // 계획에 따라 자식은 입력을 읽기 전에 끝날 수 있다. 그때의 쓰기 오류(EPIPE)는 예상된 것이며 결과는 종료 코드로 본다.
    child.stdin!.on("error", () => {});
    child.stdin!.end();
  });
const moments = (last: number) => {
  const plans: { swapAt: number; restoreAt: number }[] = [];
  for (let swapAt = 1; swapAt <= last; swapAt++)
    for (let restoreAt = swapAt + 1; restoreAt <= last + 1; restoreAt++)
      plans.push({ swapAt, restoreAt });
  return plans;
};
async function atEveryMoment(
  last: number,
  attempt: (plan: { swapAt: number; restoreAt: number }) => Promise<number>
) {
  const queue = moments(last);
  const results: number[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let plan = queue.shift(); plan; plan = queue.shift())
        results.push(await attempt(plan));
    })
  );
  return results;
}

it("never removes another organization's file when .agents is swapped at any moment", async () => {
  const results = await atEveryMoment(10, async (plan) => {
    const { cwd, agents, config, otherAgents, otherConfig } = await workspace();
    await writeFile(config, ownedLeftover);
    await writeFile(otherConfig, ownedLeftover);
    const { status } = await script(cwd, {
      ...plan,
      from: agents,
      to: otherAgents,
    });
    expect(await readFile(otherConfig, "utf8")).toBe(ownedLeftover);
    return status;
  });
  expect(results).toContain(0);
  expect(results.some((status) => status !== 0)).toBe(true);
}, 240_000);

// 사용자(이 컴퓨터의 Antigravity 실행)가 같은 이름으로 새 설정을 저장하는 장면을 스크립트의 파일 작업 앞에 끼운다. 편집기처럼
// 다 쓴 임시 파일을 그 이름으로 옮긴다. `plan.at`이 "removal"이면 처음 지우는 작업 앞, "name"이면 설정 이름을 옮기거나 지우는
// 처음 작업 앞이다. 스크립트가 가져오는 ES module에도 보이게 한다(node:module syncBuiltinESMExports).
const userSave = `{
  const fs = process.getBuiltinModule("node:fs");
  const plan = JSON.parse(process.env.PLAN);
  let saved = false;
  for (const name of ["rename", "unlink"]) {
    const real = fs.promises[name];
    fs.promises[name] = (...args) => {
      const due = plan.at === "removal" ? name === "unlink" : String(args[0]) === "mcp_config.json";
      if (!saved && due) {
        saved = true;
        fs.writeFileSync(".user-save", plan.content);
        fs.renameSync(".user-save", "mcp_config.json");
      }
      return real(...args);
    };
  }
  process.getBuiltinModule("node:module").syncBuiltinESMExports();
}
`;

/** 정리 스크립트가 지우지 못한 까닭을 남긴 줄(한 줄에 JSON 하나). 서버는 이 구조만 기록한다. */
const reasons = (stderr: string) =>
  stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

// 정리는 우리 표시를 확인한 파일만 지운다. 확인한 뒤 같은 이름에 저장된 새 설정은 확인한 파일이 아니므로 지우지 않는다(#286 항목 8).
// 지우기 전에 저장됐으면 옛 설정은 이미 사라졌고 지울 것은 옮긴 이름의 우리 파일이라 정리가 끝난 것이다. 옮기기 전에 저장됐으면
// 옮긴 것이 사용자 설정이라 되돌리며, 옛 설정을 정리한 것이 아니므로 정리하지 못함(3)과 그 까닭을 남긴다(#286 리뷰 1회차 SPEC-1).
it.each([
  ["right before the removal", "removal", 0, []],
  [
    "right before the name is first moved or removed",
    "name",
    3,
    [{ reason: "restored", name: "mcp_config.json" }],
  ],
])(
  "keeps a configuration the user saved under the same name %s",
  async (_moment, at, status, why) => {
    const { cwd, agents, config } = await workspace();
    await writeFile(config, ownedLeftover);
    const saved = '{"mcpServers":{"mine":{}}}';
    const ended = await script(cwd, { at, content: saved }, userSave);
    expect(ended.status).toBe(status);
    expect(reasons(ended.stderr)).toEqual(why);
    expect(await readFile(config, "utf8")).toBe(saved);
    // 정리가 옮겨 둔 것을 남기지 않는다.
    expect(await readdir(agents)).toEqual(["mcp_config.json"]);
  }
);

it.each([
  ["empty", ""],
  ["unfinished", '{"mcpServers"'],
  ["unmarked", '{"mcpServers":{}}'],
])(
  "keeps an %s file without our mark, on a run and at server start",
  async (_name, content) => {
    const { root, config, execute } = await workspace();
    await writeFile(config, content);
    // 실행은 작업 폴더의 설정을 쓰지도 지우지도 않는다(조직 도구는 ACP 세션으로 준다).
    const result = await execute();
    expect(result.stopReason).toBe("completed");
    expect(await readFile(config, "utf8")).toBe(content);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    await cleanupAntigravityWorkspaces(root);
    expect(await readFile(config, "utf8")).toBe(content);
    // 지우지 않은 이유는 정리 스크립트가 남긴 문장으로 서버 기록에 보인다(옮긴 이름으로 남긴 파일의 위치도 같은 길로 보인다, #286).
    // 서버 기록에는 정해진 까닭과 직렬화한 이름만 남는다. 스크립트가 쓴 글을 그대로 옮기지 않는다(#286 리뷰 1회차 STD-1).
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      '[provider] the Antigravity configuration of organization one could not be cleared; unowned files are kept (unmarked "mcp_config.json")',
    ]);
  }
);

it("clears only leftovers carrying our mark at server start", async () => {
  {
    const { root, agents, config } = await workspace();
    await writeFile(config, ownedLeftover);
    await writeFile(path.join(agents, ".babojubot-left.tmp"), ownedLeftover);
    await writeFile(path.join(agents, ".babojubot-notes.tmp"), "사용자 메모");
    await cleanupAntigravityWorkspaces(root);
    expect(await readdir(agents)).toEqual([".babojubot-notes.tmp"]);
  }
});

it("names both why the configuration script was stopped and the signal that ended it", async () => {
  const { cwd } = await workspace();
  tree.run = stoppedBySignal;
  await expect(clearOwnedConfig(cwd)).rejects.toThrow(
    "the configuration script was stopped at its limit limit (signal SIGKILL)"
  );
});

// 설정 자리가 일반 파일이 아니면(폴더·링크) 우리 것인지 확인하지 못한 것이다. "표시 없음"과 다른 까닭으로 남긴다(#286 리뷰 1회차 SPEC-2 같은 모양).
it("keeps a configuration place that is not a regular file and says so", async () => {
  const { cwd, config } = await workspace();
  await mkdir(config);
  const ended = await script(cwd);
  expect(ended.status).toBe(3);
  expect(reasons(ended.stderr)).toEqual([
    { reason: "not_regular", name: "mcp_config.json" },
  ]);
});

// 열기 결과를 주입한다: `plan.miss`에 맞는 이름(정규식)을 처음 열 때 한 번 "없음"(ENOENT)으로 실패한다. 그 자리는 그대로 있으므로
// 바로 뒤 lstat은 일반 파일을 본다 — 확인하는 사이 자리가 바뀐 장면이다(실제 시간 지연 없이). `plan.take`가 있으면 그 실패 전에
// 그 경로에 새 파일을 둔다(그 사이 다른 쪽이 원래 이름에 저장한 장면).
const missOnce = `{
  const fs = process.getBuiltinModule("node:fs");
  const plan = JSON.parse(process.env.PLAN);
  const pattern = new RegExp(plan.miss);
  let missed = false;
  const real = fs.promises.open;
  fs.promises.open = (...args) => {
    if (!missed && pattern.test(String(args[0]))) {
      missed = true;
      if (plan.take) fs.writeFileSync(plan.take, "saved meanwhile");
      return Promise.reject(Object.assign(new Error("no such file"), { code: "ENOENT" }));
    }
    return real(...args);
  };
  process.getBuiltinModule("node:module").syncBuiltinESMExports();
}
`;

// 우리 임시 파일 이름인데 확인하는 사이 바뀌었거나 일반 파일이 아니면 우리 것인지 확인하지 못한 것이다. 건너뛰어 정리 성공(0)으로
// 접지 않고, 지우지 않은 채 그 까닭(3)을 남긴다(#286 리뷰 2회차 SPEC-3). 설정 파일 쪽과 같은 기준이다.
it("keeps a temporary file that changed while it was checked and says so", async () => {
  const { cwd, agents } = await workspace();
  const temporary = path.join(agents, ".babojubot-left.tmp");
  await writeFile(temporary, ownedLeftover);
  const ended = await script(
    cwd,
    { miss: "\\.babojubot-left\\.tmp$" },
    missOnce
  );
  expect(ended.status).toBe(3);
  expect(reasons(ended.stderr)).toEqual([
    { reason: "changed", name: ".babojubot-left.tmp" },
  ]);
  expect(await readFile(temporary, "utf8")).toBe(ownedLeftover);
});

it("keeps a temporary file place that is not a regular file and says so", async () => {
  const { cwd, agents } = await workspace();
  await mkdir(path.join(agents, ".babojubot-dir.tmp"));
  const ended = await script(cwd);
  expect(ended.status).toBe(3);
  expect(reasons(ended.stderr)).toEqual([
    { reason: "not_regular", name: ".babojubot-dir.tmp" },
  ]);
  expect(await readdir(agents)).toEqual([".babojubot-dir.tmp"]);
});

// 옮긴 설정을 다시 확인하는 사이 바뀌었으면 "우리 것 아님"이 아니라 확인하지 못한 것이다. 되돌리고 그 까닭(changed)을 남긴다.
// "restored"(사용자 설정을 되돌림)로 적지 않는다(#286 리뷰 2회차 SPEC-3 같은 모양).
it("puts the configuration back and says it changed when the moved file changes while it is confirmed", async () => {
  const { cwd, agents, config } = await workspace();
  await writeFile(config, ownedLeftover);
  const ended = await script(
    cwd,
    { miss: "\\.mcp_config\\.json\\.[0-9a-f-]+\\.removing$" },
    missOnce
  );
  expect(ended.status).toBe(3);
  expect(reasons(ended.stderr)).toEqual([
    { reason: "changed", name: "mcp_config.json" },
  ]);
  expect(await readFile(config, "utf8")).toBe(ownedLeftover);
  expect(await readdir(agents)).toEqual(["mcp_config.json"]);
});

// 옮긴 설정을 확인하지 못했는데 그 사이 원래 이름이 차지돼 되돌리지 못하면, 옮긴 이름에 남긴 위치를 정해진 모양(JSON 한 줄)의 까닭에
// 담는다. 사람이 읽을 글로 쓰지 않으므로 서버가 그 위치까지 읽는다(#296 외부 리뷰 1회차 STD-1·SPEC-2).
it("names where it kept the configuration when it could neither confirm it nor put it back, up to the server's reading", async () => {
  const { cwd, agents, config } = await workspace();
  await writeFile(config, ownedLeftover);
  const ended = await script(
    cwd,
    { miss: "\\.mcp_config\\.json\\.[0-9a-f-]+\\.removing$", take: config },
    missOnce
  );
  expect(ended.status).toBe(3);
  const read = readCleanupReasons(ended.stderr, false);
  expect(read).toEqual([
    {
      reason: "changed",
      name: "mcp_config.json",
      keptAs: expect.stringMatching(
        /^\.mcp_config\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removing$/
      ),
    },
  ]);
  const keptAs = read[0]!.keptAs!;
  expect(await readFile(path.join(agents, keptAs), "utf8")).toBe(ownedLeftover);
  expect(await readFile(config, "utf8")).toBe("saved meanwhile");
});
