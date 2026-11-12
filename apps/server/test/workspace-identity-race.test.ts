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
// 지연은 처음 도착한 호출에, gate는 처음 들어선 호출에 건다. 둘을 따로 세야 늦은 첫 호출 대신 다른 호출이 gate를
// 잡는 순서(원래 50ms 대기의 교착)를 만들 수 있다.
const hold = vi.hoisted(() => {
  const fresh = () => ({
    calls: 0,
    /** 첫 호출이 gate에 들어서면 풀린다. 두 번째 준비는 이 신호 뒤에 시작해야 경합 순서가 성립한다. */
    arrived: () => {},
    first: true,
    /** 첫 호출이 기록 확인에 닿기 전의 지연. 스케줄러가 늦게 깨는 상황을 흉내 낸다. */
    entryDelay: Promise.resolve(),
    release: () => {},
  });
  return Object.assign(fresh(), {
    reset() {
      Object.assign(this, fresh());
    },
  });
});
vi.mock("@babojubot/db", async (original) => {
  const real = await original<typeof import("@babojubot/db")>();
  return {
    ...real,
    hasWorkspaceIdentity: async (
      ...args: Parameters<typeof real.hasWorkspaceIdentity>
    ) => {
      if (++hold.calls === 1) await hold.entryDelay;
      if (hold.first) {
        hold.first = false;
        const gate = new Promise<void>((resolve) => {
          hold.release = resolve;
        });
        hold.arrived();
        await gate;
      }
      return real.hasWorkspaceIdentity(...args);
    },
  };
});

// 시작한 준비는 성공·실패와 관계없이 gate를 풀고 끝까지 기다린 뒤에 DB와 폴더를 정리한다.
const preparations: Promise<unknown>[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  hold.release();
  await Promise.allSettled(preparations.splice(0));
  hold.reset();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** 막힌 순서를 시한 안에 그 이름으로 알린다. 테스트 전체 시한까지 기다리지 않는다. */
async function within<T>(work: Promise<T>, what: string, ms = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not finish in ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each([
  ["reaches the check at once", 0],
  ["reaches the check late", 150],
])(
  "does not mistake a mark just written by another preparation for a missing one when the first %s",
  async (_, lateMs) => {
    if (lateMs)
      hold.entryDelay = new Promise((resolve) => setTimeout(resolve, lateMs));
    const database = await createTestDatabase();
    const root = await mkdtemp(path.join(tmpdir(), "identity-race-"));
    cleanups.push(
      () => database.close(),
      () => rm(root, { recursive: true, force: true })
    );
    const org = await insertLegacyOrganization(database.db, "겹친 준비");
    const workspaces = new Workspaces(root, database.db);

    const arrived = new Promise<void>((resolve) => {
      hold.arrived = resolve;
    });
    const prepare = () => {
      const preparation = workspaces.ensure(org.id);
      preparations.push(preparation);
      return preparation;
    };
    const held = prepare();
    await within(arrived, "the first preparation reaching the record check");
    await within(prepare(), "the second preparation while the first is held");
    hold.release();

    await expect(
      within(held, "the held first preparation")
    ).resolves.toBeDefined();
    const marker = path.join(
      root,
      "organizations",
      org.id,
      "workspace-identity.json"
    );
    expect(JSON.parse(await readFile(marker, "utf8")).organizationId).toBe(
      org.id
    );
  }
);
