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
import {
  configFailure,
  configScript,
  ownerMark,
} from "./antigravity-config.ts";
import { request } from "./test-support.ts";

// 설정 파일은 링크로 한 번에 나타나고 이미 있는 파일을 덮어쓰지 않는다(#101 결정 3). 우리 표시가 없는 파일은 비어 있어도 건드리지 않는다.
// 쓰기와 지우기는 처음 확인한 .agents 폴더 안에서만 일어난다. 그 폴더를 다른 조직으로 바꿔치기해도 그곳에는 닿지 않는다.
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
const script = (
  cwd: string,
  op: "clear" | "publish",
  plan: Record<string, unknown> = {}
) =>
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
    // 계획에 따라 자식은 입력을 읽기 전에 끝날 수 있다. 그때의 쓰기 오류(EPIPE)는 예상된 것이며 결과는 종료 코드로 본다.
    child.stdin!.on("error", () => {});
    child.stdin!.end(op === "publish" ? '{"token":"private"}' : "");
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

it("publishes the finished file in one step and cleans up", async () => {
  const { agents, execute } = await workspace();
  const result = await execute();
  expect(result.stopReason).toBe("completed");
  expect(await readdir(agents)).toEqual([]);
});

it("never publishes into another organization when .agents is swapped at any moment", async () => {
  const results = await atEveryMoment(12, async (plan) => {
    const { cwd, agents, otherAgents } = await workspace();
    const status = await script(cwd, "publish", {
      ...plan,
      from: agents,
      to: otherAgents,
    });
    expect(await readdir(otherAgents)).toEqual([]);
    return status;
  });
  // 시험이 헛돌지 않았는지 본다. 일부는 거부되고, 일부는 고정된 뒤라 원래 폴더에 쓴다.
  expect(results).toContain(0);
  expect(results.some((status) => status !== 0)).toBe(true);
}, 240_000);

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

// 게시는 이미 끝났다. 임시 파일을 못 지웠다고 실패로 알리면 호출자가 게시된 설정을 치우지 않는다.
it("reports success when only the temporary file could not be removed", async () => {
  const { cwd, config } = await workspace();
  const status = await script(cwd, "publish", { unlinkError: true });
  expect(status).toBe(0);
  expect(await readFile(config, "utf8")).toContain("private");
});

it("fails with the reason where hard links are not available", async () => {
  const { cwd, agents } = await workspace();
  const status = await script(cwd, "publish", { linkError: "ENOTSUP" });
  expect(configFailure(status)).toContain("하드링크");
  expect(await readdir(agents)).toEqual([]);
});

it("leaves a file somebody else created at the last moment", async () => {
  const { cwd, config } = await workspace();
  const status = await script(cwd, "publish", { createFirst: config });
  expect(configFailure(status)).toContain("제품 소유 파일이 아니거나");
  expect(await readFile(config, "utf8")).toBe("사용자 설정");
});

it.each([
  ["empty", ""],
  ["unfinished", '{"mcpServers"'],
  ["unmarked", '{"mcpServers":{}}'],
])("refuses and keeps an %s file without our mark", async (_name, content) => {
  const { root, config, execute } = await workspace();
  await writeFile(config, content);
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(await readFile(config, "utf8")).toBe(content);
  await cleanupAntigravityWorkspaces(root);
  expect(await readFile(config, "utf8")).toBe(content);
});

it("clears only leftovers carrying our mark, on a run and at server start", async () => {
  for (const clear of ["run", "start"]) {
    const { root, agents, config, execute } = await workspace();
    await writeFile(config, ownedLeftover);
    await writeFile(path.join(agents, ".babojubot-left.tmp"), ownedLeftover);
    await writeFile(path.join(agents, ".babojubot-notes.tmp"), "사용자 메모");
    if (clear === "run") expect((await execute()).stopReason).toBe("completed");
    else await cleanupAntigravityWorkspaces(root);
    expect(await readdir(agents)).toEqual([".babojubot-notes.tmp"]);
  }
});
