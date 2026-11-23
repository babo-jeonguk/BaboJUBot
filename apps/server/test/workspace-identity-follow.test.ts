import {
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestDatabase,
  insertLegacyOrganization,
} from "@babojubot/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspaces } from "../src/workspace.ts";
import { within } from "./support.ts";
import { removeFolder } from "@babojubot/process/remove-folder";

// Windows에는 `O_NOFOLLOW`·`O_NONBLOCK`이 없어 표식을 열 때 링크를 따라가고, 연 뒤 경로 항목이 연 파일인지 대조한다(#242).
// 서버 시험은 Linux CI에서만 도므로 두 값을 지운 node:fs로 그 길을 돌린다. 링크를 따라가는 열기는 대상이 없는 링크에서도
// ENOENT로 실패하므로, 열기 오류만으로는 정말 없는 표식과 표식 자리에 놓인 링크를 가르지 못한다.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const constants = {
    ...real.constants,
    O_NOFOLLOW: undefined,
    O_NONBLOCK: undefined,
  };
  return { ...real, constants, default: { ...real, constants } };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const markOf = (organizationId: string) =>
  JSON.stringify({ version: 1, organizationId });

/** 표식을 둘 조직 폴더가 있는, 아직 표식 기록이 없는 조직 하나. */
async function organization() {
  const database = await createTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "identity-follow-"));
  cleanups.push(
    () => database.close(),
    () => removeFolder(root)
  );
  const org = await insertLegacyOrganization(
    database.db,
    "링크를 따라가는 열기"
  );
  const folder = path.join(root, "organizations", org.id);
  await mkdir(folder, { recursive: true });
  return {
    id: org.id,
    root,
    marker: path.join(folder, "workspace-identity.json"),
    ensure: () =>
      within(
        new Workspaces(root, database.db).ensure(org.id),
        10_000,
        "preparing the organization folder did not finish"
      ),
  };
}

// 실제 Windows에서는 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하다. 서버 시험은 Windows CI에서 돌지 않는다.
describe.skipIf(process.platform === "win32")(
  "judging the folder mark when opening follows links, as on Windows",
  () => {
    it("accepts its own mark", async () => {
      const org = await organization();
      await writeFile(org.marker, markOf(org.id));
      await expect(org.ensure()).resolves.toBeDefined();
    });

    it("refuses a link in the mark's place, even to this organization's mark", async () => {
      const org = await organization();
      const elsewhere = path.join(org.root, "elsewhere.json");
      await writeFile(elsewhere, markOf(org.id));
      await symlink(elsewhere, org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
    });

    // 대상 없는 링크는 없는 표식이 아니다. 없다고 보면 표식이 아직 없는 조직은 그 자리에 새 표식을 쓴다.
    it("refuses a link whose target is missing, and leaves it in place", async () => {
      const org = await organization();
      const missing = path.join(org.root, "missing.json");
      await symlink(missing, org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
      expect(await readlink(org.marker)).toBe(missing);
    });

    // 표식을 적은 조직도 대상 없는 링크를 "표식 없음"이 아니라 다른 표식으로 본다.
    it("calls a link whose target is missing a different mark once the mark was recorded", async () => {
      const org = await organization();
      await org.ensure();
      await rm(org.marker);
      await symlink(path.join(org.root, "missing.json"), org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
    });
  }
);
