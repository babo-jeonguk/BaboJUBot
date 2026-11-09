import {
  appendFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
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
// 서버가 만든 폴더 배치가 어긋난 것이라 에이전트가 고칠 경로 문제가 아니다(PR #131 리뷰 S1).
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
    await expect(read(root, "secret.md")).rejects.toThrow(
      WorkspaceIdentityError
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

// 링크 뒤의 `..`는 운영체제가 여는 것과 같은 파일을 고른다. Linux·macOS는 링크를 따라간 자리에서 올라가고,
// Windows는 경로의 `..`를 글자로 줄여 연다(Win32). 절대 경로를 서버가 글자로 먼저 줄이면 Linux·macOS에서 다른 파일이 된다(PR #131 리뷰 3회차 P5).
it("registers the file the operating system opens for `..` after a link, in relative and absolute paths and link targets", async () => {
  const { root, shared } = await folder();
  await mkdir(path.join(shared, "data", "deep"), { recursive: true });
  await writeFile(path.join(shared, "target.md"), "WRONG");
  await writeFile(path.join(shared, "data", "target.md"), "INTENDED");
  await symlink(path.join("data", "deep"), path.join(shared, "link"));
  const relative = `link${path.sep}..${path.sep}target.md`;
  const absolute = `${shared}${path.sep}${relative}`;
  await symlink(absolute, path.join(shared, "absolute.md"));
  await symlink(relative, path.join(shared, "relative.md"));
  for (const requested of [relative, absolute, "absolute.md", "relative.md"]) {
    const opened = await readFile(
      path.isAbsolute(requested)
        ? requested
        : `${shared}${path.sep}${requested}`,
      "utf8"
    );
    expect(opened, requested).toBe(
      process.platform === "win32" ? "WRONG" : "INTENDED"
    );
    expect(await content(root, requested), requested).toBe(opened);
  }
});

// 경로 끝의 구분자·`.`·겹친 구분자 같은 표기도 운영체제와 같게 다룬다. 운영체제가 열지 못하면 거부하고, 열면 같은 내용이다.
// Linux·macOS는 파일 뒤에 `/`나 `/.`가 남으면 폴더가 아니므로 열 수 없다(ENOTDIR, PR #131 리뷰 4회차 P7). Windows는 입력한 경로의 끝 구분자는 떼고 열지만, 끝이 구분자인 링크 대상은 열지 못한다.
it("treats the spelling of a path the way the operating system does", async () => {
  const { root, shared } = await folder();
  const sep = path.sep;
  await mkdir(path.join(shared, "dir"));
  await writeFile(path.join(shared, "report.md"), "CONTENT");
  await writeFile(path.join(shared, "dir", "a.md"), "A");
  await symlink(`report.md${sep}.`, path.join(shared, "alias.md"));
  await symlink(`report.md${sep}`, path.join(shared, "alias-slash.md"));
  await symlink(`dir${sep}`, path.join(shared, "dir-link"));
  const cases = [
    `report.md${sep}`,
    `report.md${sep}.`,
    "alias.md",
    "alias-slash.md",
    `dir${sep}`,
    `dir${sep}.`,
    `dir-link${sep}a.md`,
    "dir-link",
    `dir${sep}${sep}a.md`,
    `.${sep}dir${sep}.${sep}a.md`,
    "",
    `dir${sep}a.md${sep}..`,
    `${shared}${sep}report.md${sep}`,
    `${shared}${sep}report.md${sep}.`,
    `${shared}${sep}${sep}dir${sep}a.md`,
    `${shared}${sep}`,
  ];
  // 어긋난 표기를 한 번에 모두 보인다.
  const mismatches: string[] = [];
  for (const requested of cases) {
    const opened = await readFile(
      path.isAbsolute(requested) ? requested : `${shared}${sep}${requested}`,
      "utf8"
    ).catch((error: NodeJS.ErrnoException) => ({ refused: error.code }));
    const result = await read(root, requested);
    const ours = result.ok
      ? result.snapshot.content
      : { refused: result.refusal };
    if (
      (typeof opened === "string") !== (typeof ours === "string") ||
      (typeof opened === "string" && opened !== ours)
    )
      mismatches.push(
        `${JSON.stringify(requested)}: os ${JSON.stringify(opened)}, ours ${JSON.stringify(ours)}`
      );
  }
  expect(mismatches).toEqual([]);
  // 파일을 폴더처럼 지나가려 한 것은 파일이 없는 것과 같다.
  if (process.platform !== "win32")
    for (const requested of [
      `report.md${sep}`,
      "alias.md",
      `${shared}${sep}report.md${sep}.`,
    ])
      expect(await read(root, requested), requested).toEqual(
        refusal("file_not_found")
      );
});

// 절대 경로의 작업 폴더 부분은 이름 그대로 같아야 한다. 그 안에 `..`를 섞어 돌아오는 드문 경로는 폴더 밖으로 본다.
// Windows는 운영체제처럼 글자로 먼저 줄이므로 작업 폴더 안의 파일이다.
it("refuses an absolute path that wanders out of the working folder part and back, except on Windows", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(shared, "a.md"), "내용");
  const back = [shared, "..", "shared", "a.md"].join(path.sep);
  if (process.platform === "win32")
    expect(await content(root, back)).toBe("내용");
  else expect(await read(root, back)).toEqual(refusal("path_outside_folder"));
});

