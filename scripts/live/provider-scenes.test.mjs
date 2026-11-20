import assert from "node:assert/strict";
import { test } from "node:test";
import {
  liveScenes,
  movedToFreshSession,
  parseScenes,
  sameSession,
  ScenesRefused,
  usageFacts,
  verdict,
} from "./provider-scenes.mjs";

const all = { steer: true, precompact: true };
const none = { steer: false, precompact: false };

test("runs every scene the connection can do when none is chosen", () => {
  assert.deepEqual(parseScenes([], all), {
    record: false,
    scenes: liveScenes.map((scene) => scene.id),
  });
  assert.deepEqual(parseScenes(["--record"], none), {
    record: true,
    scenes: ["finish", "background", "resume", "cancel", "unusable-session"],
  });
});

test("checks only the arguments before the connection exists", () => {
  assert.deepEqual(parseScenes(["--scenes=steer"], null).scenes, ["steer"]);
  assert.throws(() => parseScenes(["--scenes=finsh"], null), ScenesRefused);
});

test("runs only the chosen scenes", () => {
  assert.deepEqual(parseScenes(["--scenes=resume, cancel"], none).scenes, [
    "resume",
    "cancel",
  ]);
});

// 오타 하나로 아무 장면도 돌지 않고 "모두 성공"을 보거나, 고르려던 장면 대신 모든 장면이 돌아 사용량을 쓰지 않는다.
for (const [name, flags, capabilities = all] of [
  ["an unknown scene", ["--scenes=finsh"]],
  ["an empty choice", ["--scenes="]],
  ["a choice of commas only", ["--scenes=,,"]],
  ["two choices", ["--scenes=finish", "--scenes=cancel"]],
  ["an unknown argument such as a misspelled choice", ["--scene=finish"]],
  ["a scene the connection cannot do", ["--scenes=steer"], none],
]) {
  test(`refuses ${name} before any call`, () => {
    assert.throws(() => parseScenes(flags, capabilities), ScenesRefused);
  });
}

test("passes only when every chosen scene ran and passed", () => {
  assert.deepEqual(
    verdict(
      [
        { scene: "finish", ok: true },
        { scene: "cancel", ok: true },
      ],
      ["finish", "cancel"]
    ),
    { passed: ["finish", "cancel"], failed: [], missing: [], ok: true }
  );
  for (const [name, results, scenes] of [
    ["no scene at all", [], []],
    [
      "no result for a chosen scene",
      [{ scene: "finish", ok: true }],
      ["finish", "cancel"],
    ],
    ["a failed scene", [{ scene: "finish", ok: false }], ["finish"]],
    ["a scene that threw", [{ scene: "finish", failed: "boom" }], ["finish"]],
    [
      "a truthy non-boolean result",
      [{ scene: "finish", ok: "yes" }],
      ["finish"],
    ],
  ])
    assert.equal(verdict(results, scenes).ok, false, name);
  assert.deepEqual(
    verdict([{ scene: "finish", ok: true }], ["finish", "cancel"]).missing,
    ["cancel"]
  );
});

test("counts the session usage scene only when the session left its usage facts", () => {
  const now = Date.parse("2026-11-20T00:01:00Z");
  const row = {
    state: { id: "session-1" },
    maintenance: {
      tokens: 1200,
      ttlMs: 300_000,
      lastRequestAt: "2026-11-20T00:00:00Z",
      tools: ["a"],
    },
  };
  assert.deepEqual(usageFacts(row, now), {
    ok: true,
    noSession: false,
    maintenance: {
      tokens: 1200,
      ttlMs: 300_000,
      lastRequestAgeSeconds: 60,
      tools: 1,
    },
    sessionKeys: ["id"],
  });
  for (const [name, broken] of [
    ["no session", undefined],
    ["no usage facts", { ...row, maintenance: null }],
    ["no session id", { ...row, state: {} }],
    [
      "no tokens",
      { ...row, maintenance: { ...row.maintenance, tokens: undefined } },
    ],
    ["zero tokens", { ...row, maintenance: { ...row.maintenance, tokens: 0 } }],
    ["no lifetime", { ...row, maintenance: { ...row.maintenance, ttlMs: 0 } }],
    [
      "an unreadable time",
      { ...row, maintenance: { ...row.maintenance, lastRequestAt: "later" } },
    ],
  ])
    assert.equal(usageFacts(broken, now).ok, false, name);
});

test("needs both session ids before calling a session new or the same", () => {
  assert.equal(
    movedToFreshSession({ previousId: "a", fake: "b", after: "c" }),
    true
  );
  assert.equal(
    movedToFreshSession({ previousId: "a", fake: "b", after: undefined }),
    false
  );
  assert.equal(
    movedToFreshSession({ previousId: "a", fake: "b", after: "b" }),
    false
  );
  assert.equal(
    movedToFreshSession({ previousId: "a", fake: "b", after: "a" }),
    false
  );
  assert.equal(sameSession("a", "a"), true);
  assert.equal(sameSession(undefined, undefined), false);
  assert.equal(sameSession("a", "b"), false);
});
