import type { RuntimeAdapter } from "@babojubot/contracts";
import { createScriptedRuntime } from "@babojubot/runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CompactionScheduler } from "../src/compaction.ts";
import type { AfterCommitDeps } from "../src/after-commit.ts";
import { HeartbeatScheduler } from "../src/heartbeat.ts";
import { unused } from "./stand-ins.ts";

// 주기 확인(heartbeat·압축)이 DB를 몇 번 읽는지 센다. 첫 조회를 시험이 붙잡아 느린 확인을 만들고, 그동안 타이머 주기를
// 여러 번 지나게 한다. 타이머는 가짜(setInterval)로 시험이 돌린다.
const queries = vi.hoisted(() => {
  let release: () => void = () => {};
  let held = false;
  const counted = { heartbeats: 0, compactions: 0 };
  return {
    counted,
    /** 다음 조회를 붙잡는다. 돌려준 함수가 풀어 준다. */
    holdNext: () => {
      held = true;
      return () => release();
    },
    async query(kind: "heartbeats" | "compactions") {
      counted[kind]++;
      if (!held) return;
      held = false;
      await new Promise<void>((resolve) => (release = resolve));
    },
  };
});
vi.mock("@babojubot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babojubot/db")>()),
  runDueHeartbeats: async () => {
    await queries.query("heartbeats");
    return { events: [] };
  },
  listCompactionCandidates: async () => {
    await queries.query("compactions");
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
  queries.counted.heartbeats = 0;
  queries.counted.compactions = 0;
});

const schedulers = {
  heartbeats: () =>
    new HeartbeatScheduler({
      db: unused("db"),
      hub,
      dispatcher,
      now: () => new Date(),
      pollMs,
    }),
  compactions: () =>
    new CompactionScheduler({
      db: unused("db"),
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
      const scheduler = schedulers[kind]();
      const release = queries.holdNext();
      // 단언이 먼저 실패해도 붙잡은 조회를 풀어야 닫기가 그 확인을 기다리다 멈추지 않는다.
      onTestFinished(() => {
        release();
        return scheduler.close();
      });
      scheduler.start();
      vi.advanceTimersByTime(pollMs);
      await vi.waitFor(() => expect(queries.counted[kind]).toBe(1));
      // 첫 확인이 붙잡힌 동안 주기가 네 번 더 지난다.
      vi.advanceTimersByTime(pollMs * 4);
      release();
      // 직접 부른 확인은 부른 뒤에 시작한 확인이 끝날 때까지 기다린다. 밀린 주기와 함께 후속 확인 하나로 합쳐진다.
      await scheduler.tick();
      expect(queries.counted[kind]).toBe(2);
    });

    // 직접 부른 확인은 진행 중인 확인을 자기 확인으로 치지 않는다. 부른 뒤의 상태를 읽은 확인이 끝나야 돌아온다.
    it("makes a direct check wait for a check that starts after the call", async () => {
      const scheduler = schedulers[kind]();
      const release = queries.holdNext();
      onTestFinished(() => {
        release();
        return scheduler.close();
      });
      const first = scheduler.tick();
      await vi.waitFor(() => expect(queries.counted[kind]).toBe(1));
      let returned = false;
      const second = scheduler.tick().then(() => (returned = true));
      release();
      await first;
      await second;
      expect(returned).toBe(true);
      expect(queries.counted[kind]).toBe(2);
    });
  }
);
