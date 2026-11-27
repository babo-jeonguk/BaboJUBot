import type { RuntimeAdapter } from "@babojubot/contracts";
import { createScriptedRuntime } from "@babojubot/runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CompactionScheduler } from "../src/compaction.ts";
import type { AfterCommitDeps } from "../src/after-commit.ts";
import { HeartbeatScheduler } from "../src/heartbeat.ts";
import { unused } from "./stand-ins.ts";

// 주기 확인(heartbeat·압축)이 DB를 몇 번 읽는지 센다. 첫 조회를 시험이 붙잡아 느린 확인을 만들고, 그동안 타이머 주기를
// 여러 번 지나게 한다. 타이머는 가짜(setInterval)로 시험이 돌린다.
/** 한 시험이 보는 조회: 그 시험이 만든 db 대역(`db`)으로 받은 조회만 세고, 다음 조회 하나를 붙잡는다(`hold`). */
type Db = ConstructorParameters<typeof HeartbeatScheduler>[0]["db"];
type Watched = {
  db: Db;
  counted: { heartbeats: number; compactions: number };
  hold: Hold | undefined;
};
/** 다음 조회 하나를 붙잡는 결함. 붙잡은 조회를 `heldQueries`에 `<종류> <그 종류의 몇째 조회>`로 남긴다. */
type Hold = { released: Promise<void>; heldQueries: string[] };
const queries = vi.hoisted(() => ({
  /** 지금 시험의 조회 기록. 다른 db로 온 조회(앞 시험의 늦은 확인)는 세지도 붙잡지도 않는다(#286). */
  watched: undefined as Watched | undefined,
}));
/** 조회 하나를 대역이 불린 순간 잡은 시험 기록(`watched`)에 센다. 그 시험의 db면 붙잡기를 가져가 풀릴 때까지 기다린다. */
async function query(
  watched: Watched | undefined,
  kind: keyof Watched["counted"],
  db: unknown
) {
  if (!watched || watched.db !== db) return;
  watched.counted[kind]++;
  const { hold } = watched;
  watched.hold = undefined;
  hold?.heldQueries.push(`${kind} ${watched.counted[kind]}`);
  await hold?.released;
}
vi.mock("@babojubot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babojubot/db")>()),
  runDueHeartbeats: async (db: unknown) => {
    const { watched } = queries;
    await query(watched, "heartbeats", db);
    return { events: [] };
  },
  listCompactionCandidates: async (db: unknown) => {
    const { watched } = queries;
    await query(watched, "compactions", db);
    return [];
  },
}));

const pollMs = 1_000;
const dispatcher: AfterCommitDeps["dispatcher"] = {
  cancel: vi.fn(),
  kick: vi.fn(),
  kickOrganization: vi.fn(),
  kickProvider: vi.fn(),
};
const hub: AfterCommitDeps["hub"] = {
  publish: vi.fn(),
  publishSettingsChanged: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
  queries.watched = undefined;
});

/** 이 시험의 db 대역과 그 조회 기록을 연다. */
function watch(): Watched {
  const watched: Watched = {
    db: unused<Db>("db"),
    counted: { heartbeats: 0, compactions: 0 },
    hold: undefined,
  };
  queries.watched = watched;
  return watched;
}

/** 그 시험의 다음 조회를 붙잡는다. `release`가 풀어 주고, `heldQueries`가 붙잡힌 조회를 남긴다. */
function holdNext(watched: Watched) {
  const gate = Promise.withResolvers<void>();
  const hold: Hold = { released: gate.promise, heldQueries: [] };
  watched.hold = hold;
  return { release: () => gate.resolve(), heldQueries: hold.heldQueries };
}

const schedulers = {
  heartbeats: (db: Db) =>
    new HeartbeatScheduler({
      db,
      hub,
      dispatcher,
      now: () => new Date(),
      pollMs,
    }),
  compactions: (db: Db) =>
    new CompactionScheduler({
      db,
      providers: new Map<string, RuntimeAdapter>([
        [
          "compacting",
          {
            ...createScriptedRuntime({
              settings: { capabilities: { precompact: true } },
            }),
            precompact: async () => ({ ok: true, nextSession: null }),
          } satisfies RuntimeAdapter,
        ],
      ]),
      dispatcher,
      hub,
      now: () => new Date(),
      place: async () => unused("placement"),
    }),
} as const;

describe.each(["heartbeats", "compactions"] as const)(
  "the periodic %s check",
  (kind) => {
    // 느린 확인 하나가 여러 주기에 걸쳐도 밀린 주기마다 따로 조회하지 않는다. 확인이 끝나면 후속 확인 하나로 합친다.
    it("runs one follow-up check instead of one per missed interval", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const watched = watch();
      const scheduler = schedulers[kind](watched.db);
      const { release, heldQueries } = holdNext(watched);
      // 단언이 먼저 실패해도 붙잡은 조회를 풀어야 닫기가 그 확인을 기다리다 멈추지 않는다.
      onTestFinished(() => {
        release();
        return scheduler.close();
      });
      scheduler.start();
      vi.advanceTimersByTime(pollMs);
      await vi.waitFor(() => expect(watched.counted[kind]).toBe(1));
      // 붙잡기는 그 시험 db의 첫 조회에 걸렸다.
      expect(heldQueries).toEqual([`${kind} 1`]);
      // 첫 확인이 붙잡힌 동안 주기가 네 번 더 지난다.
      vi.advanceTimersByTime(pollMs * 4);
      release();
      // 직접 부른 확인은 부른 뒤에 시작한 확인이 끝날 때까지 기다린다. 밀린 주기와 함께 후속 확인 하나로 합쳐진다.
      await scheduler.tick();
      expect(watched.counted[kind]).toBe(2);
    });

    // 직접 부른 확인은 진행 중인 확인을 자기 확인으로 치지 않는다. 부른 뒤의 상태를 읽은 확인이 끝나야 돌아온다.
    it("makes a direct check wait for a check that starts after the call", async () => {
      const watched = watch();
      const scheduler = schedulers[kind](watched.db);
      const { release, heldQueries } = holdNext(watched);
      onTestFinished(() => {
        release();
        return scheduler.close();
      });
      const first = scheduler.tick();
      await vi.waitFor(() => expect(watched.counted[kind]).toBe(1));
      // 붙잡기는 그 시험 db의 첫 조회에 걸렸다.
      expect(heldQueries).toEqual([`${kind} 1`]);
      let returned = false;
      const second = scheduler.tick().then(() => (returned = true));
      release();
      await first;
      await second;
      expect(returned).toBe(true);
      expect(watched.counted[kind]).toBe(2);
    });
  }
);
