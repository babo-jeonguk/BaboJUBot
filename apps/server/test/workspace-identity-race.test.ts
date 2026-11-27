import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestDatabase,
  insertLegacyOrganization,
} from "@babojubot/db/testing";
import { settled } from "@babojubot/contracts";
import { expect, it, onTestFinished, vi } from "vitest";
import { Workspaces } from "../src/workspace.ts";
import { within, heldOrEnded, releaseHeld } from "./support.ts";
import {
  awaitedLater,
  folderCleanup,
  releaseAcquired,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";

// 조직을 만든 직후의 폴더 준비와 실행 시도 준비가 겹칠 수 있다. 겹쳤다고 표식이 없는 것으로 보면 멀쩡한 실행이 실패한다.
// 첫 준비가 기록을 확인하는 동안 다른 준비가 표식을 쓰고 기록까지 남기는 순간을 만든다.
/**
 * 붙잡을 기록 확인. 그 시험의 db(`db`, 시험이 만든 객체)에서 그 조직(`organizationId`)의 기록을 처음 확인하는 호출 하나를 gate에서
 * 붙잡는다. 다른 db·조직의 확인(앞 시험의 늦은 준비 등)은 붙잡지 않는다(#286). 붙잡은 조직은 `heldAt`에 남는다.
 */
type Hold = {
  db: unknown;
  organizationId: string;
  /** 첫 호출이 gate에 들어서면 풀린다. 두 번째 준비는 이 신호 뒤에 시작해야 경합 순서가 성립한다. */
  arrived: () => void;
  release: () => void;
  heldAt: string[];
};
const holds = vi.hoisted(() => ({ first: undefined as Hold | undefined }));
vi.mock("@babojubot/db", async (original) => {
  const real = await original<typeof import("@babojubot/db")>();
  return {
    ...real,
    hasWorkspaceIdentity: async (
      ...args: Parameters<typeof real.hasWorkspaceIdentity>
    ) => {
      // 칸은 불린 순간(첫 await를 담은 문장 앞) 모두 읽고 쓴다. 기다림은 잡아 둔 gate만 본다(tests/hoisted-state-at-call).
      const { first } = holds;
      const [db, organizationId] = args;
      const held =
        first?.db === db && first.organizationId === organizationId
          ? first
          : undefined;
      const gate = held && Promise.withResolvers<void>();
      if (held && gate) {
        holds.first = undefined;
        held.heldAt.push(organizationId);
        held.release = gate.resolve;
        held.arrived();
      }
      await gate?.promise;
      return real.hasWorkspaceIdentity(...args);
    },
  };
});

/** 준비 하나가 끝나기를 기다리는 상한. 막힌 준비는 이 안에 끝나지 않으면 무엇을 기다렸는지 밝혀 실패한다. */
const preparationMs = 10_000;

// 첫 준비가 기록 확인에 늦게 닿아도 순서는 같다. 두 번째 준비는 첫 준비가 gate에 닿았다는 신호(`arrived`) 뒤에 시작한다.
it("does not mistake a mark just written by another preparation for a missing one", async () => {
  // 붙잡을 칸은 맨 마지막에 비운다. 아래 정리가 막아 둔 준비를 풀어야 하므로 그 뒤다(정리는 등록 역순으로 돈다).
  onTestFinished(() => {
    holds.first = undefined;
  });
  // 준비는 이 DB와 폴더를 쓴다. 시작한 준비가 모두 끝난 것을 확인한 뒤에만 DB를 닫고 폴더를 지운다. 끝나지 않은 준비가 있으면
  // 둘 다 남기고 그 실패를 알린다(`folderCleanup`). 준비의 성공·실패는 시험 본문이 기다려 단언하므로 정리는 끝남만 본다.
  // DB와 폴더는 만들기를 시작한 순간 정리에 맡긴다.
  const opening = createTestDatabase();
  const users = folderCleanup(() =>
    releaseAcquired(opening, (opened) => opened.close())
  );
  onTestFinished(users.cleanUp);
  const database = await opening;
  const making = mkdtemp(path.join(tmpdir(), "identity-race-"));
  const folder = folderCleanup(() =>
    releaseAcquired(making, (made) => removeFolderWithin(made))
  );
  onTestFinished(folder.cleanUp);
  const root = await making;
  const org = await insertLegacyOrganization(database.db, "겹친 준비");
  const workspaces = new Workspaces(root, database.db);

  const hold: Hold = {
    db: database.db,
    organizationId: org.id,
    arrived: () => {},
    release: () => {},
    heldAt: [],
  };
  const arrived = new Promise<void>((resolve) => {
    hold.arrived = resolve;
  });
  holds.first = hold;
  const prepare = (what: string) => {
    // 시작할 때부터 결과를 이 시험이 갖는다. gate에 닿기 전에 거절돼도 처리되지 않은 거절로 새지 않고, 아래 대기가 그 실패로 끝난다.
    const preparation = awaitedLater(workspaces.ensure(org.id));
    // 막아 둔 첫 준비는 gate를 풀어야 끝난다. 이미 풀었으면 다시 풀어도 그대로다.
    const ended = () =>
      releaseHeld(() => hold.release(), [() => settled(preparation)], what);
    users.own(ended);
    folder.own(ended);
    return preparation;
  };
  const held = prepare("the held first preparation");
  // gate 도착을 기다리는 동안 첫 준비가 실패하면 그 실패로, gate에 닿지 않고 끝나면 그 사실로 끝난다(시한 실패로 바뀌지 않는다).
  await heldOrEnded(arrived, held, "the first preparation");
  await within(
    prepare("the second preparation"),
    preparationMs,
    "the second preparation while the first is held did not finish"
  );
  hold.release();

  await expect(
    within(held, preparationMs, "the held first preparation did not finish")
  ).resolves.toBeDefined();
  expect(hold.heldAt).toEqual([org.id]);
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
