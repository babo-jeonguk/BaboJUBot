import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  approvalSummaryListSchema,
  attemptAll,
  conversationMessageListSchema,
  conversationPageSchema,
  eventListSchema,
  eventStreamPath,
  organizationDetailSchema,
  runDetailSchema,
  runSummaryListSchema,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import { planOrganizationCreation } from "@babojubot/core";
import {
  claimNextRun,
  insertOrganizationCreation,
  type Database,
} from "@babojubot/db";
import {
  createTestDatabase,
  failRunEnd,
  insertLegacyOrganization,
  type TestDatabase,
} from "@babojubot/db/testing";
import {
  createScriptedRuntime,
  defaultScriptSelector,
  leadReplyScript,
} from "@babojubot/runtime";
import {
  createGate,
  holdAfter,
  writes,
  type Gate,
} from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { startServer, type RunningServer } from "../src/index.ts";
import {
  calls,
  goal,
  idle,
  quietCreation,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import {
  eventuallyMs,
  openEventStream,
  pollUntil,
  startTestServer,
  within,
  type TestServer,
  closeDatabase,
  ownStart,
  heldOrEnded,
  startDiagnostics,
  releaseHeld,
  homeUsers,
} from "./support.ts";

import {
  awaitedLater,
  withCleanup,
  type CleanupStep,
} from "@babojubot/process/test-cleanup";

// 서버 재시작 복구. 실행 중 서버가 멈추면 그 실행 시도는 `server_restart`로 끝나고, 받은 깨우기는 다시 처리되어 새 실행 시도가 생긴다.

let database: TestDatabase | undefined;
/** 시험이 지금 쓰는 서버. 띄우는 즉시 그 끝을 DB를 쓰는 것으로 맡긴다(`startOwned`). */
let server: RunningServer | undefined;
/** 지금 서버의 끝(한 번만 돈다). 시험 본문이 중간에 끌 때도 이것을 부르고, 정리가 같은 결과를 받는다. */
let stopServer: (() => Promise<void>) | undefined;
let t: TestServer | undefined;
/** 그 시험의 DB를 쓰는 것(시작 중인 서버, 서버 프로세스)의 끝. `server` 말고 따로 띄운 것을 시험이 맡긴다. */
let databaseUsers: CleanupStep[] = [];
afterEach(() => {
  const [db, test, users] = [database, t, databaseUsers];
  server = undefined;
  stopServer = undefined;
  database = undefined;
  t = undefined;
  databaseUsers = [];
  // 서버와 DB를 쓰는 것이 모두 끝난 것을 확인한 뒤에만 그 DB(재시작한 서버가 쓰는 시험 서버 `t`의 DB 포함)를 닫는다. 하나라도
  // 확인하지 못하면 DB를 남기고 그 실패를 알린다(`folderCleanup`). 한 단계가 실패해도 나머지를 닫는다.
  // 이 서버들은 데이터 폴더를 넘기지 않아 파일의 제품 폴더도 쓴다(`homeUsers`).
  const closing = homeUsers(() =>
    attemptAll([() => db && closeDatabase(db), () => test?.close()])
  );
  for (const end of users) closing.own(end);
  return closing.cleanUp();
});

/** 서버를 띄우고 띄우는 즉시 그 끝을 이 시험의 DB를 쓰는 것으로 맡긴다(`ownStart`). */
function startOwned(options: Parameters<typeof startServer>[0]) {
  const owned = ownStart(
    (stop) => databaseUsers.push(stop),
    startServer(options),
    "the server"
  );
  stopServer = owned.stop;
  return owned.started;
}

const api = (base: () => string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base() + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    /** 사용자가 목표를 적어 만든 조직. 생성으로 깨어난 Lead의 실행 시도를 기다리지 않는다. */
    async createOrganization(name: string) {
      const org = organizationDetailSchema.parse(
        (await call("POST", "/api/organizations", { name, ...goal })).body
      );
      return { id: org.id, lead: org.agents.find((a) => a.role === "lead")! };
    },
    organization: async (orgId: string) =>
      organizationDetailSchema.parse(
        (await call("GET", `/api/organizations/${orgId}`)).body
      ),
    async say(orgId: string, body: string) {
      expect(
        (await call("POST", `/api/organizations/${orgId}/messages`, { body }))
          .status
      ).toBe(201);
    },
    runs: async (orgId: string) =>
      runSummaryListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/runs`)).body
      ),
    run: async (orgId: string, runId: string) =>
      runDetailSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/runs/${runId}`)).body
      ),
    conversation: async (orgId: string) => [
      ...conversationPageSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/messages`)).body
      ).messages,
      ...conversationMessageListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/queued-messages`)).body
      ),
    ],
    events: async (orgId: string) =>
      eventListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/events`)).body
      ),
  };
};
type Api = ReturnType<typeof api>;

describe("server restart recovery", () => {
  it("ends a run the server stopped during as a server restart and hands its wakes to a new run after the restart", async () => {
    database = await createTestDatabase();
    const gate = createGate();
    server = await startOwned({
      db: database.db,
      port: 0,
      runtime: quietCreation(
        createScriptedRuntime({
          select: () => ({
            ...leadReplyScript,
            steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
          }),
        })
      ),
    });
    const http = api(() => server!.url);
    const org = await http.createOrganization("재시작 조직");
    await server.drain();
    await http.say(org.id, "재시작 뒤에도 처리해 줘");
    await gate.reached;
    const [interrupted] = await http.runs(org.id);

    // 정리가 맡은 같은 끝(한 번만 돈다)으로 끈다. 끄지 못했으면 정리가 같은 실패를 받아 DB를 닫지 않는다.
    await stopServer!();
    server = undefined;
    server = await startOwned({ db: database.db, port: 0 });
    await server.drain();

    const [next, old] = await http.runs(org.id);
    expect(old).toMatchObject({
      id: interrupted!.id,
      status: "server_restart",
      wakeCount: 1,
    });
    expect(next).toMatchObject({ status: "completed", wakeCount: 1 });
    const [before, after] = await Promise.all([
      http.run(org.id, old!.id),
      http.run(org.id, next!.id),
    ]);
    expect(after.wakeReasons).toEqual(before.wakeReasons);
    expect(
      (await http.conversation(org.id)).map((m) => [
        m.author,
        m.deliveredToRunId,
      ])
    ).toEqual([
      ["owner", next!.id],
      ["agent", null],
    ]);
  });

  it("recovers after the server process is killed mid-run without repeating the reply it already sent", async () => {
    const { http, org, old } = await crashAndRestart("send_message", {
      committed: async (http, orgId) =>
        (await http.conversation(orgId)).length === 1,
    });
    expect(old.error).toContain("서버가 멈춰");
    // 새 실행 시도는 같은 깨우기를 받아 같은 답장을 보내지만, 같은 호출 키라 이미 남긴 답장을 돌려받는다.
    const conversation = await http.conversation(org.id);
    expect(conversation.map((m) => m.author)).toEqual(["agent"]);
    expect(conversation[0]!.sentByRunId).toBe(old.id);
    // 돌려받은 호출은 기록·Event를 새로 남기지 않는다.
    const replies = (await http.events(org.id)).filter(
      (e) =>
        e.type === "run.activity" &&
        e.payload.activity.source === "control_plane" &&
        e.payload.activity.activity.type === "org_tool" &&
        e.payload.activity.activity.tool === "send_message"
    );
    expect(replies.map((e) => e.payload)).toEqual([
      expect.objectContaining({ runId: old.id }),
    ]);
    expect(
      (await http.events(org.id)).filter((e) => e.type === "message.created")
    ).toHaveLength(1);
  });

  // 단계를 바꾸는 쓰기 뒤에 죽으면 새 실행 시도는 바뀐 단계에서 시작한다. 그래도 초기 연구 승인 흐름의 남은 단계를 이어 간다.
  // 새 조직은 생성으로 깨어난 Lead가 곧바로 요청한다. 목표 없이 만든 예전 조직은 목표 메시지로 목표를 기록하고 요청한다.
  it.each([
    ["request_initial_approval", "awaiting_approval", false],
    ["send_message", "awaiting_approval", false],
    ["record_goal", "planning", true],
    ["request_initial_approval", "awaiting_approval", true],
  ] as const)(
    "continues the initial research approval flow after the server is killed right after %s (legacy organization: %s)",
    async (stopAfter, stageAtCrash, legacy) => {
      const owner = legacy ? ["owner"] : [];
      const { http, org, old, next } = await crashAndRestart(stopAfter, {
        legacy,
        say: legacy ? goalMessage : undefined,
        committed: async (http, orgId) =>
          (await http.organization(orgId)).stage === stageAtCrash &&
          (stopAfter !== "send_message" ||
            (await http.conversation(orgId)).length === owner.length + 1),
      });
      const detail = await http.organization(org.id);
      expect(detail).toMatchObject({
        stage: "awaiting_approval",
        goal: "음성 인식 오류율을 절반으로 줄인다",
      });
      const approvals = approvalSummaryListSchema.parse(
        (await http.call("GET", `/api/organizations/${org.id}/approvals`)).body
      );
      expect(approvals.map((a) => [a.kind, a.status])).toEqual([
        ["initial_research", "pending"],
      ]);
      const conversation = await http.conversation(org.id);
      expect(conversation.map((m) => m.author)).toEqual([...owner, "agent"]);
      const reply = conversation.at(-1)!;
      expect(reply.body).toContain("초기 연구 승인을 요청했습니다");
      expect(reply.sentByRunId).toBe(
        stopAfter === "send_message" ? old.id : next.id
      );
      // 목표 기록·승인 요청·답장은 한 번씩만 남고, 새 실행 시도는 끝난 단계의 도구를 부르다 거부되지 않는다.
      const types = (await http.events(org.id)).map((e) => e.type);
      expect(types.filter((t) => t === "approval.requested")).toHaveLength(1);
      expect(
        types.filter((t) => t === "organization.goal_recorded")
      ).toHaveLength(legacy ? 1 : 0);
      expect(types).not.toContain("tool.refused");
    }
  );

  it("continues the recorded goal's approval request when a different goal message joins the redelivered wake of a legacy organization", async () => {
    const { http, org } = await crashAndRestart("record_goal", {
      legacy: true,
      say: goalMessage,
      committed: async (http, orgId) =>
        (await http.organization(orgId)).stage === "planning",
      alsoSay:
        "목표: 음성 인식 지연시간을 줄인다\n완료 기준: 지연시간 100ms 이하",
    });
    expect(await http.organization(org.id)).toMatchObject({
      stage: "awaiting_approval",
      goal: "음성 인식 오류율을 절반으로 줄인다",
    });
    const approvals = approvalSummaryListSchema.parse(
      (await http.call("GET", `/api/organizations/${org.id}/approvals`)).body
    );
    expect(approvals.map((a) => [a.kind, a.status])).toEqual([
      ["initial_research", "pending"],
    ]);
    // 기록하지 못한 다른 목표는 답장에서 반영하지 않았다고 밝힌다.
    const conversation = await http.conversation(org.id);
    expect(conversation.map((m) => m.author)).toEqual([
      "owner",
      "owner",
      "agent",
    ]);
    expect(conversation[2]!.body).toContain("초기 연구 승인을 요청했습니다");
    expect(conversation[2]!.body).toContain("음성 인식 지연시간을 줄인다");
    const types = (await http.events(org.id)).map((e) => e.type);
    expect(
      types.filter((t) => t === "organization.goal_recorded")
    ).toHaveLength(1);
    expect(types).not.toContain("tool.refused");
  });
});

const goalMessage =
  "목표: 음성 인식 오류율을 절반으로 줄인다\n완료 기준: 공개 평가셋 WER 10% 이하";

/**
 * 자식 서버 프로세스에서 조직을 만들고(새 조직이면 생성으로 깨어난 Lead가, `legacy`면 목표 없이 만든 예전 조직의 Lead가 `say`를 받아)
 * `stopAfter` 쓰기가 commit된 것을 `committed`로 확인한 뒤 SIGKILL한다.
 * `alsoSay`가 있으면 SIGKILL 전에 보내, 다시 대기한 깨우기와 새 깨우기가 한 실행 시도로 합쳐지게 한다.
 * 같은 DB로 기본 가짜 프로바이더 서버를 다시 띄워 재처리가 끝날 때까지 기다린다.
 */
describe("accepted steer across a restart (#159)", () => {
  it("hands a message the stopped run had accepted by steering to the run after the first restart, once, and keeps both runs' records", async () => {
    database = await createTestDatabase();
    const gate = createGate();
    server = await startOwned({
      db: database.db,
      port: 0,
      runtime: quietCreation(
        createScriptedRuntime({
          select: () => ({
            ...leadReplyScript,
            steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
          }),
        })
      ),
    });
    const http = api(() => server!.url);
    const org = await http.createOrganization("끼워 넣기 재시작 조직");
    await server.drain();
    await http.say(org.id, "긴 일을 시작해 주세요");
    await gate.reached;
    const [running] = await http.runs(org.id);
    const steered = await http.call(
      "POST",
      `/api/organizations/${org.id}/messages`,
      { body: "받은 뒤 멈춤", delivery: "steer" }
    );
    expect(steered.body).toMatchObject({
      delivery: "steer",
      deliveredToRunId: running!.id,
    });

    // 정상 종료: 진행 중 실행 시도는 취소되어 돌아와 `server_restart`로 끝나고 받은 깨우기를 다시 대기시킨다.
    // 정리가 맡은 같은 끝(한 번만 돈다)으로 끈다. 끄지 못했으면 정리가 같은 실패를 받아 DB를 닫지 않는다.
    await stopServer!();
    server = undefined;
    let received: string[][] = [];
    server = await startOwned({
      db: database.db,
      port: 0,
      runtime: quietCreation(
        createScriptedRuntime({
          select: (request) => {
            received.push(
              request.wakeReasons.flatMap((r) =>
                r.kind === "owner_message" ? [r.body] : []
              )
            );
            return leadReplyScript;
          },
        })
      ),
    });
    await server.drain();
    // 첫 재시작 한 번으로 다음 실행 시도가 끼워 넣어 받았던 메시지까지 한 번씩 받는다.
    expect(received).toEqual([["긴 일을 시작해 주세요", "받은 뒤 멈춤"]]);
    const [next, old] = await http.runs(org.id);
    expect(old).toMatchObject({ id: running!.id, status: "server_restart" });
    expect(next).toMatchObject({ status: "completed" });
    const bodiesOf = async (runId: string) =>
      (await http.run(org.id, runId)).wakeReasons.flatMap((r) =>
        r.kind === "owner_message" ? [r.body] : []
      );
    expect(await bodiesOf(old!.id)).toEqual([
      "긴 일을 시작해 주세요",
      "받은 뒤 멈춤",
    ]);
    expect(await bodiesOf(next!.id)).toEqual([
      "긴 일을 시작해 주세요",
      "받은 뒤 멈춤",
    ]);
    // 대화에는 지금 받은 실행 시도의 메시지로 놓이고, 공개 활동에 끼워 넣기와 재대기가 남는다.
    const placed = (await http.conversation(org.id)).find(
      (m) => m.body === "받은 뒤 멈춤"
    );
    expect(placed).toMatchObject({
      deliveredToRunId: next!.id,
      delivery: "next_run",
    });
    const events = await http.events(org.id);
    expect(
      events.filter((e) => e.type === "message.steered").map((e) => e.payload)
    ).toEqual([expect.objectContaining({ outcome: "accepted" })]);
    const finished = events.find(
      (e) => e.type === "run.finished" && e.payload.runId === old!.id
    );
    expect(
      finished?.type === "run.finished" && finished.payload.requeuedWakeIds
    ).toHaveLength(2);
    // 다시 시작해도 더 받지 않는다.
    // 정리가 맡은 같은 끝(한 번만 돈다)으로 끈다. 끄지 못했으면 정리가 같은 실패를 받아 DB를 닫지 않는다.
    await stopServer!();
    server = undefined;
    received = [];
    server = await startOwned({ db: database.db, port: 0 });
    await server.drain();
    expect(await http.runs(org.id)).toHaveLength(3);
  });
});

async function crashAndRestart(
  stopAfter: string,
  {
    legacy = false,
    say,
    committed,
    alsoSay,
  }: {
    legacy?: boolean;
    say?: string;
    committed: (http: Api, orgId: string) => Promise<boolean>;
    alsoSay?: string;
  }
) {
  database = await createTestDatabase();
  const child = spawn(
    process.execPath,
    [
      path.join(import.meta.dirname, "fixtures/crash-server.ts"),
      database.url,
      stopAfter,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  let readyUrl: string | undefined;
  let readyError: Error | undefined;
  let spawnError: Error | undefined;
  // 완전한 준비 줄(또는 읽지 못한 줄)을 받으면 알린다.
  let lineRead!: () => void;
  const startLine = new Promise<void>((resolve) => (lineRead = resolve));
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  // 준비 줄을 읽기 전부터 stdout을 끝까지 비우고, exit/error는 spawn 직후에 붙여 한 번만 오는 사건을 놓치지 않는다.
  child.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout = (stdout + text).slice(-4000);
    if (readyUrl) return;
    pendingLine += text;
    for (;;) {
      const newline = pendingLine.indexOf("\n");
      if (newline === -1) break;
      const line = pendingLine.slice(0, newline);
      pendingLine = pendingLine.slice(newline + 1);
      try {
        readyUrl = (JSON.parse(line) as { url: string }).url;
      } catch (error) {
        readyError = new Error(
          `crash server wrote an unreadable start line: ${JSON.stringify(line)}`,
          { cause: error }
        );
        lineRead();
        break;
      }
      if (readyUrl) {
        lineRead();
        break;
      }
    }
    if (pendingLine.length > 4000) pendingLine = pendingLine.slice(-4000);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  // 띄우지 못하면 exit가 오지 않을 수 있어, 띄우기 전의 error는 끌 프로세스가 없는 것으로 본다. 띄운 뒤의 error(신호를 보내지
  // 못함 등)는 종료를 확인하지 못한 것이라 거절한다.
  let spawned = false;
  child.once("spawn", () => {
    spawned = true;
  });
  const exited = awaitedLater(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => {
          if (spawned)
            return reject(
              new Error("the crash server's end was not confirmed", {
                cause: error,
              })
            );
          spawnError = error;
          resolve({ code: null, signal: null });
        });
      }
    )
  );
  // SIGKILL 뒤 종료가 보고되지 않으면 시험을 멈추지 않고 그 자식을 밝혀 실패한다.
  const exitedWithin = (ms: number) =>
    within(
      exited,
      ms,
      `crash server ${child.pid} did not exit after SIGKILL`
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (exit code ${child.exitCode}, signal ${child.signalCode}): stderr=${JSON.stringify(stderr)}`,
        { cause: error }
      );
    });
  // 시험이 어디서 실패하든 서버 프로세스를 끄고 끝나기를 기다린다. 그 뒤에 같은 DB로 다시 띄워 복구를 본다.
  databaseUsers.push(() =>
    within(exited, 10_000, `crash server ${child.pid} did not exit`)
  );
  const orgId = await withCleanup(async (defer) => {
    defer(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exitedWithin(10_000);
    });
    // 준비 줄은 조각나서 온다. 완전한 줄이 모이거나 프로세스가 끝나기를 기다리되 15초에서 멈춘다.
    const started = await within(
      Promise.race([
        startLine.then(() => "line" as const),
        exited.then(() => "exited" as const),
      ]),
      15_000,
      "crash server was not ready"
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
        { cause: error }
      );
    });
    if (started === "exited") {
      if (spawnError)
        throw new Error(`crash server could not start: ${spawnError.message}`);
      throw new Error(
        `crash server exited before it was ready (code ${child.exitCode}, signal ${child.signalCode}): stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
      );
    }
    if (readyError) throw readyError;
    const before = api(() => readyUrl!);
    const org = legacy
      ? await insertLegacyOrganization(database!.db, "crash 조직")
      : await before.createOrganization("crash 조직");
    if (say) await before.say(org.id, say);
    await pollUntil(
      async () => (await committed(before, org.id)) || undefined,
      {
        timeoutMs: 5_000,
        intervalMs: 25,
        timedOut: () => `waited 5000ms for ${stopAfter} to be committed`,
      }
    );
    if (alsoSay) await before.say(org.id, alsoSay);
    child.kill("SIGKILL");
    await exitedWithin(10_000);
    return org.id;
  });
  server = await startOwned({ db: database.db, port: 0 });
  await server.drain();
  const http = api(() => server!.url);
  const [next, old] = await http.runs(orgId);
  expect(old).toMatchObject({ status: "server_restart", wakeCount: 1 });
  // 새 실행 시도는 다시 대기한 깨우기와 함께, 멈춘 실행 시도가 수락한 실행 의도의 결과를 실은 복구 깨우기를 받는다.
  expect(next).toMatchObject({
    status: "completed",
    wakeCount: alsoSay ? 3 : 2,
  });
  const recovery = (await http.run(orgId, next!.id)).wakeReasons.find(
    (r) => r.kind === "intent_recovery"
  );
  expect(recovery).toMatchObject({ interruptedRunId: old!.id });
  expect(
    recovery?.kind === "intent_recovery" &&
      recovery.intents.map((i) => [i.tool, i.outcome.status])
  ).toContainEqual([stopAfter, "completed"]);
  return { http, org: { id: orgId }, next: next!, old: old! };
}

// 같은 원인의 인접 흐름: 반려 뒤 재요청과 결과 제출도 단계를 바꾸는 쓰기 뒤에 서버가 멈추면 남은 단계부터 이어 간다.
describe("demo Lead flows across a restart right after a stage-changing write", () => {
  /**
   * Lead의 다음 실행 시도를 `stopAfter` 쓰기 뒤에 멈추고 `trigger`로 깨운 뒤, 서버를 정상 종료하고 같은 DB로 다시 띄워
   * 재처리를 끝낸다. 다시 띄운 서버의 API를 돌려준다.
   */
  async function restartAfter(
    agents: ReturnType<typeof scriptedAgents>,
    leadId: string,
    stopAfter: Parameters<typeof writes>[0],
    trigger: () => Promise<void>
  ) {
    const gate = createGate();
    agents.queue(leadId, (request) =>
      holdAfter(defaultScriptSelector(request)!, writes(stopAfter), gate.wait)
    );
    await trigger();
    await gate.reached;
    await t!.stopServer();
    server = await startOwned({ db: t!.db, port: 0, runtime: agents.runtime });
    await server.drain();
    return api(() => server!.url);
  }
  const replies = async (http: Api, orgId: string) =>
    (await http.conversation(orgId))
      .filter((m) => m.author === "agent")
      .map((m) => m.body);

  it("resubmits a rejected initial research request once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const before = api(() => t!.baseUrl);
    const org = await before.createOrganization("재요청 조직");
    await t.drain();
    const [first] = approvalSummaryListSchema.parse(
      (await before.call("GET", `/api/organizations/${org.id}/approvals`)).body
    );

    const http = await restartAfter(
      agents,
      org.lead.id,
      "request_initial_approval",
      async () => {
        const res = await before.call(
          "POST",
          `/api/organizations/${org.id}/approvals/${first!.id}/decision`,
          { decision: "reject", note: "데이터셋을 정해 주세요" }
        );
        expect(res.status).toBe(200);
      }
    );
    const [next, old] = await http.runs(org.id);
    expect([old!.status, next!.status]).toEqual([
      "server_restart",
      "completed",
    ]);
    expect((await http.organization(org.id)).stage).toBe("awaiting_approval");
    const approvals = approvalSummaryListSchema.parse(
      (await http.call("GET", `/api/organizations/${org.id}/approvals`)).body
    );
    expect(approvals.map((a) => a.status).sort()).toEqual([
      "pending",
      "rejected",
    ]);
    const answers = await replies(http, org.id);
    expect(answers).toHaveLength(2);
    expect(answers[1]).toContain("사유를 반영해 계획을 다시 제출했습니다");
    expect((await http.events(org.id)).map((e) => e.type)).not.toContain(
      "tool.refused"
    );
  });

  it("finishes a result submission once", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const before = api(() => t!.baseUrl);
    const org = await serverHelpers(() => t!).researching(agents, "제출 조직");
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "오류 유형 분류", assigneeAgentId: org.workers[0]!.id },
      })
    );
    await before.say(org.id, "작업을 맡겨 주세요");
    await t.drain();

    const http = await restartAfter(agents, org.lead.id, "submit_result", () =>
      before.say(org.id, "결과 제출 부탁해요")
    );
    const [next, old] = await http.runs(org.id);
    expect([old!.status, next!.status]).toEqual([
      "server_restart",
      "completed",
    ]);
    expect((await http.organization(org.id)).stage).toBe("result_review");
    const submissions = (
      await http.call("GET", `/api/organizations/${org.id}/results`)
    ).body as unknown[];
    expect(submissions).toHaveLength(1);
    expect((await replies(http, org.id)).at(-1)).toContain(
      "근거 산출물 1개와 함께 제출했습니다"
    );
    expect((await http.events(org.id)).map((e) => e.type)).not.toContain(
      "tool.refused"
    );
  });
});

// 서버 시작 복구는 실행 중으로 남은 실행 시도를 모두 저장한 뒤에야 Event를 알리고 실행 시도를 촉진한다.
describe("server start recovery barrier", () => {
  it("starts no run and publishes nothing until every interrupted run is saved, then publishes the ends before any run starts", async () => {
    database = await createTestDatabase();
    const [early, late] = await leftRunning(database.db, 2);
    const runtime = countingRuntime();
    // 뒤쪽 실행 시도의 행을 붙잡아 그 복구 저장을 늦춘다.
    const held = createGate();
    let base = "";
    const http = api(() => base);
    // 이 시험이 띄운 서버와 붙잡은 행은 이 DB를 쓴다. afterEach는 등록 역순으로 행을 풀고 그 transaction이 끝난 것을 확인한 뒤
    // 시작 작업의 결과를 회수해 그 서버를 닫고, 모두 확인했을 때만 DB를 닫는다. 서버의 끝은 행을 푼 뒤에 와야 하므로(등록 역순) 행을
    // 붙잡기 전에 그 자리를 등록해 두고, 서버를 띄우는 즉시 채운다.
    const serverEnd: { stop?: () => Promise<void> } = {};
    databaseUsers.push(() => serverEnd.stop?.());
    const holding = holdRow(database.db, late!.runId, held);
    databaseUsers.push(() =>
      releaseHeld(() => held.open(), [() => holding], "the row hold")
    );
    // 잠그기 전에 transaction이 실패하면 `reached`는 오지 않으므로 그 실패로 끝낸다.
    await heldOrEnded(held.reached, holding, "the row hold");
    // 서버는 복구가 끝나기 전에 듣기 시작하므로, 포트 0에서 듣게 하고 듣기 시작할 때 알리는 주소를 받는다.
    let heard!: (url: string) => void;
    const listening = new Promise<string>((resolve) => (heard = resolve));
    const { started: starting } = ownStart(
      (stop) => (serverEnd.stop = stop),
      startServer({
        db: database.db,
        port: 0,
        runtime: runtime.adapter,
        onListening: heard,
      }),
      "the server"
    );
    base = await within(
      Promise.race([listening, starting.then(() => listening)]),
      eventuallyMs,
      "the server did not start listening"
    );
    await pollUntil(
      async () =>
        (await runStatus(early!.runId)) === "server_restart" || undefined,
      {
        timeoutMs: 10_000,
        intervalMs: 25,
        timedOut: () =>
          "waited 10000ms for the early run to end with server_restart",
      }
    );
    const stream = await listen(base);
    // 다른 시작 경로: 앞쪽이 복구된 조직에 사용자가 메시지를 보낸다. 저장은 되지만 실행 시도는 아직 시작하지 않는다.
    await http.say(early!.organizationId, "복구 중에 보낸 메시지");
    // 시간을 기다리지 않는다. 복구가 끝나기 전의 촉진은 응답 전에 그 자리에서 버려지고(`kick`), 메시지의 Event는 응답 전에
    // 나간다. 그래서 응답과 이 연결의 순서 표시 뒤에 보면 이 요청이 남긴 것은 모두 보인다. 붙잡아 둔 뒤쪽 복구는
    // `held`가 열기 전에는 끝나지 않으므로, 그 알림도 이때까지 나갈 수 없다.
    const beforeRecovery = await stream.received();
    expect(runtime.executions()).toEqual([]);
    expect(
      beforeRecovery.events
        .map((e) => e.type)
        .filter((t) => t !== "message.created")
    ).toEqual([]);
    expect(await runStatus(late!.runId)).toBe("running");
    held.open();
    const running = await within(
      starting,
      eventuallyMs,
      "the server did not finish starting"
    );
    await running.drain();
    // 끝난 실행 시도가 보낸 Event를 모두 받은 뒤에 닫는다. 그사이 연결이 실패했으면 그 실패로 끝난다.
    const afterRecovery = await stream.received();
    stream.close();

    // 복구된 깨우기는 다시 처리되고, 복구 중에 보낸 메시지는 같은 조직의 다음 실행 시도가 받는다.
    expect(runtime.executions().sort()).toEqual(
      [early!.leadId, late!.leadId].sort()
    );
    const types = afterRecovery.events
      .map((e) => e.type)
      .filter((t) => t !== "message.created");
    expect(types.slice(0, 2)).toEqual(["run.finished", "run.finished"]);
    expect(types.filter((t) => t === "run.finished")).toHaveLength(4);
    expect(
      (await http.runs(early!.organizationId)).map((r) => [
        r.status,
        r.wakeCount,
      ])
    ).toEqual([
      ["completed", 2],
      ["server_restart", 1],
    ]);
  });

  it("starts no run when a later recovery save fails, and the next start ends only the rest", async () => {
    database = await createTestDatabase();
    const [early, late] = await leftRunning(database.db, 2);
    const runtime = countingRuntime();
    const restore = await failRunEnd(database.db, late!.runId);
    // 거절을 기대한다(뒤쪽 복구 저장이 실패한다). 시작 실패 뒤 정리가 모두 됐으면 그 시작 동안의 진단은 아래 목록뿐이다. 진단 전체가
    // 그와 같을 때만 정리를 확인한 것으로 본다.
    const diagnostics = startDiagnostics();
    const starting = ownStart(
      (stop) => databaseUsers.push(stop),
      startServer({
        db: database.db,
        port: 0,
        runtime: runtime.adapter,
      }),
      "the server whose start should fail",
      diagnostics.endedWith({ error: [], warn: [] })
    ).started;
    await expect(starting).rejects.toThrow();
    expect(await runStatus(early!.runId)).toBe("server_restart");
    expect(await runStatus(late!.runId)).toBe("running");
    expect(runtime.executions()).toEqual([]);

    await restore();
    server = await startOwned({
      db: database.db,
      port: 0,
      runtime: runtime.adapter,
    });
    await server.drain();
    const http = api(() => server!.url);
    expect(await runStatus(late!.runId)).toBe("server_restart");
    expect(runtime.executions().sort()).toEqual(
      [early!.leadId, late!.leadId].sort()
    );
    // 앞서 끝낸 실행 시도의 종료는 다시 남지 않는다.
    expect(
      (await http.events(early!.organizationId)).filter(
        (e) => e.type === "run.finished" && e.payload.runId === early!.runId
      )
    ).toHaveLength(1);
  });

  async function runStatus(runId: string) {
    const { rows } = await database!.db.execute<{ status: string }>(
      `select status from runs where id = '${runId}'`
    );
    return rows[0]?.status;
  }
});

/** 조직 `count`개를 만들고 각 Lead의 생성 깨우기를 실행 중인 실행 시도로 남긴다. 서버가 멈춰 남긴 실행 시도와 같다. */
async function leftRunning(db: Database, count: number) {
  const source = { newId: randomUUID, now: () => new Date() };
  const left = [];
  for (let i = 0; i < count; i++) {
    const creation = planOrganizationCreation(
      {
        name: `복구 장벽 ${i}`,
        goal: "목표",
        lead: { provider: "fake", model: null },
      },
      { files: [] },
      source
    );
    await insertOrganizationCreation(db, creation);
    const lead = creation.agents[0]!;
    const claimed = await claimNextRun(db, lead.id, {
      tokenDigest: randomUUID(),
      source,
    });
    left.push({
      organizationId: lead.organizationId,
      leadId: lead.id,
      runId: claimed!.run.id,
    });
  }
  return left;
}

/** 맥락만 읽고 끝나는 가짜 프로바이더. 실행 시도를 받은 에이전트를 순서대로 남긴다. */
function countingRuntime() {
  const inner = createScriptedRuntime({ select: () => idle });
  const executions: string[] = [];
  return {
    executions: () => [...executions],
    adapter: {
      ...inner,
      execute: (request, control) => {
        executions.push(request.identity.agentId);
        return inner.execute(request, control);
      },
    } satisfies RuntimeAdapter,
  };
}

/** gate가 열릴 때까지 실행 시도 행을 잠근 transaction. */
function holdRow(db: Database, runId: string, gate: Gate) {
  return db.transaction(async (tx) => {
    await tx.execute(`select id from runs where id = '${runId}' for update`);
    await gate.wait(new AbortController().signal);
  });
}

/**
 * 전체 Event stream을 구독한다. 서버가 듣기 시작한 뒤(`onListening`)에 부르므로 다시 시도하지 않는다(`openEventStream`). 연결은 만든 직후
 * 시험 정리에 맡겨, 시험이 중간에 실패해도 끊는다(시험이 청한 닫힘이라 실패가 아니다).
 */
async function listen(base: string) {
  const { subscription } = await openEventStream(
    base.replace(/^http/, "ws") + eventStreamPath,
    { opened: (terminate) => onTestFinished(terminate) }
  );
  return subscription;
}
