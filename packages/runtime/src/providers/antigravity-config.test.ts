import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cleanupAntigravityWorkspaces,
  createAntigravityProvider,
} from "./antigravity.ts";
import { configScript, ownerMark } from "./antigravity-config.ts";
import { request } from "./test-support.ts";

// 예전 판이 작업 폴더에 둔 설정의 남은 것만 서버 시작 때 지운다(#148부터 실행은 설정 파일을 쓰지 않는다). 우리 표시가 없는 파일은
// 비어 있어도 건드리지 않는다. 지우기는 처음 확인한 .agents 폴더 안에서만 일어난다. 그 폴더를 다른 조직으로 바꿔치기해도 그곳에는 닿지 않는다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const ownedLeftover = JSON.stringify({ babojubotOwner: ownerMark });
async function workspace() {
  const created = await mkdtemp(path.join(tmpdir(), "agy-config-"));
  roots.push(created);
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

// 스크립트의 파일 작업 앞마다 끼어들 수 있게 해서 돌린다.
const interrupt = `{
  const fs = require("node:fs");
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
  for (const name of [
    "lstatSync", "statSync", "openSync", "fstatSync", "readdirSync", "mkdirSync",
    "writeFileSync", "linkSync", "unlinkSync",
  ]) {
    const real = fs[name];
    fs[name] = (...args) => {
      tick();
      if (
        name === "unlinkSync" &&
        plan.unlinkError &&
        String(args[0]).endsWith(".tmp")
      )
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      if (name === "linkSync" && plan.linkError)
        throw Object.assign(new Error("link failed"), { code: plan.linkError });
      if (name === "linkSync" && plan.createFirst) {
        busy = true;
        fs.writeFileSync(plan.createFirst, "사용자 설정");
        busy = false;
      }
      return real(...args);
    };
  }
  const chdir = process.chdir;
  process.chdir = (directory) => { tick(); chdir(directory); };
}
`;
const script = (cwd: string, op: "clear", plan: Record<string, unknown> = {}) =>
  new Promise<number>((resolve) => {
    const child = execFile(
      process.execPath,
      ["-e", interrupt + configScript, JSON.stringify([op])],
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
    const status = await script(cwd, "clear", {
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
