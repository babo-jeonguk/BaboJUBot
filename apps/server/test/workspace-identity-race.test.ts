import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestDatabase,
  insertLegacyOrganization,
} from "@babojubot/db/testing";
import { afterEach, expect, it, vi } from "vitest";
import { Workspaces } from "../src/workspace.ts";

// 조직을 만든 직후의 폴더 준비와 실행 시도 준비가 겹칠 수 있다. 겹쳤다고 표식이 없는 것으로 보면 멀쩡한 실행이 실패한다.
// 첫 준비가 기록을 확인하는 동안 다른 준비가 표식을 쓰고 기록까지 남기는 순간을 만든다.
const hold = vi.hoisted(() => ({
  first: true,
  release: () => {},
}));
vi.mock("@babojubot/db", async (original) => {
  const real = await original<typeof import("@babojubot/db")>();
  return {
    ...real,
    hasWorkspaceIdentity: async (
      ...args: Parameters<typeof real.hasWorkspaceIdentity>
    ) => {
      if (hold.first) {
        hold.first = false;
        await new Promise<void>((resolve) => {
          hold.release = resolve;
        });
      }
      return real.hasWorkspaceIdentity(...args);
    },
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  hold.first = true;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it("does not mistake a mark just written by another preparation for a missing one", async () => {
  const database = await createTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "identity-race-"));
  cleanups.push(
    () => database.close(),
    () => rm(root, { recursive: true, force: true })
  );
  const org = await insertLegacyOrganization(database.db, "겹친 준비");
  const workspaces = new Workspaces(root, database.db);

  const held = workspaces.ensure(org.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await workspaces.ensure(org.id);
  hold.release();

  await expect(held).resolves.toBeDefined();
  const marker = path.join(
    root,
    "organizations",
    org.id,
    "workspace-identity.json"
  );
  expect(JSON.parse(await readFile(marker, "utf8")).organizationId).toBe(
    org.id
  );
});
