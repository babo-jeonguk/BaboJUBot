import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { featureGaps, filesBase, remove, runPinned } from "./files-volume.ts";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readerExit, Workspaces } from "../src/workspace.ts";

// 링크로 바꿔치는 시험은 링크를 만들 수 없는 파일 시스템(FAT32)에서 건너뛴다. 폴더째 옮겨 바꾸는 시험은 그대로 돈다.
const lacks = await featureGaps();
const withLinks = it.skipIf(lacks.symlink !== "");

// 경로를 확인하는 사이에 폴더나 파일을 바꿔치기해도 다른 조직의 파일을 읽지 않는다.
// 읽는 프로세스의 파일 작업 앞뒤 모든 시점에 바꿔치기(필요하면 원상 복구까지)를 넣어 본다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(remove));
});
async function organizations() {
  const created = await mkdtemp(path.join(filesBase(), "babojubot-race-"));
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
  for (const name of ["lstatSync", "statSync", "openSync", "readSync", "readlinkSync"]) {
    const real = fs[name];
    fs[name] = (...args) => { tick(); return real(...args); };
  }
  const chdir = process.chdir;
  process.chdir = (directory) => { tick(); chdir(directory); };
}
`;
/** 거부한 시도의 종료 코드. 바꿔치기는 알려진 거부로만 끝나야 하며, 예상하지 못한 오류(`failed`)나 잡히지 않은 예외가 아니다. */
const exits: unknown[] = [];
/** 한 번 읽어 본 결과. 끝난 코드(성공이면 0)와 읽은 내용이다. */
const run = async (
  cwd: string,
  preload: string,
  plan: Record<string, unknown>,
  requested = "dir/a.md"
) => {
  const { code, bytes } = await runPinned(cwd, preload, { requested, plan });
  return { code, content: bytes?.toString("utf8") ?? null };
};
const attempt = async (cwd: string, plan: Record<string, unknown>) => {
  const result = await run(cwd, interrupt, plan);
  if (result.code !== 0) exits.push(result.code);
  return result.content;
};
/** 모든 바꿔치기 시점(필요하면 원상 복구 시점까지). */
const plans = () => {
  const all: { swapAt: number; restoreAt: number }[] = [];
  for (let swapAt = 1; swapAt <= steps; swapAt++)
    for (let restoreAt = swapAt + 1; restoreAt <= steps + 1; restoreAt++)
      all.push({ swapAt, restoreAt });
  return all;
};
/** 동시에 조금씩 돌려 시간을 줄인다. */
const parallel = async <T>(items: T[], work: (item: T) => Promise<void>) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift())
        await work(item);
    })
  );
};
const known: unknown[] = Object.values(readerExit).filter(
  (code) => code !== readerExit.failed
);

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

const steps = 26;
it.for([
  ["a folder in the path", "shared/dir", "shared/dir", "dir"],
  ["the whole organization folder", ".", ".", "move"],
  ["the organization folder", "shared", "shared", "dir"],
  ["the file itself", "shared/dir/a.md", "shared/dir/a.md", "file"],
] as const)(
  "never reads another organization's file when %s is swapped at any moment",
  { timeout: 240_000 },
  async ([, from, to, kind], context) => {
    if (kind !== "move" && lacks.symlink)
      context.skip(`no links on this file system (${lacks.symlink})`);
    const results: (string | null)[] = [];
    // 시도마다 폴더를 새로 만든다.
    await parallel(plans(), async (plan) => {
      const { base } = await organizations();
      results.push(
        await attempt(base, {
          ...plan,
          from: path.join(base, "organization-one", from),
          to: path.join(base, "organization-two", to),
          kind,
        })
      );
    });
    expect(results).not.toContain("FOREIGN");
    // 시험이 헛돌지 않았는지 본다. 일부는 거부되고, 일부는 고정된 뒤라 원래 내용을 읽는다.
    expect(results).toContain(null);
    expect(results).toContain("MINE");
    expect(exits.filter((code) => !known.includes(code))).toEqual([]);
    exits.length = 0;
  }
);

// 경로를 한 칸씩 풀어 가는 사이에 지나온 폴더를 바깥으로 가는 링크로 바꿔도, 답이 바깥에 무엇이 있는지에 따라
// 달라지지 않는다. 바깥에 폴더와 파일이 있을 때와 아무것도 없을 때를 같은 시점의 바꿔치기로 비교한다(PR #131 리뷰 2회차 S2).
withLinks(
  "answers the same whether or not anything is outside when a folder in the path turns into a link leading out at any moment",
  async () => {
    const answers = new Map<
      string,
      { code: unknown; content: string | null }[]
    >();
    await parallel(
      plans().flatMap((plan) => [
        { plan, present: true },
        { plan, present: false },
      ]),
      async ({ plan, present }) => {
        const { root, base } = await organizations();
        const outside = path.join(root, "outside");
        if (present) {
          await mkdir(outside);
          await writeFile(path.join(outside, "a.md"), "OUTSIDE");
        }
        const result = await run(base, interrupt, {
          ...plan,
          from: path.join(base, "organization-one", "shared", "dir"),
          to: outside,
          kind: "dir",
        });
        const key = JSON.stringify(plan);
        answers.set(key, [...(answers.get(key) ?? []), result]);
      }
    );
    const all = [...answers.values()].flat();
    expect(all.map((answer) => answer.content)).not.toContain("OUTSIDE");
    expect(all.map((answer) => answer.code)).toContain(0);
    expect(all.map((answer) => answer.code)).toContain(readerExit.changed);
    expect(
      all.filter((answer) => !known.includes(answer.code) && answer.code !== 0)
    ).toEqual([]);
    const differing = [...answers.entries()].filter(
      ([, [first, second]]) => JSON.stringify(first) !== JSON.stringify(second)
    );
    // Windows는 작업 폴더를 경로 문자열로 기억해, 바깥 링크로 바꿨다가 곧바로 되돌리면 바깥 폴더가 있을 때만 들어간 뒤
    // 원래 폴더를 읽는다. Node에는 폴더 핸들 기준으로 여는 기능이 없어 막지 못한다. Windows는 Docker 격리를 지원하지 않아
    // 에이전트가 서버와 같은 사용자로 바깥을 직접 볼 수 있으므로 이 차이는 경계가 아니다(docs/providers.md 격리 실행).
    // 다른 조직·바깥의 내용을 읽지 않는다는 위 검사는 Windows에서도 돈다.
    if (process.platform !== "win32") expect(differing).toEqual([]);
  },
  240_000
);

// 링크를 링크로 확인한 바로 뒤에 그 링크가 사라지거나 다른 것으로 바뀌면 파일이 바뀐 것이다. 서버 오류가 아니다(리뷰 2회차 P3).
const vanish = `{
  const fs = require("node:fs");
  const plan = JSON.parse(process.env.PLAN);
  const lstat = fs.lstatSync;
  let done = false;
  fs.lstatSync = (...args) => {
    const info = lstat(...args);
    if (!done && args[0] === plan.name && info.isSymbolicLink()) {
      done = true;
      fs.unlinkSync(plan.path);
      if (plan.then === "file") fs.writeFileSync(plan.path, "REPLACED");
      if (plan.then === "folder") fs.mkdirSync(plan.path);
    }
    return info;
  };
}
`;
withLinks.each(["gone", "file", "folder"])(
  "names a link that is %s right after it is seen as a changed file",
  async (then) => {
    const { base } = await organizations();
    const link = path.join(base, "organization-one", "shared", "link.md");
    await symlink(path.join("dir", "a.md"), link);
    expect(await run(base, "", {}, "link.md")).toEqual({
      code: 0,
      content: "MINE",
    });
    expect(
      await run(base, vanish, { name: "link.md", path: link, then }, "link.md")
    ).toEqual({ code: readerExit.changed, content: null });
  }
);
