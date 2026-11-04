import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Workspaces } from "../src/workspace.ts";

// 경로를 확인한 뒤 파일을 열기 전에 중간 폴더를 바꿔치기해도 다른 조직의 파일을 읽지 않는다.
const hook = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | (() => Promise<void>),
  afterOpen: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      await hook.beforeOpen?.();
      const handle = await real.open(...args);
      await hook.afterOpen?.();
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  hook.beforeOpen = undefined;
  hook.afterOpen = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function organizations() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-race-"));
  roots.push(root);
  const mine = path.join(root, "organizations/organization-one/shared/dir");
  const other = path.join(root, "organizations/organization-two/shared/dir");
  await mkdir(mine, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(path.join(mine, "a.md"), "우리 조직");
  await writeFile(path.join(other, "a.md"), "다른 조직");
  const read = () =>
    new Workspaces(root, null as never).readArtifact(
      "organization-one",
      "dir/a.md"
    );
  const swap = async () => {
    await rename(mine, `${mine}-kept`);
    await symlink(other, mine);
  };
  const restore = async () => {
    await rm(mine);
    await rename(`${mine}-kept`, mine);
  };
  return { read, swap, restore };
}

it("reads the file when nothing changes", async () => {
  const { read } = await organizations();
  expect((await read()).content).toBe("우리 조직");
});

it("refuses a file reached through a folder swapped before opening", async () => {
  const { read, swap } = await organizations();
  hook.beforeOpen = swap;
  await expect(read()).rejects.toThrow();
});

it("refuses it even when the folder is put back right after opening", async () => {
  const { read, swap, restore } = await organizations();
  hook.beforeOpen = swap;
  hook.afterOpen = restore;
  await expect(read()).rejects.toThrow();
});
