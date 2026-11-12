import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupAntigravityWorkspaces } from "./antigravity.ts";
import { ownerMark } from "./antigravity-config.ts";

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

const roots: string[] = [];
afterEach(async () => {
  helper.clears = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
// 서버 시작 정리는 조직마다 별도 프로세스를 띄운다. 설정 폴더가 없는 조직까지 띄우면 조직 수만큼 시작이 느려진다.
it("checks at server start only the organizations that have a configuration folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-cleanup-"));
  roots.push(root);
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
