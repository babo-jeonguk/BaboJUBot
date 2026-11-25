import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestDatabase,
  insertLegacyOrganization,
} from "@babojubot/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspaces, WorkspaceIdentityError } from "../src/workspace.ts";
import { within } from "./support.ts";
import { removeFolder } from "@babojubot/process/remove-folder";

// 조직 폴더 표식은 확인한 파일과 내용을 읽은 파일이 같아야 한다(#242). 경로로 종류·크기를 본 뒤 같은 경로를 다시 열면,
// 그 사이 바뀐 파일(다른 곳을 가리키는 링크, 상한보다 큰 파일)의 내용으로 조직을 판정한다.
// 서버가 표식 경로에 처음 닿은 바로 뒤에 그 자리를 다른 것으로 바꿔 그 사이를 만든다. 판정은 처음 닿은 파일의 것이어야 한다.
const swap = vi.hoisted(() => ({
  /** 이 경로에 처음 닿으면, 그 호출이 끝난 직후 `replacement`를 이 경로로 옮긴다. */
  path: undefined as string | undefined,
  replacement: undefined as string | undefined,
  /** 표식 쓰기가 파일을 만든 뒤 이 오류로 실패한다(디스크가 찬 경우처럼). */
  failWrite: undefined as Error | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const watched: Record<string, unknown> = {};
  for (const name of ["lstat", "stat", "open", "readFile", "access"] as const) {
    const call = real[name] as (...args: unknown[]) => Promise<unknown>;
    watched[name] = async (...args: unknown[]) => {
      const result = await call(...args);
      if (swap.path && String(args[0]) === swap.path && swap.replacement) {
        const target = swap.path;
        swap.path = undefined;
        await real.rename(swap.replacement, target);
      }
      return result;
    };
  }
  watched.writeFile = async (...args: Parameters<typeof real.writeFile>) => {
    if (swap.failWrite) {
      await real.writeFile(args[0], "", args[2]);
      throw swap.failWrite;
    }
    return real.writeFile(...args);
  };
  return { ...real, ...watched, default: { ...real, ...watched } };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  swap.path = undefined;
  swap.replacement = undefined;
  swap.failWrite = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const markOf = (organizationId: string, padding = 0) =>
  JSON.stringify({ version: 1, organizationId }) + " ".repeat(padding);

/** 표식을 둘 조직 폴더가 있는, 아직 표식 기록이 없는 조직 하나. */
async function organization() {
  const database = await createTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "identity-swap-"));
  cleanups.push(
    () => database.close(),
    () => removeFolder(root)
  );
  const org = await insertLegacyOrganization(database.db, "표식 바꿔치기");
  const folder = path.join(root, "organizations", org.id);
  await mkdir(folder, { recursive: true });
  return {
    id: org.id,
    root,
    folder,
    marker: path.join(folder, "workspace-identity.json"),
    ensure: () =>
      within(
        new Workspaces(root, database.db).ensure(org.id),
        10_000,
        "preparing the organization folder did not finish"
      ),
  };
}

// Windows에서 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하고, 열린 파일의 자리에 다른 파일을 옮기는 것도 막힐 수 있다.
describe.skipIf(process.platform === "win32")(
  "judging the folder mark by the one file it read",
  () => {
    it("accepts its own mark even when the place turns into a link to another organization's mark right after", async () => {
      const org = await organization();
      await writeFile(org.marker, markOf(org.id));
      const others = path.join(org.root, "others-mark.json");
      await writeFile(others, markOf("other-organization"));
      const link = path.join(org.folder, "swapped-in-link");
      await symlink(others, link);
      swap.path = org.marker;
      swap.replacement = link;

      await expect(org.ensure()).resolves.toBeDefined();
    });

    it("refuses another organization's mark even when the place turns into an oversized file naming this one right after", async () => {
      const org = await organization();
      await writeFile(org.marker, markOf("other-organization"));
      const oversized = path.join(org.folder, "swapped-in-file");
      await writeFile(oversized, markOf(org.id, 8192));
      swap.path = org.marker;
      swap.replacement = oversized;

      const refused = await org.ensure().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(WorkspaceIdentityError);
      expect((refused as Error).message).toMatch(/표식이 이 조직과 다릅니다/);
    });
  }
);

// 한 번 열어 확인하도록 바꿔도, 표식이 아닌 것을 표식으로 받지 않고 지금의 거부 문구를 그대로 낸다.
describe("refusing what is not a mark", () => {
  it("refuses an oversized mark even if it names this organization", async () => {
    const org = await organization();
    await writeFile(org.marker, markOf(org.id, 8192));
    await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
  });

  it("refuses a folder in the mark's place", async () => {
    const org = await organization();
    await mkdir(org.marker);
    await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a link in the mark's place, even to this organization's mark",
    async () => {
      const org = await organization();
      const elsewhere = path.join(org.root, "elsewhere.json");
      await writeFile(elsewhere, markOf(org.id));
      await symlink(elsewhere, org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
    }
  );

  // 표식 위 폴더의 링크 순환은 표식이 아니라 경로의 문제다. 링크를 따라가지 않는 열기도 같은 ELOOP을 내지만, 표식이 다르다고
  // 하지 않고 읽지 못한 원인을 그대로 알린다.
  it.skipIf(process.platform === "win32")(
    "names the cause when a link loop above the mark stops it being read",
    async () => {
      const org = await organization();
      await removeFolder(org.folder);
      await symlink(org.folder, org.folder);
      await expect(org.ensure()).rejects.toThrow(
        /표식을 읽을 수 없습니다\(ELOOP\)/
      );
    }
  );

  // FIFO는 쓰는 쪽이 나타날 때까지 열기가 끝나지 않는다. 열어서 확인하더라도 기다리지 않고 거부해야 한다.
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO in the mark's place without waiting for a writer",
    async () => {
      const org = await organization();
      execFileSync("mkfifo", [org.marker], {
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
    }
  );
});

// 표식을 쓰다 실패하면 조직 폴더에 임시 파일을 남기지 않고, 그 실패를 알린다(#280 리뷰 2회차 STD-2와 같은 모양).
it("leaves no temporary file in the organization folder when writing the mark fails", async () => {
  const org = await organization();
  swap.failWrite = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  await expect(org.ensure()).rejects.toThrow(/ENOSPC/);
  expect(await readdir(org.folder)).toEqual([]);
});
