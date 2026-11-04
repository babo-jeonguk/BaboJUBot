import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const org = "organization-one";
async function folder() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-workspace-"));
  roots.push(root);
  const shared = path.join(root, "organizations", org, "shared");
  await mkdir(shared, { recursive: true });
  return { root, shared };
}
const read = (root: string, relative: string) =>
  new Workspaces(root, null as never).readArtifact(org, relative);

it("accepts a data folder reached through a symbolic link", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const linked = `${root}-link`;
  roots.push(linked);
  await symlink(root, linked);
  expect((await read(linked, "a.md")).content).toBe("내용");
});

it("accepts an organizations folder kept on another disk through a link", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const moved = `${root}-moved`;
  roots.push(moved);
  await rename(path.join(root, "organizations"), moved);
  await symlink(moved, path.join(root, "organizations"));
  expect((await read(root, "a.md")).content).toBe("내용");
});

// 조직 폴더 자체가 다른 조직을 가리키면 그 안에서 경로를 비교해도 소용없다. 경계는 데이터 폴더에서 정한다.
it.each(["shared", "."])(
  "refuses another organization's files when the organization's %s folder is replaced by a link",
  async (replaced) => {
    const { root, shared } = await folder();
    const other = path.join(
      root,
      "organizations",
      "organization-two",
      "shared"
    );
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "secret.md"), "다른 조직");
    await rm(shared, { recursive: true });
    if (replaced === "shared") await symlink(other, shared);
    else {
      await rm(path.dirname(shared), { recursive: true });
      await symlink(path.dirname(other), path.dirname(shared));
    }
    await expect(read(root, "secret.md")).rejects.toThrow();
  }
);

it("accepts a link that stays inside the folder and refuses one that leaves", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  await symlink(path.join(shared, "a.md"), path.join(shared, "inner.md"));
  expect((await read(root, "inner.md")).content).toBe("내용");
  await writeFile(path.join(root, "outside.md"), "밖");
  await symlink(path.join(root, "outside.md"), path.join(shared, "out.md"));
  await expect(read(root, "out.md")).rejects.toThrow();
  await expect(read(root, "../../../outside.md")).rejects.toThrow();
});

it("refuses a hard link because it can reach another organization's file", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(root, "outside.md"), "밖");
  await link(path.join(root, "outside.md"), path.join(shared, "hard.md"));
  await expect(read(root, "hard.md")).rejects.toThrow();
});

it("takes what a file holds now even if it is still being written", async () => {
  const { root, shared } = await folder();
  const file = path.join(shared, "run.log");
  await writeFile(file, "시작\n");
  const writer = setInterval(() => void appendFile(file, "더\n"), 1);
  try {
    for (let i = 0; i < 20; i++)
      expect((await read(root, "run.log")).file.size).toBeGreaterThan(0);
  } finally {
    clearInterval(writer);
  }
});
