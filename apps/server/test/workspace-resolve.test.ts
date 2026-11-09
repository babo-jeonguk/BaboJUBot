import {
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Workspaces } from "../src/workspace.ts";

// 서버 프로세스가 경로를 풀면서 본 위치를 남기고, 본 바로 뒤에 바꿔치기를 넣는다.
// 경로는 고정한 폴더에서 읽는 프로세스 안에서만 풀어야 한다. 서버 프로세스가 경로로 한 칸씩 보면 그 사이의 바꿔치기로
// 바깥을 보게 된다(PR #131 리뷰 2회차 S2·P3).
const probe = vi.hoisted(() => ({
  seen: [] as string[],
  after: undefined as
    ((name: string, target: string, result: unknown) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const watched = {} as Record<string, unknown>;
  for (const name of [
    "lstat",
    "stat",
    "readlink",
    "realpath",
    "readFile",
    "open",
    "opendir",
    "readdir",
    "access",
  ] as const) {
    const real = actual[name] as (...args: unknown[]) => Promise<unknown>;
    watched[name] = async (...args: unknown[]) => {
      probe.seen.push(String(args[0]));
      const result = await real(...args);
      probe.after?.(name, String(args[0]), result);
      return result;
    };
  }
  return { ...actual, ...watched, default: { ...actual, ...watched } };
});

const roots: string[] = [];
afterEach(async () => {
  probe.after = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const org = "organization-one";
async function folder() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "babojubot-resolve-"))
  );
  roots.push(root);
  const shared = path.join(root, "organizations", org, "shared");
  await mkdir(path.join(shared, "dir"), { recursive: true });
  await writeFile(
    path.join(shared, "..", "workspace-identity.json"),
    JSON.stringify({ version: 1, organizationId: org })
  );
  await writeFile(path.join(shared, "dir", "a.md"), "MINE");
  return { root, shared };
}
/** 읽은 결과(본문 또는 거부 이유)와, 서버 프로세스가 조직 폴더 안에서 본 위치. */
async function read(root: string, requested: string) {
  probe.seen = [];
  const result = await new Workspaces(root, null as never).readArtifact(
    org,
    requested
  );
  const organization = path.join(root, "organizations", org);
  const looked = probe.seen.filter((seen) => {
    const relative = path.relative(organization, seen);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  return {
    answer: result.ok ? result.snapshot.content : result.refusal,
    looked,
  };
}

it("answers the same whether or not anything is outside when a folder in the path turns into a link leading out", async () => {
  const answers: string[] = [];
  for (const present of [true, false]) {
    const { root, shared } = await folder();
    const outside = path.join(root, "outside");
    if (present) {
      await mkdir(outside);
      await writeFile(path.join(outside, "a.md"), "OUTSIDE");
    }
    const dir = path.join(shared, "dir");
    let swapped = false;
    probe.after = (name, target) => {
      if (swapped || name !== "lstat" || target !== dir) return;
      swapped = true;
      renameSync(dir, `${dir}-kept`);
      symlinkSync(outside, dir, "dir");
    };
    const { answer, looked } = await read(root, "dir/a.md");
    expect(looked).toEqual([]);
    answers.push(answer);
  }
  expect(answers[0]).toBe(answers[1]);
  expect(answers).not.toContain("OUTSIDE");
});

it.each([
  ["gone", () => {}],
  ["a file", (link: string) => writeFileSync(link, "REPLACED")],
  ["a folder", (link: string) => mkdirSync(link)],
] as const)(
  "answers a link that is %s right after it is seen without a server error",
  async (_name, replace) => {
    const { root, shared } = await folder();
    const link = path.join(shared, "link.md");
    await symlink(path.join("dir", "a.md"), link);
    let replaced = false;
    probe.after = (name, target, result) => {
      if (replaced || name !== "lstat" || target !== link) return;
      if (!(result as { isSymbolicLink(): boolean }).isSymbolicLink()) return;
      replaced = true;
      unlinkSync(link);
      replace(link);
    };
    const { answer, looked } = await read(root, "link.md");
    expect(looked).toEqual([]);
    expect(["MINE", "file_changed"]).toContain(answer);
  }
);
