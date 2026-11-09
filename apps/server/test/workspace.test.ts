import {
  appendFile,
  cp,
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
import { WorkspaceIdentityError, Workspaces } from "../src/workspace.ts";

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
  await writeFile(
    path.join(shared, "..", "workspace-identity.json"),
    JSON.stringify({ version: 1, organizationId: org })
  );
  return { root, shared };
}
const read = (root: string, relative: string) =>
  new Workspaces(root, null as never).readArtifact(org, relative);
/** 받은 파일의 본문. 거부됐으면 실패한다. */
const content = async (root: string, relative: string) => {
  const result = await read(root, relative);
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result.snapshot.content;
};
const refusal = (refusal: string) => ({ ok: false, refusal });

it("accepts a data folder reached through a symbolic link", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const linked = `${root}-link`;
  roots.push(linked);
  await symlink(root, linked);
  expect(await content(linked, "a.md")).toBe("내용");
});

it("accepts an organizations folder kept on another disk through a link", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const moved = `${root}-moved`;
  roots.push(moved);
  await rename(path.join(root, "organizations"), moved);
  await symlink(moved, path.join(root, "organizations"));
  expect(await content(root, "a.md")).toBe("내용");
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
    await writeFile(
      path.join(other, "..", "workspace-identity.json"),
      JSON.stringify({ version: 1, organizationId: "organization-two" })
    );
    await writeFile(path.join(other, "secret.md"), "다른 조직");
    await rm(shared, { recursive: true });
    if (replaced === "shared") await symlink(other, shared);
    else {
      await rm(path.dirname(shared), { recursive: true });
      await symlink(path.dirname(other), path.dirname(shared));
    }
    expect(await read(root, "secret.md")).toEqual(
      refusal("path_outside_folder")
    );
  }
);

// 온전한 다른 조직의 폴더가 이 이름으로 옮겨져도 폴더가 자기 ID를 말하므로 구별된다.
it("refuses another organization's real folder moved to this organization's name", async () => {
  const { root, shared } = await folder();
  const mine = path.dirname(shared);
  const other = path.join(root, "organizations", "organization-two");
  await mkdir(path.join(other, "shared"), { recursive: true });
  await writeFile(
    path.join(other, "workspace-identity.json"),
    JSON.stringify({ version: 1, organizationId: "organization-two" })
  );
  await writeFile(path.join(other, "shared", "secret.md"), "다른 조직");
  await rename(mine, `${mine}-kept`);
  await rename(other, mine);
  await expect(read(root, "secret.md")).rejects.toThrow(WorkspaceIdentityError);
});

it.each([
  ["missing", null],
  ["unreadable", "{broken"],
  ["for another organization", JSON.stringify({ organizationId: "other" })],
])("refuses a folder whose mark is %s", async (_name, content) => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const marker = path.join(shared, "..", "workspace-identity.json");
  if (content === null) await rm(marker);
  else await writeFile(marker, content);
  await expect(read(root, "a.md")).rejects.toThrow(WorkspaceIdentityError);
});

it("refuses a mark reached through a link", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const marker = path.join(shared, "..", "workspace-identity.json");
  await writeFile(
    path.join(root, "elsewhere.json"),
    JSON.stringify({ organizationId: org })
  );
  await rm(marker);
  await symlink(path.join(root, "elsewhere.json"), marker);
  await expect(read(root, "a.md")).rejects.toThrow(WorkspaceIdentityError);
});

it("accepts a folder restored by copying, and a data folder that moved", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const organizations = path.join(root, "organizations");
  await cp(organizations, `${organizations}-copy`, { recursive: true });
  await rm(organizations, { recursive: true });
  await rename(`${organizations}-copy`, organizations);
  const moved = `${root}-moved`;
  roots.push(moved);
  await rename(root, moved);
  expect(await content(moved, "a.md")).toBe("내용");
});

it("accepts a link that stays inside the folder and refuses one that leaves", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  await symlink(path.join(shared, "a.md"), path.join(shared, "inner.md"));
  expect(await content(root, "inner.md")).toBe("내용");
  await writeFile(path.join(root, "outside.md"), "밖");
  await symlink(path.join(root, "outside.md"), path.join(shared, "out.md"));
  expect(await read(root, "out.md")).toEqual(refusal("path_outside_folder"));
  expect(await read(root, "../../../outside.md")).toEqual(
    refusal("path_outside_folder")
  );
});

it("refuses a hard link because it can reach another organization's file", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(root, "outside.md"), "밖");
  await link(path.join(root, "outside.md"), path.join(shared, "hard.md"));
  expect(await read(root, "hard.md")).toEqual(refusal("hard_link_refused"));
});

it("takes what a file holds now even if it is still being written", async () => {
  const { root, shared } = await folder();
  const file = path.join(shared, "run.log");
  await writeFile(file, "시작\n");
  const writer = setInterval(() => void appendFile(file, "더\n"), 1);
  try {
    for (let i = 0; i < 20; i++)
      expect((await content(root, "run.log")).length).toBeGreaterThan(0);
  } finally {
    clearInterval(writer);
  }
});

// #124: 에이전트가 스스로 고칠 수 있게 거부마다 이유가 다르다. 경로는 에이전트의 작업 폴더(조직 공유 폴더) 기준이다.
it("tells why a path is refused", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  await mkdir(path.join(shared, "directory"));
  await writeFile(
    path.join(shared, "big.bin"),
    Buffer.alloc(10 * 1024 * 1024 + 1)
  );
  // 작업 폴더의 이름을 한 번 더 붙인 경로(#103 시연의 실수)는 없는 파일이다.
  expect(await read(root, "shared/a.md")).toEqual(refusal("file_not_found"));
  expect(await read(root, "missing.md")).toEqual(refusal("file_not_found"));
  expect(await read(root, "a.md/inner.md")).toEqual(refusal("file_not_found"));
  expect(await read(root, "directory")).toEqual(refusal("not_regular_file"));
  expect(await read(root, ".")).toEqual(refusal("not_regular_file"));
  expect(await read(root, "big.bin")).toEqual(refusal("file_too_large"));
});

// 셸에서 흔히 쓰는 절대 경로도 작업 폴더 안을 가리키면 받는다. 경계는 실제 경로로 정하므로 밖은 그대로 거부한다.
it("accepts an absolute path inside the working folder and refuses one outside", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  await writeFile(path.join(root, "outside.md"), "밖");
  expect(await content(root, path.join(shared, "a.md"))).toBe("내용");
  expect(await read(root, path.join(root, "outside.md"))).toEqual(
    refusal("path_outside_folder")
  );
  // 데이터 폴더를 링크로 가리켜도 작업 폴더 경로는 그 링크 아래로 보인다.
  const linked = `${root}-link`;
  roots.push(linked);
  await symlink(root, linked);
  expect(
    await content(
      linked,
      path.join(linked, "organizations", org, "shared", "a.md")
    )
  ).toBe("내용");
});
