import {
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Workspaces } from "../src/workspace.ts";
import { unused } from "./stand-ins.ts";
import { testFolders } from "@babojubot/process/testing";

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
  const watched: Record<string, unknown> = {};
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
      // 불린 순간의 칸을 잡는다. await 뒤에 다시 찾으면 그 사이 afterEach가 바꾼 다음 시험의 것을 부른다.
      const { after } = probe;
      probe.seen.push(String(args[0]));
      const result = await real(...args);
      after?.(name, String(args[0]), result);
      return result;
    };
  }
  return { ...actual, ...watched, default: { ...actual, ...watched } };
});

const folders = testFolders();
afterEach(() => {
  probe.after = undefined;
});
const org = "organization-one";
async function folder() {
  const root = await realpath(await folders.make("babojubot-resolve-"));
  const shared = path.join(root, "organizations", org, "shared");
  await mkdir(path.join(shared, "dir"), { recursive: true });
  await writeFile(
    path.join(shared, "..", "workspace-identity.json"),
    JSON.stringify({ version: 1, organizationId: org })
  );
  await writeFile(path.join(shared, "dir", "a.md"), "MINE");
  return { root, shared };
}
/**
 * 읽은 결과(본문 또는 거부 이유)와, 서버 프로세스가 조직 폴더 안에서 본 위치(`looked`), 대역이 기록한 서버 프로세스의 모든 경로
 * (`recorded`, 대역이 서버의 호출을 실제로 기록하는지 보는 양성 대조).
 */
async function read(root: string, requested: string) {
  probe.seen = [];
  const result = await new Workspaces(root, unused("db")).readArtifact(
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
    recorded: [...probe.seen],
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
    const swappedAt: string[] = [];
    probe.after = (name, target) => {
      if (swappedAt.length || name !== "lstat" || target !== dir) return;
      swappedAt.push(target);
      renameSync(dir, `${dir}-kept`);
      symlinkSync(outside, dir, "dir");
    };
    const { answer, looked, recorded } = await read(root, "dir/a.md");
    // 양성 대조: 대역은 서버 프로세스의 호출을 기록한다(조직 폴더 바깥의 `organizations`를 푼 것). 그래서 아래 빈 `looked`는 기록이
    // 없어서가 아니라 서버 프로세스가 조직 폴더 안을 보지 않아서다.
    expect(recorded).toContain(path.join(root, "organizations"));
    expect(looked).toEqual([]);
    // 바꿔치기는 서버 프로세스가 그 폴더를 `lstat`할 때만 난다(회귀 때만 생기는 장면). 지금은 보지 않으므로 나지 않았다.
    expect(swappedAt).toEqual([]);
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
    const replacedAt: string[] = [];
    probe.after = (name, target, result) => {
      if (replacedAt.length || name !== "lstat" || target !== link) return;
      if (!(result as { isSymbolicLink(): boolean }).isSymbolicLink()) return;
      replacedAt.push(target);
      unlinkSync(link);
      replace(link);
    };
    const { answer, looked, recorded } = await read(root, "link.md");
    // 양성 대조(위 시험과 같음).
    expect(recorded).toContain(path.join(root, "organizations"));
    expect(looked).toEqual([]);
    // 바꿔치기는 서버 프로세스가 그 링크를 `lstat`할 때만 난다(회귀 때만 생기는 장면). 지금은 보지 않으므로 나지 않았다.
    expect(replacedAt).toEqual([]);
    expect(["MINE", "file_changed"]).toContain(answer);
  }
);