// PR #131 리뷰 S1: 작업 폴더 밖은 그곳에 무엇이 있는지 보지 않고 거부한다. 있든 없든, 링크로 가리키든 같은 응답이다.
it("refuses every path outside the working folder the same way, whether or not something is there", async () => {
  const { root, shared } = await folder();
  await writeFile(path.join(root, "outside.md"), "밖");
  await mkdir(path.join(root, "outside-dir"));
  const outside = [
    "../../../outside.md",
    "../../../missing.md",
    "../workspace-identity.json",
    "../nothing.md",
    path.join(root, "outside.md"),
    path.join(root, "missing.md"),
    path.join(root, "missing-dir", "x.md"),
  ];
  for (const requested of outside)
    expect(await read(root, requested), requested).toEqual(
      refusal("path_outside_folder")
    );
  // 밖을 가리키는 링크도 대상이 있든 없든 같다. 폴더를 가리키는 링크를 거쳐도 같다.
  await symlink(path.join(root, "outside.md"), path.join(shared, "to-file.md"));
  await symlink(path.join(root, "missing.md"), path.join(shared, "to-none.md"));
  await symlink(path.join(root, "outside-dir"), path.join(shared, "to-dir"));
  await symlink("../../../missing-dir", path.join(shared, "to-none-dir"));
  for (const requested of [
    "to-file.md",
    "to-none.md",
    "to-dir/x.md",
    "to-none-dir/x.md",
  ])
    expect(await read(root, requested), requested).toEqual(
      refusal("path_outside_folder")
    );
});

it("follows links that stay inside, including relative and chained ones", async () => {
  const { root, shared } = await folder();
  await mkdir(path.join(shared, "data", "deep"), { recursive: true });
  await writeFile(path.join(shared, "data", "deep", "a.md"), "내용");
  await symlink("data/deep", path.join(shared, "short"));
  await symlink("short/a.md", path.join(shared, "chain.md"));
  await symlink(path.join(shared, "chain.md"), path.join(shared, "abs.md"));
  expect(await content(root, "short/a.md")).toBe("내용");
  expect(await content(root, "abs.md")).toBe("내용");
  // 남는 경로는 링크를 푼 실제 위치다.
  expect(await read(root, "abs.md")).toMatchObject({
    ok: true,
    snapshot: { file: { path: path.join("data", "deep", "a.md") } },
  });
  // 링크가 가리키는 곳에 없는 파일은 그대로 없는 파일이다.
  await symlink("data/none.md", path.join(shared, "dangling.md"));
  expect(await read(root, "dangling.md")).toEqual(refusal("file_not_found"));
});

// PR #131 리뷰 P2: 돌고 도는 링크는 없는 파일이 아니라 링크 문제로 알린다.
it("names a link loop", async () => {
  const { root, shared } = await folder();
  await symlink("b.md", path.join(shared, "a.md"));
  await symlink("a.md", path.join(shared, "b.md"));
  expect(await read(root, "a.md")).toEqual(refusal("link_loop"));
  await symlink(".", path.join(shared, "self"));
  expect(await read(root, "self/self/a.md")).toEqual(refusal("link_loop"));
});

it("treats a name too long for the file system as no file", async () => {
  const { root } = await folder();
  expect(await read(root, `${"가".repeat(200)}.md`)).toEqual(
    refusal("file_not_found")
  );
});
