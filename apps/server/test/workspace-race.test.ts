import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { pinnedReader, readerExit, Workspaces } from "../src/workspace.ts";

// 경로를 확인하는 사이에 폴더나 파일을 바꿔치기해도 다른 조직의 파일을 읽지 않는다.
// 읽는 프로세스의 파일 작업 앞뒤 모든 시점에 바꿔치기(필요하면 원상 복구까지)를 넣어 본다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function organizations() {
  const created = await mkdtemp(path.join(tmpdir(), "babojubot-race-"));
  roots.push(created);
  const root = await realpath(created);
  const base = path.join(root, "organizations");
  const mine = path.join(base, "organization-one/shared/dir");
  const other = path.join(base, "organization-two/shared/dir");
  await mkdir(mine, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(path.join(mine, "a.md"), "MINE");
  await writeFile(path.join(other, "a.md"), "FOREIGN");
  for (const id of ["organization-one", "organization-two"])
    await writeFile(
      path.join(base, id, "workspace-identity.json"),
      JSON.stringify({ version: 1, organizationId: id })
    );
  return { root, base, mine, other };
}
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
        if (plan.kind === "move") fs.renameSync(plan.to, plan.from);
        else fs.symlinkSync(plan.to, plan.from, plan.kind);
      });
    if (step === plan.restoreAt)
      quietly(() => {
        if (plan.kind === "move") fs.renameSync(plan.from, plan.to);
        else fs.unlinkSync(plan.from);
        fs.renameSync(plan.from + "-kept", plan.from);
      });
  };
  for (const name of ["lstatSync", "statSync", "openSync", "readSync"]) {
    const real = fs[name];
    fs[name] = (...args) => { tick(); return real(...args); };
  }
  const chdir = process.chdir;
  process.chdir = (directory) => { tick(); chdir(directory); };
}
`;
/** 거부한 시도의 종료 코드. 바꿔치기는 알려진 거부로만 끝나야 하며, 예상하지 못한 오류(`failed`)나 잡히지 않은 예외가 아니다. */
const exits: unknown[] = [];
const attempt = (cwd: string, plan: Record<string, unknown>) =>
  new Promise<string | null>((resolve) => {
    execFile(
      process.execPath,
      [
        "-e",
        interrupt + pinnedReader,
        JSON.stringify([1000, "organization-one", "shared", "dir", "a.md"]),
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
      (error, stdout) => {
        if (error) exits.push(error.code);
        resolve(error ? null : stdout);
      }
    );
  });

it("reads the file when nothing changes", async () => {
  const { root } = await organizations();
  const read = (relative: string) =>
    new Workspaces(root, null as never).readArtifact(
      "organization-one",
      relative
    );
  expect(await read("dir/a.md")).toMatchObject({
    ok: true,
    snapshot: { content: "MINE" },
  });
});

const steps = 18;
it.each([
  ["a folder in the path", "shared/dir", "shared/dir", "dir"],
  ["the whole organization folder", ".", ".", "move"],
  ["the organization folder", "shared", "shared", "dir"],
  ["the file itself", "shared/dir/a.md", "shared/dir/a.md", "file"],
] as const)(
  "never reads another organization's file when %s is swapped at any moment",
  async (_name, from, to, kind) => {
    const results: (string | null)[] = [];
    const plans: { swapAt: number; restoreAt: number }[] = [];
    for (let swapAt = 1; swapAt <= steps; swapAt++)
      for (let restoreAt = swapAt + 1; restoreAt <= steps + 1; restoreAt++)
        plans.push({ swapAt, restoreAt });
    // 동시에 조금씩 돌려 시간을 줄인다. 시도마다 폴더를 새로 만든다.
    const queue = [...plans];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let plan = queue.shift(); plan; plan = queue.shift()) {
          const { base } = await organizations();
          results.push(
            await attempt(base, {
              ...plan,
              from: path.join(base, "organization-one", from),
              to: path.join(base, "organization-two", to),
              kind,
            })
          );
        }
      })
    );
    expect(results).not.toContain("FOREIGN");
    // 시험이 헛돌지 않았는지 본다. 일부는 거부되고, 일부는 고정된 뒤라 원래 내용을 읽는다.
    expect(results).toContain(null);
    expect(results).toContain("MINE");
    const known: unknown[] = Object.values(readerExit).filter(
      (code) => code !== readerExit.failed
    );
    expect(exits.filter((code) => !known.includes(code))).toEqual([]);
    exits.length = 0;
  },
  240_000
);
