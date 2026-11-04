import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanupAntigravityWorkspaces,
  createAntigravityProvider,
} from "./antigravity.ts";
import { request } from "./test-support.ts";

// 설정 파일은 링크로 한 번에 나타나고 이미 있는 파일을 덮어쓰지 않는다(#101 결정 3). 우리 표시가 없는 파일은 비어 있어도 건드리지 않는다.
const fs = vi.hoisted(() => ({
  beforeLink: undefined as undefined | (() => Promise<void>),
  linkError: undefined as string | undefined,
  writes: [] as string[],
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    link: async (...args: Parameters<typeof real.link>) => {
      await fs.beforeLink?.();
      if (fs.linkError)
        throw Object.assign(new Error("link failed"), { code: fs.linkError });
      return real.link(...args);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      fs.writes.push(path.basename(String(args[0])));
      return real.writeFile(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  fs.beforeLink = undefined;
  fs.linkError = undefined;
  fs.writes.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const ownedLeftover = JSON.stringify({
  babojubotOwner: "babojubot-antigravity-v1",
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "agy-config-"));
  roots.push(root);
  const cwd = path.join(root, "organizations/one/shared");
  const agents = path.join(cwd, ".agents");
  await mkdir(agents, { recursive: true });
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
    agents,
    config: path.join(agents, "mcp_config.json"),
    execute,
  };
}

it("publishes the finished file in one step and cleans up", async () => {
  const { agents, execute } = await workspace();
  const result = await execute();
  expect(result.stopReason).toBe("completed");
  expect(fs.writes).not.toContain("mcp_config.json");
  expect(await readdir(agents)).toEqual([]);
});

it("fails with the reason where hard links are not available", async () => {
  const { agents, execute } = await workspace();
  fs.linkError = "ENOTSUP";
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(result.error).toContain("하드링크");
  expect(await readdir(agents)).toEqual([]);
});

it("leaves a file somebody else created at the last moment", async () => {
  const { config, execute } = await workspace();
  fs.beforeLink = async () => {
    await writeFile(config, "사용자 설정");
    fs.linkError = "EEXIST";
  };
  const result = await execute();
  expect(result.stopReason).toBe("failed");
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
