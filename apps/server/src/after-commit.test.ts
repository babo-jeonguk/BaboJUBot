import type { Event } from "@babojubot/contracts";
import { fakeClock } from "../test/support.ts";
import type { RunCancellation } from "@babojubot/core";
import { refused, stored, type AfterCommit } from "@babojubot/db";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { applyAfterCommit, completeStored } from "./after-commit.ts";

const event = (id: number): Event => ({
  id,
  organizationId: "A",
  type: "organization.created",
  payload: { name: "x", stage: "planning", leadAgentId: "lead" },
  createdAt: new Date().toISOString(),
});

/**
 * 부른 순서를 남기는 가짜 hub·dispatcher. 조직 재개 처리는 `release`를 부를 때까지 끝나지 않는다.
 * 동기 효과는 기록의 길이(`push`의 값)를 돌려준다. 타입은 `void`를 돌려주는 함수에 값을 돌려주는 함수를 받으므로, promise가 아닌
 * 반환값은 끝난 동기 효과로 다뤄야 한다(promise인지는 thenable로 본다). 참인 값을 promise로 보면 `.catch`가 없어 실패로 남았다.
 */
const fakes = () => {
  const calls: string[] = [];
  let release = () => {};
  const resumed = new Promise<void>((resolve) => (release = resolve));
  return {
    calls,
    release: () => release(),
    deps: {
      hub: {
        publish: (...events: Event[]) =>
          calls.push(`publish ${events.map((e) => e.id).join(",")}`),
        publishSettingsChanged: () => calls.push("settings changed"),
      },
      dispatcher: {
        cancel: (cancellation: RunCancellation | null) =>
          calls.push(`cancel ${cancellation?.runIds.join(",") ?? "none"}`),
        kickOrganization: async (organizationId: string) => {
          calls.push(`resume ${organizationId}`);
          await resumed;
          calls.push(`resumed ${organizationId}`);
        },
        kick: (agentId: string) => calls.push(`kick ${agentId}`),
        kickProvider: async (provider: string) => {
          calls.push(`kick waiting for ${provider}`);
        },
      },
    },
  };
};

describe("applyAfterCommit", () => {
  it("preserves committed results and delivers events and wakes when workspace preparation fails", async () => {
    const f = fakes();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const result = await completeStored(
      {
        ...f.deps,
        ensureWorkspace: async () => {
          throw new Error("disk unavailable");
        },
      },
      stored({ id: "saved" }, { events: [event(1)], woken: ["lead"] })
    );
    expect(result).toEqual({ kind: "ok", value: { id: "saved" } });
    expect(f.calls).toEqual(["publish 1", "kick lead"]);
    // 진단에는 오류 문구 대신 원인 코드를 남긴다(CODING_STANDARDS.md#제품-코드).
    expect(errors.mock.calls).toEqual([
      [
        "[workspace] folder preparation failed for organization A; the next run assembly will retry (Error)",
      ],
    ]);
  });
  it("publishes, cancels, waits for the resumed organization, then kicks", async () => {
    fakeClock();
    const f = fakes();
    const applied = applyAfterCommit(f.deps, {
      events: [event(1), event(2)],
      cancellation: { reason: "owner_interrupt", runIds: ["r1"] },
      resumedOrganizationId: "A",
      woken: ["lead", "worker"],
    });
    // 재개 처리를 풀기 전에 가짜 시계의 타이머와 microtask를 다 돌린다. 재개를 기다리지 않고 microtask나 가짜 시계의 타이머로 촉진하는
    // 틀린 구현이면 이때 이미 촉진이 있다. 실제 시계나 입출력으로 미루는 틀린 구현은 이 판정이 잡지 못한다.
    await vi.runAllTimersAsync();
    expect(f.calls).toEqual(["publish 1,2", "cancel r1", "resume A"]);

    f.release();
    await applied;
    expect(f.calls).toEqual([
      "publish 1,2",
      "cancel r1",
      "resume A",
      "resumed A",
      "kick lead",
      "kick worker",
    ]);
  });

  it("signals a settings change first and kicks agents waiting for a freed provider last", async () => {
    const f = fakes();
    await applyAfterCommit(f.deps, {
      events: [],
      woken: ["lead"],
      settingsChanged: true,
      providersFreed: ["fake-2"],
    });
    expect(f.calls).toEqual([
      "settings changed",
      "kick lead",
      "kick waiting for fake-2",
    ]);
  });

  it("does only what the stored result asks for", async () => {
    const f = fakes();
    await applyAfterCommit(f.deps, { events: [event(3)], woken: ["lead"] });
    expect(f.calls).toEqual(["publish 3", "kick lead"]);
  });
});

