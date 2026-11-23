import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  cleanupAntigravityWorkspaces,
  createAntigravityProvider as unownedAntigravityProvider,
} from "./antigravity.ts";
import { configScriptFile, ownerMark } from "./antigravity-config.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

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
  new Promise<number>((resolve) => {
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
      (error) =>
        resolve(error ? (typeof error.code === "number" ? error.code : -1) : 0)
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
    const status = await script(cwd, {
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

// 정리는 우리 표시를 확인한 파일만 지운다. 확인한 뒤 같은 이름에 저장된 새 설정은 확인한 파일이 아니므로 지우지 않는다(#286 항목 8).
it.each([
  ["right before the removal", "removal"],
  ["right before the name is first moved or removed", "name"],
])(
  "keeps a configuration the user saved under the same name %s",
  async (_moment, at) => {
    const { cwd, agents, config } = await workspace();
    await writeFile(config, ownedLeftover);
    const saved = '{"mcpServers":{"mine":{}}}';
    await script(cwd, { at, content: saved }, userSave);
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
    await cleanupAntigravityWorkspaces(root);
    expect(await readFile(config, "utf8")).toBe(content);
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
