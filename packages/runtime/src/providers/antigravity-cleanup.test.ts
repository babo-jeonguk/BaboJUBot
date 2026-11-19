import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { cleanupAntigravityWorkspaces } from "./antigravity.ts";
import { ownerMark } from "./antigravity-config.ts";
import { testFolders } from "./test-folders.ts";

// 예전 판이 작업 폴더에 남긴 설정을 서버 시작 때 치운다. 치우는 횟수를 센다.
const helper = vi.hoisted(() => ({ clears: 0 }));
vi.mock("./antigravity-config.ts", async (original) => {
  const real = await original<typeof import("./antigravity-config.ts")>();
  return {
    ...real,
    clearOwnedConfig: async (cwd: string) => {
      helper.clears++;
      await real.clearOwnedConfig(cwd);
    },
  };
});

const folders = testFolders();
afterEach(async () => {
  helper.clears = 0;
});
// 서버 시작 정리는 조직마다 별도 프로세스를 띄운다. 설정 폴더가 없는 조직까지 띄우면 조직 수만큼 시작이 느려진다.
it("checks at server start only the organizations that have a configuration folder", async () => {
  const root = await folders.make("agy-cleanup-");
  const organizations = path.join(root, "organizations");
  for (const name of ["no-folder-1", "no-folder-2", "no-folder-3"])
    await mkdir(path.join(organizations, name, "shared"), { recursive: true });
  await mkdir(path.join(organizations, "no-shared"), { recursive: true });
  const agents = path.join(organizations, "with-folder", "shared", ".agents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    path.join(agents, "mcp_config.json"),
    JSON.stringify({ babojubotOwner: ownerMark })
  );

  await cleanupAntigravityWorkspaces(root);

  expect(helper.clears).toBe(1);
  expect(await readdir(agents)).toEqual([]);
});

// 서버 시작은 이 정리 때문에 멈추지 않는다. 조직 폴더가 없으면 조용히 넘어가고, 그 밖의 이유로 목록을 읽지 못하면 경고하고 넘어간다.
it("stays quiet at server start when there is no organization folder", async () => {
  const root = await folders.make("agy-cleanup-");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  await cleanupAntigravityWorkspaces(root);

  expect(warn).not.toHaveBeenCalled();
  expect(helper.clears).toBe(0);
});

it("warns with the failure code and goes on when the organization folders cannot be listed", async () => {
  const root = await folders.make("agy-cleanup-");
  // 목록을 읽을 수 없는 자리: 폴더 자리에 파일이 있다(ENOTDIR). 없음과 다른 오류다.
  await writeFile(path.join(root, "organizations"), "");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  await cleanupAntigravityWorkspaces(root);

  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /organization folders could not be listed.*\(ENOTDIR\)/
    )
  );
  expect(helper.clears).toBe(0);
});