describe("applyAfterCommit when an effect fails", () => {
  afterEach(() => vi.restoreAllMocks());
  const everything: AfterCommit = {
    events: [event(5)],
    settingsChanged: true,
    cancellation: { reason: "owner_interrupt", runIds: ["r1"] },
    resumedOrganizationId: "A",
    woken: ["lead", "worker"],
    providersFreed: ["fake", "fake-2"],
  };
  const all = [
    "publish 5",
    "settings changed",
    "cancel r1",
    "resume A",
    "resumed A",
    "kick lead",
    "kick worker",
    "kick waiting for fake",
    "kick waiting for fake-2",
  ];

  it.each([
    ["publish", "publish 5", "publishing events 5"],
    ["settings", "settings changed", "signalling a settings change"],
    ["cancel", "cancel r1", "cancelling runs r1"],
    ["resume", "resumed A", "kicking resumed organization A"],
    ["kick", "kick lead", "kicking agent lead"],
    [
      "kick waiting",
      "kick waiting for fake",
      "kicking agents waiting for provider fake",
    ],
  ] as const)(
    "keeps the saved result, reports the failed %s effect, and still applies the others in order",
    async (_name, failing, what) => {
      const f = fakes();
      f.release();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const fail = (call: string) => {
        f.calls.push(call);
        if (call === failing) throw new Error("effect failed");
      };
      const deps = {
        hub: {
          publish: () => fail("publish 5"),
          publishSettingsChanged: () => fail("settings changed"),
        },
        dispatcher: {
          cancel: () => fail("cancel r1"),
          kickOrganization: async () => {
            f.calls.push("resume A");
            await Promise.resolve();
            fail("resumed A");
          },
          kick: (agentId: string) => fail(`kick ${agentId}`),
          kickProvider: async (provider: string) =>
            fail(`kick waiting for ${provider}`),
        },
      };

      expect(
        await completeStored(deps, stored({ id: "saved" }, { ...everything }))
      ).toEqual({ kind: "ok", value: { id: "saved" } });
      expect(f.calls).toEqual(all);
      // 진단에는 오류 문구 대신 원인 코드를 남긴다(CODING_STANDARDS.md#제품-코드).
      expect(errors.mock.calls).toEqual([
        [`[after-commit] ${what} failed; the saved result stands (Error)`],
      ]);
    }
  );

  it("keeps going when reporting a failure fails too", async () => {
    const f = fakes();
    f.release();
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("log sink unavailable");
    });
    await applyAfterCommit(
      {
        ...f.deps,
        hub: {
          ...f.deps.hub,
          publish: () => {
            throw new Error("hub down");
          },
        },
      },
      { ...everything }
    );
    expect(f.calls).toEqual(all.slice(1));
  });
});

describe("completeStored", () => {
  it("applies what comes after a successful save and returns only the value", async () => {
    const f = fakes();
    expect(
      await completeStored(f.deps, stored({ id: "x" }, { events: [event(4)] }))
    ).toEqual({ kind: "ok", value: { id: "x" } });
    expect(f.calls).toEqual(["publish 4"]);
  });

  it("applies nothing for a refusal", async () => {
    const f = fakes();
    expect(await completeStored(f.deps, refused("not_found"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(f.calls).toEqual([]);
  });
});
