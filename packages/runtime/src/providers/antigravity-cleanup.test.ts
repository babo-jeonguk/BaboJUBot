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
import { createAntigravityProvider } from "./antigravity.ts";
import { configRefused } from "./antigravity-config.ts";
import { request } from "./test-support.ts";

// 설정을 쓰는 프로세스가 도중에 끝나면 게시됐는지 알 수 없다. 거부가 확실한 경우만 빼고 치운다.
const helper = vi.hoisted(() => ({
  after: undefined as undefined | (() => number),
  clears: 0,
}));
vi.mock("./antigravity-config.ts", async (original) => {
  const real = await original<typeof import("./antigravity-config.ts")>();
  return {
    ...real,
    publishConfig: async (cwd: string, content: string) => {
      const status = await real.publishConfig(cwd, content);
      return helper.after ? helper.after() : status;
    },
    clearOwnedConfig: async (cwd: string) => {
      helper.clears++;
      await real.clearOwnedConfig(cwd);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  helper.after = undefined;
  helper.clears = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "agy-cleanup-"));
  roots.push(root);
  const cwd = path.join(root, "work");
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
  return { agents, config: path.join(agents, "mcp_config.json"), execute };
}

it("clears a configuration that may have been published when the helper ends unexpectedly", async () => {
  const { agents, execute } = await workspace();
  helper.after = () => 1;
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(await readdir(agents)).toEqual([]);
});

it("clears it when the helper could not be waited for", async () => {
  const { agents, execute } = await workspace();
  helper.after = () => {
    throw new Error("timed out");
  };
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(await readdir(agents)).toEqual([]);
});

it("does not touch anything after a certain refusal", async () => {
  const { config, execute } = await workspace();
  await writeFile(config, "사용자 설정");
  const result = await execute();
  expect(result.stopReason).toBe("failed");
  expect(helper.clears).toBe(0);
  expect(await readFile(config, "utf8")).toBe("사용자 설정");
  expect(configRefused(3)).toBe(true);
  expect(configRefused(1)).toBe(false);
});
