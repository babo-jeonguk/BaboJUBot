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

// 설정 파일은 파일 시스템과 상관없이 한 번에 나타난다. 먼저 빈 파일로 자리를 잡고(덮어쓰지 않음) 완성본을 그 위로 옮긴다.
const fs = vi.hoisted(() => ({
  failMove: false,
  writes: [] as { file: string; data: string }[],
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    // 하드링크를 지원하지 않는 파일 시스템.
    link: async () => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      fs.writes.push({ file: String(args[0]), data: String(args[1]) });
      return real.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (fs.failMove)
        throw Object.assign(new Error("disk problem"), { code: "EIO" });
      return real.rename(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  fs.failMove = false;
  fs.writes.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
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

it("never shows a partly written configuration", async () => {
  const { config, agents, execute } = await workspace();
  const result = await execute();
  expect(result.stopReason).toBe("completed");
  // 임시 폴더가 링크를 거치는 시스템이 있어 전체 경로 대신 파일 이름으로 찾는다.
  const direct = fs.writes.filter(
    (write) => path.basename(write.file) === path.basename(config)
  );
  expect(direct.map((write) => write.data)).toEqual([""]);
  expect(await readdir(agents)).toEqual([]);
});

it("gives its place back when the finished file cannot be moved in", async () => {
  const { agents, execute } = await workspace();
  fs.failMove = true;
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(await readdir(agents)).toEqual([]);
});

it("runs after a crash left an empty place or a temporary file behind", async () => {
  const { config, agents, execute } = await workspace();
  await writeFile(config, "");
  await writeFile(path.join(agents, ".babojubot-left-behind.tmp"), "token");
  const result = await execute();
  expect(result.stopReason).toBe("completed");
  expect(await readdir(agents)).toEqual([]);
});

it("clears the same leftovers when the server starts", async () => {
  const { root, config, agents } = await workspace();
  await writeFile(config, "");
  await writeFile(path.join(agents, ".babojubot-left-behind.tmp"), "token");
  await cleanupAntigravityWorkspaces(root);
  expect(await readdir(agents)).toEqual([]);
});

it("still refuses a file with somebody else's content and leaves it", async () => {
  const { config, execute } = await workspace();
  await writeFile(config, '{"mcpServers"');
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(await readFile(config, "utf8")).toBe('{"mcpServers"');
});
