import {
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
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
import { releaseAcquired } from "@babojubot/process/test-cleanup";

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
/**
 * 이 경로(`at`, 그 시험의 표식)를 여는 열기의 flags를 `flags`에 남긴다. 시험이 두 값 없이 열었는지(위 대역이 그 열기에서 실제로
 * Windows 길을 만들었는지) 본다. 고르기와 기록은 그 시험이 만든 객체로 하고, 대역은 불린 순간 잡는다.
 */
const opens = vi.hoisted(() => ({
  watched: undefined as { at: string; flags: unknown[] } | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open = (...args: Parameters<typeof real.open>) => {
    const watched = opens.watched;
    if (watched && String(args[0]) === watched.at) watched.flags.push(args[1]);
    return real.open(...args);
  };
  return { ...real, open, default: { ...real, open } };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  opens.watched = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const markOf = (organizationId: string) =>
  JSON.stringify({ version: 1, organizationId });

/** 표식을 둘 조직 폴더가 있는, 아직 표식 기록이 없는 조직 하나. */
async function organization() {
  // DB와 폴더는 만들기를 시작한 순간 정리에 맡긴다.
  const opening = createTestDatabase();
  cleanups.push(() => releaseAcquired(opening, (database) => database.close()));
  const database = await opening;
  const making = mkdtemp(path.join(tmpdir(), "identity-follow-"));
  cleanups.push(() => releaseAcquired(making, (root) => removeFolder(root)));
  const root = await making;
  const org = await insertLegacyOrganization(
    database.db,
    "링크를 따라가는 열기"
  );
  const folder = path.join(root, "organizations", org.id);
  await mkdir(folder, { recursive: true });
  const marker = path.join(folder, "workspace-identity.json");
  const opened = { at: marker, flags: [] as unknown[] };
  opens.watched = opened;
  return {
    id: org.id,
    root,
    marker,
    /** 서버가 이 표식을 연 열기의 flags(겹친 것은 하나로). */
    openFlags: () => [...new Set(opened.flags)],
    ensure: () =>
      within(
        new Workspaces(root, database.db).ensure(org.id),
        10_000,
        "preparing the organization folder did not finish"
      ),
  };
}

// 위 대역이 서버의 표식 열기에서 실제로 났다는 단언: 열기의 flags가 읽기 전용 하나뿐이다(`O_NOFOLLOW`·`O_NONBLOCK`이 붙지 않았다).
const readOnly = constants.O_RDONLY;

// 실제 Windows에서는 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하다. 서버 시험은 Windows CI에서 돌지 않는다.
describe.skipIf(process.platform === "win32")(
  "judging the folder mark when opening follows links, as on Windows",
  () => {
    it("accepts its own mark", async () => {
      const org = await organization();
      await writeFile(org.marker, markOf(org.id));
      await expect(org.ensure()).resolves.toBeDefined();
      expect(org.openFlags()).toEqual([readOnly]);
    });

    it("refuses a link in the mark's place, even to this organization's mark", async () => {
      const org = await organization();
      const elsewhere = path.join(org.root, "elsewhere.json");
      await writeFile(elsewhere, markOf(org.id));
      await symlink(elsewhere, org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
      expect(org.openFlags()).toEqual([readOnly]);
    });

    // 대상 없는 링크는 없는 표식이 아니다. 없다고 보면 표식이 아직 없는 조직은 그 자리에 새 표식을 쓴다.
    it("refuses a link whose target is missing, and leaves it in place", async () => {
      const org = await organization();
      const missing = path.join(org.root, "missing.json");
      await symlink(missing, org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
      expect(await readlink(org.marker)).toBe(missing);
      expect(org.openFlags()).toEqual([readOnly]);
    });

    // 표식을 적은 조직도 대상 없는 링크를 "표식 없음"이 아니라 다른 표식으로 본다.
    it("calls a link whose target is missing a different mark once the mark was recorded", async () => {
      const org = await organization();
      await org.ensure();
      await rm(org.marker);
      await symlink(path.join(org.root, "missing.json"), org.marker);
      await expect(org.ensure()).rejects.toThrow(/표식이 이 조직과 다릅니다/);
      expect(org.openFlags()).toEqual([readOnly]);
    });
  }
);
