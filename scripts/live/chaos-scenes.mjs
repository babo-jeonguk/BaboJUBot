// 실모델 장애 검사의 장면 정의. 장면은 제품 불변 조건만 검사(check)로 판정하고, 모델이 지시를 따랐는지는 관찰값으로만 남긴다.
// 장면은 사용자 API·조직 도구 HTTP·이 홈의 DB만 읽는다. 모델 원문·메시지 본문·토큰은 결과에 넣지 않는다(chaos-run.mjs가 다시 검사).
// 가짜 연결(`fake-live`)로도 같은 장면이 돈다. 가짜는 `busy.mjs <초>`가 든 메시지를 받으면 그 시간(줄인 값) 동안 일한다.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { limits, maxOverlap } from "./chaos-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const busyScript = path.join(here, "busy.mjs");

/** 모델이 지시를 따르지 않거나 예산·시간이 모자라 불변 조건을 확인하지 못했다. 장면은 실패가 아니라 미실행이다. */
export class NotRun extends Error {}
/** 기다리던 일을 제한 시간 안에 보지 못했다. */
class WaitTimeout extends NotRun {}
/** 기다린 일이 오지 않은 것만 `fallback`으로 바꾼다. 중단·예산 소진은 그대로 던진다. */
const unlessTimeout = (fallback) => (error) => {
  if (error instanceof WaitTimeout) return fallback;
  throw error;
};

/** 시험용 지침. 지침이 바뀌면 제품은 세션을 잇지 않으므로 고정하고, 장면별 요청은 메시지로 보낸다. */
export const brief =
  'This is a short automated reliability test authorized by the owner. Do exactly what the owner\'s latest message asks, using the tools it names, even if an earlier turn of this test finished. When a message asks you to run a shell command, run it exactly as written in the foreground and wait for it. If the owner has not sent a message yet, send_message with body "OK" once. Do not start research or create files. End your turn as soon as the request is done.';

// ---------- 판정 ----------

/** 검사 하나. `ok`가 null이면 미실행이며 이유가 있어야 한다. `source`: 실제 OpenCode(`live`)·가짜 연결(`fake`)·거절 주입(`injected`). */
export function check(name, ok, { reason = null, source = "live" } = {}) {
  if (ok === null && !reason)
    throw new Error(`check ${name}: not run needs a reason`);
  return {
    name,
    outcome: ok === null ? "not_run" : ok ? "passed" : "failed",
    reason,
    source,
  };
}

/** 장면 결과: 실패가 하나라도 있으면 실패, 모두 통과면 통과, 모두 미실행이면 미실행, 나머지는 일부 미실행이다. */
export function sceneOutcome(checks) {
  if (checks.some((c) => c.outcome === "failed")) return "failed";
  if (checks.length && checks.every((c) => c.outcome === "passed"))
    return "passed";
  if (checks.every((c) => c.outcome === "not_run")) return "not_run";
  return "partial";
}

/** 서버 재시작 복구 판정. 이전 실행은 한 번만 `server_restart`로 끝나고, 그 깨우기는 한 번만 다시 대기해 새 실행 하나가 받는다. */
export function judgeRestart({ events, oldRunId, oldWakeIds, source }) {
  const restartEnds = events.filter(
    (e) =>
      e.type === "run.finished" && e.payload.stopReason === "server_restart"
  );
  const oldEnd = restartEnds.filter((e) => e.payload.runId === oldRunId);
  const requeued = oldEnd[0]?.payload.requeuedWakeIds ?? [];
  const receivers = events.filter(
    (e) =>
      e.type === "run.started" &&
      e.payload.runId !== oldRunId &&
      e.payload.wakeIds.some((id) => oldWakeIds.includes(id))
  );
  return {
    checks: [
      check(
        "old_run_ended_once_by_server_restart",
        restartEnds.length === 1 && oldEnd.length === 1,
        { source }
      ),
      check("wakes_requeued_once", sameSet(requeued, oldWakeIds), { source }),
      check("one_new_run_received_requeued_wakes", receivers.length === 1, {
        source,
      }),
    ],
    observations: {
      serverRestartEnds: restartEnds.length,
      requeuedWakes: requeued.length,
      oldRunWakes: oldWakeIds.length,
      newRunsWithRequeuedWakes: receivers.length,
    },
    newRunId: receivers[0]?.payload.runId ?? null,
  };
}

/** 연결 동시 실행 상한 판정. 실행 구간(시작·끝 시각)의 최대 겹침이 상한 이하이고, 기다린 실행은 자리가 난 뒤 시작했다. */
export function judgeConcurrency({ intervals, limit, source }) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const overlap = maxOverlap(intervals);
  // 상한만큼 실행 중일 때 들어온 실행은 그중 하나가 끝난 뒤에 시작해야 한다.
  const waited = sorted.slice(limit).every((later, i) => {
    const before = sorted.slice(0, limit + i);
    return before.some((b) => b.end !== null && b.end <= later.start);
  });
  return {
    checks: [
      check("never_more_than_limit_running", overlap <= limit, { source }),
      check(
        "waiting_request_started_after_a_slot_freed",
        sorted.length > limit ? waited : null,
        {
          source,
          reason:
            sorted.length > limit ? null : "상한보다 많은 실행이 생기지 않음",
        }
      ),
    ],
    observations: { runs: intervals.length, maxOverlap: overlap, limit },
  };
}

const sameSet = (a, b) =>
  a.length === b.length && a.every((x) => b.includes(x));

// ---------- 장면 공통 도구 ----------

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });

/** `fn`이 참 값을 낼 때까지 기다린다. 시간이 지나면 `onTimeout`(기본: 미실행)을 던진다. 예산이 소진되면 미실행으로 멈춘다. */
async function waitFor(ctx, what, fn, { ms = 120_000, every = 300 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    ctx.signal.throwIfAborted();
    ctx.assertBudget();
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw new WaitTimeout(`${what}: 제한 시간 안에 관찰하지 못함`);
    await sleep(every, ctx.signal);
  }
}

/** 실제 연결은 그대로, 가짜 연결은 1/10로 줄인 초. 긴 명령 상한(90초)을 넘지 않는다. */
const seconds = (ctx, n) =>
  Math.min(
    limits.longCommandSeconds,
    ctx.fake ? Math.max(2, Math.round(n / 10)) : n
  );

const longCommand = (ctx, n) =>
  `node ${busyScript} ${seconds(ctx, n)} ${ctx.marker}`;

/** 이 장면이 띄운 시험용 긴 명령의 PID. 다른 작업의 프로세스는 표시(marker)가 달라 잡히지 않는다. */
export function busyPids(marker) {
  try {
    return execFileSync("pgrep", ["-f", `busy\\.mjs [0-9]+ ${marker}$`])
      .toString()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const runsOf = async (ctx, org) =>
  (await ctx.api("GET", `/api/organizations/${org.id}/runs`)).body;
const runOf = async (ctx, org, id) =>
  (await ctx.api("GET", `/api/organizations/${org.id}/runs/${id}`)).body;
const eventsOf = async (ctx, org) =>
  (await ctx.api("GET", `/api/organizations/${org.id}/events`)).body;
const messagesOf = async (ctx, org) =>
  (await ctx.api("GET", `/api/organizations/${org.id}/messages`)).body.messages;

async function say(ctx, org, body, delivery = "next_run") {
  ctx.secrets.add(body);
  const sent = await ctx.api("POST", `/api/organizations/${org.id}/messages`, {
    body,
    delivery,
  });
  if (sent.status >= 300)
    throw new Error(`message (${delivery}) refused with ${sent.status}`);
  return sent.body;
}

/** 실행 시도 토큰. 서버 프로세스가 0600 파일로 둔 것을 읽고 비밀값으로 등록한다. 실행이 끝나면 파일은 지워진다. */
function tokenOf(ctx, runId) {
  try {
    const token = readFileSync(
      path.join(ctx.server.files.tokens, `${runId}.token`),
      "utf8"
    );
    ctx.secrets.add(token);
    return token;
  } catch {
    return null;
  }
}

/** 조직 도구를 실행 시도 토큰으로 직접 부른다(같은 호출 키 재생). */
async function tool(ctx, token, method, route, body, key) {
  const response = await fetch(`${ctx.server.info.url}/api/tools${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * 조직 하나를 만든다. 조직 생성 깨우기는 가짜 연결로 처리해 실제 실행을 쓰지 않고, heartbeat를 끈 뒤 Lead를 실제 연결로 바꾼다.
 */
async function setupOrg(ctx, name) {
  const created = await ctx.api("POST", "/api/organizations", {
    name,
    goal: "Reliability test only.",
    completionCriteria: "Short replies.",
    lead: { provider: "fake", model: "fake-mini" },
  });
  if (created.status !== 201)
    throw new Error(`organization refused with ${created.status}`);
  const org = {
    id: created.body.id,
    leadId: created.body.agents.find((a) => a.role === "lead").id,
  };
  await settled(ctx, org);
  const lead = (
    await ctx.api("GET", `/api/organizations/${org.id}/agents/${org.leadId}`)
  ).body;
  await ctx.api(
    "PUT",
    `/api/organizations/${org.id}/agents/${org.leadId}/heartbeat`,
    {
      enabled: false,
      intervalMinutes: lead.heartbeat.intervalMinutes,
    }
  );
  const switched = await ctx.api(
    "PUT",
    `/api/organizations/${org.id}/agents/${org.leadId}/provider`,
    {
      provider: ctx.liveId,
      model: ctx.model,
    }
  );
  if (switched.status >= 300)
    throw new Error(`provider change refused with ${switched.status}`);
  return org;
}

/** 실행 중인 실행이 없고 줄 선 메시지도 없는 상태가 이어질 때까지 기다린다. */
async function settled(ctx, org, ms = 300_000) {
  let quietSince = null;
  await waitFor(
    ctx,
    "실행이 모두 끝남",
    async () => {
      const running = (
        await ctx.api("GET", `/api/organizations/${org.id}/runs?status=running`)
      ).body;
      const queued = (
        await ctx.api("GET", `/api/organizations/${org.id}/queued-messages`)
      ).body;
      const quiet =
        running.length === 0 && (queued.messages ?? queued).length === 0;
      if (!quiet) quietSince = null;
      else quietSince ??= Date.now();
      return quiet && Date.now() - quietSince >= 1500;
    },
    { ms, every: 500 }
  );
}

/** `known`에 없는 새 실행 시도가 생길 때까지 기다린다(이미 끝났을 수도 있다). */
const newRun = (ctx, org, known, ms) =>
  waitFor(
    ctx,
    "새 실행 시작",
    async () => (await runsOf(ctx, org)).find((r) => !known.includes(r.id)),
    { ms }
  );

/** 시험용 긴 명령이 실제로 돌기 시작할 때까지 기다린다. 가짜 연결은 프로세스를 띄우지 않으므로 바로 지나간다. */
async function commandStarted(ctx) {
  if (ctx.fake) return [];
  return waitFor(ctx, "모델이 시험용 긴 명령을 시작함", async () => {
    const pids = busyPids(ctx.marker);
    return pids.length ? pids : null;
  });
}

const startedEventOf = (events, runId) =>
  events.find((e) => e.type === "run.started" && e.payload.runId === runId);

const fakeOr = (ctx) => (ctx.fake ? "fake" : "live");

/** 이 장면 실행 기록. */
const ledgerOf = (ctx) => ctx.ledger.read();
const endOf = (ctx, runId) =>
  ledgerOf(ctx).find((e) => e.kind === "end" && e.runId === runId);
const claimOf = (ctx, runId) =>
  ledgerOf(ctx).find((e) => e.kind === "claim" && e.runId === runId);

const processCheck = (ctx, name, ok) =>
  ctx.fake
    ? check(name, null, {
        source: "fake",
        reason: "가짜 연결은 프로그램을 띄우지 않음",
      })
    : check(name, ok);

// ---------- 장면 ----------

/** a. 실행 중 취소: 취소된 실행의 토큰은 바로 거절되고, 정리가 끝나기 전에 다음 실행이 시작되지 않으며, 받은 입력은 다시 전달되지 않는다. */
async function cancelScene(ctx) {
  const org = await setupOrg(ctx, "Chaos cancel");
  const known = (await runsOf(ctx, org)).map((r) => r.id);
  await say(
    ctx,
    org,
    `Run the shell command \`${longCommand(ctx, 85)}\` in the foreground and wait for it to finish. Then send_message with body "DONE" once.`
  );
  const run = await newRun(ctx, org, known);
  const pids = await commandStarted(ctx);
  const token = await waitFor(
    ctx,
    "실행 시도 토큰",
    async () => tokenOf(ctx, run.id),
    { ms: 30_000 }
  );
  // 정리 중에 기다리는 깨우기가 있어야 "정리 전에 다음 실행 없음"을 볼 수 있다.
  await say(
    ctx,
    org,
    'Send_message with body "NEXT" once. Do not run any command.'
  );
  const interrupted = await ctx.api(
    "POST",
    `/api/organizations/${org.id}/agents/${org.leadId}/interrupt`,
    {}
  );
  const refused = await tool(ctx, token, "GET", "/run-context");
  await waitFor(
    ctx,
    "취소된 실행이 끝남",
    async () => (await runOf(ctx, org, run.id)).status !== "running",
    { ms: 60_000 }
  );
  const pidsAfterEnd = pids.filter(alive);
  const next = await newRun(ctx, org, [...known, run.id], 120_000).catch(
    unlessTimeout(null)
  );
  await settled(ctx, org);
  const events = await eventsOf(ctx, org);
  const first = startedEventOf(events, run.id);
  const second = next && startedEventOf(events, next.id);
  const end = endOf(ctx, run.id);
  const nextClaim = next && claimOf(ctx, next.id);
  const finished = await runOf(ctx, org, run.id);
  const source = fakeOr(ctx);
  return {
    checks: [
      check("interrupt_accepted", interrupted.status < 300, { source }),
      check(
        "cancelled_run_token_refused",
        refused.status === 401 || refused.status === 403,
        { source }
      ),
      check(
        "run_finished_cancelled",
        finished.status === "cancelled" &&
          finished.cancelReason === "owner_interrupt",
        { source }
      ),
      processCheck(
        ctx,
        "command_process_gone_when_run_ended",
        pidsAfterEnd.length === 0
      ),
      check(
        "next_run_started_after_cleanup",
        next && end && nextClaim ? nextClaim.at >= end.at : null,
        { source, reason: next ? null : "다음 실행이 시작되지 않음" }
      ),
      check(
        "input_not_redelivered",
        second
          ? !second.payload.wakeIds.some((id) =>
              first.payload.wakeIds.includes(id)
            )
          : null,
        { source, reason: second ? null : "다음 실행이 시작되지 않음" }
      ),
    ],
    observations: {
      interruptStatus: interrupted.status,
      refusedToolStatus: refused.status,
      commandPidsBefore: pids.length,
      commandPidsAfterEnd: pidsAfterEnd.length,
      cleanupToNextStartMs:
        next && end && nextClaim ? nextClaim.at - end.at : null,
      agentInterruptedEvents: events.filter(
        (e) => e.type === "agent.interrupted"
      ).length,
      cancelledRunFinishedEvents: events.filter(
        (e) => e.type === "run.finished" && e.payload.stopReason === "cancelled"
      ).length,
    },
  };
}

/** 실행 하나를 긴 명령으로 띄우고 그 실행·깨우기·명령 PID를 돌려준다. */
async function startLongRun(ctx, org, secondsWanted = 85, prefix = "") {
  const known = (await runsOf(ctx, org)).map((r) => r.id);
  await say(
    ctx,
    org,
    `${prefix}Run the shell command \`${longCommand(ctx, secondsWanted)}\` in the foreground and wait for it to finish. Then send_message with body "DONE" once.`
  );
  const run = await newRun(ctx, org, known);
  const pids = await commandStarted(ctx);
  const events = await eventsOf(ctx, org);
  return {
    run,
    pids,
    wakeIds: startedEventOf(events, run.id).payload.wakeIds,
    known: [...known, run.id],
  };
}

/** 서버만 SIGKILL로 끝내고 같은 홈·DB로 다시 띄운다. */
async function killAndRestart(ctx) {
  await ctx.server.kill();
  await ctx.server.start();
}

/** b. 서버 강제 종료 뒤 복구. */
async function restartScene(ctx) {
  const org = await setupOrg(ctx, "Chaos restart");
  const first = await startLongRun(ctx, org);
  const recordsBefore = ctx.processRecords();
  await killAndRestart(ctx);
  const next = await newRun(ctx, org, first.known, 120_000);
  // 다시 대기한 깨우기를 받은 실행은 확인했으니 긴 명령을 기다리지 않고 끝낸다.
  await ctx.api(
    "POST",
    `/api/organizations/${org.id}/agents/${org.leadId}/interrupt`,
    {}
  );
  await settled(ctx, org);
  const events = await eventsOf(ctx, org);
  const judged = judgeRestart({
    events,
    oldRunId: first.run.id,
    oldWakeIds: first.wakeIds,
    source: fakeOr(ctx),
  });
  const oldPidsLeft = first.pids.filter(alive);
  return {
    checks: [
      ...judged.checks,
      check("restart_receiver_is_the_new_run", judged.newRunId === next.id, {
        source: fakeOr(ctx),
      }),
      processCheck(
        ctx,
        "old_run_processes_cleaned_after_restart",
        oldPidsLeft.length === 0
      ),
    ],
    observations: {
      ...judged.observations,
      processRecordsBeforeKill: recordsBefore,
      oldCommandPids: first.pids.length,
      oldCommandPidsLeft: oldPidsLeft.length,
    },
  };
}

/** c. 재시작 전후 같은 호출 키. */
async function idempotencyScene(ctx) {
  const org = await setupOrg(ctx, "Chaos idempotency");
  const first = await startLongRun(ctx, org);
  const oldToken = await waitFor(
    ctx,
    "실행 시도 토큰",
    async () => tokenOf(ctx, first.run.id),
    { ms: 30_000 }
  );
  const key = `chaos-${ctx.marker}`;
  const input = { body: `IDEMPOTENT ${ctx.marker}` };
  ctx.secrets.add(input.body);
  const original = await tool(ctx, oldToken, "POST", "/messages", input, key);
  if (original.status !== 201)
    throw new Error(`first tool call returned ${original.status}`);
  const counts = async () => {
    const events = await eventsOf(ctx, org);
    return {
      messages: (await messagesOf(ctx, org)).filter(
        (m) => m.body === input.body
      ).length,
      messageEvents: events.filter(
        (e) =>
          e.type === "message.created" &&
          e.payload.messageId === original.body.id
      ).length,
      wakes: Number(
        (
          await ctx.query(
            "select count(*)::int as n from wakes where organization_id = $1",
            [org.id]
          )
        )[0].n
      ),
    };
  };
  await killAndRestart(ctx);
  const next = await newRun(ctx, org, first.known, 120_000);
  const newToken = await waitFor(
    ctx,
    "새 실행 시도 토큰",
    async () => tokenOf(ctx, next.id),
    { ms: 30_000 }
  );
  const before = await counts();
  const replay = await tool(ctx, newToken, "POST", "/messages", input, key);
  const after = await counts();
  const otherInput = await tool(
    ctx,
    newToken,
    "POST",
    "/messages",
    { body: `OTHER ${ctx.marker}` },
    key
  );
  const otherTool = await tool(
    ctx,
    newToken,
    "POST",
    "/memories",
    { scope: "agent", content: `OTHER ${ctx.marker}` },
    key
  );
  const oldTokenReplay = await tool(
    ctx,
    oldToken,
    "POST",
    "/messages",
    input,
    key
  );
  await ctx.api(
    "POST",
    `/api/organizations/${org.id}/agents/${org.leadId}/interrupt`,
    {}
  );
  await settled(ctx, org);
  const source = fakeOr(ctx);
  const conflict = (r) =>
    r.status === 409 && r.body?.error?.code === "idempotency_conflict";
  return {
    checks: [
      check(
        "replay_with_new_run_token_returns_first_result",
        replay.status === original.status &&
          isDeepStrictEqual(replay.body, original.body),
        { source }
      ),
      check(
        "replay_adds_no_effect_event_or_wake",
        JSON.stringify(before) === JSON.stringify(after) &&
          after.messages === 1 &&
          after.messageEvents === 1,
        { source }
      ),
      check("same_key_other_input_conflicts", conflict(otherInput), { source }),
      check("same_key_other_tool_conflicts", conflict(otherTool), { source }),
      check(
        "old_run_token_refused_after_restart",
        oldTokenReplay.status === 401 || oldTokenReplay.status === 403,
        { source }
      ),
    ],
    observations: {
      firstStatus: original.status,
      replayStatus: replay.status,
      otherInputStatus: otherInput.status,
      otherToolStatus: otherTool.status,
      oldTokenStatus: oldTokenReplay.status,
      countsBeforeReplay: before,
      countsAfterReplay: after,
    },
  };
}

/** d. 조직 간 동시 실행 제한: 상한 2에서 세 조직이 요청한다. */
async function concurrencyScene(ctx) {
  const limit = 2;
  const orgs = [];
  for (const name of ["Chaos limit 1", "Chaos limit 2", "Chaos limit 3"])
    orgs.push(await setupOrg(ctx, name));
  const set = await ctx.api("PUT", `/api/providers/${ctx.liveId}/limit`, {
    maxConcurrentRuns: limit,
  });
  if (set.status >= 300) throw new Error(`limit refused with ${set.status}`);
  const known = new Map();
  for (const org of orgs)
    known.set(
      org.id,
      (await runsOf(ctx, org)).map((r) => r.id)
    );
  for (const org of orgs)
    await say(
      ctx,
      org,
      `Run the shell command \`${longCommand(ctx, 30)}\` in the foreground and wait for it to finish. Then send_message with body "DONE" once.`
    );
  // 기다리는 동안 실행 중 개수를 따로 표본으로도 센다.
  let sampledMax = 0;
  await waitFor(
    ctx,
    "세 조직의 실행이 모두 끝남",
    async () => {
      let running = 0,
        done = 0;
      for (const org of orgs) {
        const runs = (await runsOf(ctx, org)).filter(
          (r) => !known.get(org.id).includes(r.id)
        );
        running += runs.filter((r) => r.status === "running").length;
        if (runs.length && runs.every((r) => r.status !== "running")) done++;
      }
      sampledMax = Math.max(sampledMax, running);
      return done === orgs.length;
    },
    { ms: 420_000, every: 250 }
  );
  for (const org of orgs) await settled(ctx, org);
  const intervals = [];
  for (const org of orgs)
    for (const run of await runsOf(ctx, org))
      if (!known.get(org.id).includes(run.id) && run.provider === ctx.liveId)
        intervals.push({
          start: Date.parse(run.startedAt),
          end: run.finishedAt ? Date.parse(run.finishedAt) : null,
        });
  const ranPerOrg = [];
  for (const org of orgs)
    ranPerOrg.push(
      (await runsOf(ctx, org)).filter(
        (r) =>
          !known.get(org.id).includes(r.id) &&
          r.provider === ctx.liveId &&
          r.status !== "running"
      ).length
    );
  const judged = judgeConcurrency({ intervals, limit, source: fakeOr(ctx) });
  // 프로세스 수준(실행 관문의 시작·끝)도 상한을 넘지 않는다.
  const entries = ledgerOf(ctx).filter((e) => e.scene === ctx.scene);
  const processIntervals = entries
    .filter((e) => e.kind === "claim")
    .map((c) => ({
      start: c.at,
      end:
        entries.find((e) => e.kind === "end" && e.runId === c.runId)?.at ??
        null,
    }));
  return {
    checks: [
      ...judged.checks,
      check(
        "executions_never_more_than_limit",
        maxOverlap(processIntervals) <= limit,
        { source: fakeOr(ctx) }
      ),
      check(
        "every_organization_ran",
        ranPerOrg.every((n) => n >= 1),
        { source: fakeOr(ctx) }
      ),
    ],
    observations: {
      ...judged.observations,
      sampledMaxRunning: sampledMax,
      executionMaxOverlap: maxOverlap(processIntervals),
    },
  };
}

/** e. 실행 중 메시지 전달: 수락·실제 거절·주입한 거절. */
async function steerScene(ctx) {
  const org = await setupOrg(ctx, "Chaos steer");
  const source = fakeOr(ctx);
  const word = `W${ctx.marker.slice(-6).toUpperCase()}`;
  ctx.secrets.add(word);
  const ask = (n) =>
    `Run the shell command \`${longCommand(ctx, n)}\` in the foreground and wait for it to finish. Only after it finishes, send_message once: if I sent you another message meanwhile, the body must be exactly the word it gives; otherwise send NONE.`;

  // 수락: 지금 실행으로 전달되고 새 실행을 만들지 않는다. 실제가 거절하면(줄 섬) 다음 실행으로 가야 한다.
  let known = (await runsOf(ctx, org)).map((r) => r.id);
  await say(ctx, org, ask(25));
  const first = await newRun(ctx, org, known);
  await commandStarted(ctx);
  const steered = await say(ctx, org, `The word is ${word}.`, "steer");
  await waitFor(
    ctx,
    "끼워 넣은 실행이 끝남",
    async () => (await runOf(ctx, org, first.id)).status !== "running",
    { ms: 180_000 }
  );
  await settled(ctx, org);
  let runs = await runsOf(ctx, org);
  let message = (await messagesOf(ctx, org)).find((m) => m.id === steered.id);
  let events = await eventsOf(ctx, org);
  const steerEvent = events.find(
    (e) => e.type === "message.steered" && e.payload.messageId === steered.id
  );
  const realRejected = steerEvent?.payload.outcome === "queued";
  const newRunsAfterAccept = runs.filter(
    (r) => !known.includes(r.id) && r.id !== first.id
  ).length;
  const replies = (await messagesOf(ctx, org)).filter(
    (m) => m.author === "agent"
  );
  const checks = [
    check(
      "accepted_steer_reaches_current_run",
      realRejected
        ? null
        : message.deliveredToRunId === first.id &&
            steerEvent?.payload.outcome === "accepted",
      { source, reason: realRejected ? "실제 OpenCode가 거절함" : null }
    ),
    check(
      "accepted_steer_creates_no_extra_run",
      realRejected ? null : newRunsAfterAccept === 0,
      {
        source,
        reason: realRejected ? "실제 OpenCode가 거절함" : null,
      }
    ),
    check(
      "real_rejection_goes_to_next_run",
      realRejected
        ? message.deliveredToRunId !== null &&
            message.deliveredToRunId !== first.id
        : null,
      {
        source,
        reason: realRejected
          ? null
          : ctx.fake
            ? "가짜 연결에서는 실제 거절을 관찰할 수 없음"
            : "실제 OpenCode의 거절을 재현하지 못함(이번 실행에서 끼워 넣기가 수락됨)",
      }
    ),
  ];
  const acceptedReplyHadWord = replies.some((m) => m.body.includes(word));

  // 거절 주입: 서버의 실행 관문이 끼워 넣기를 거절로 돌려준다. 메시지는 다음 실행으로 가야 한다.
  known = runs.map((r) => r.id);
  await say(ctx, org, ask(20));
  const second = await newRun(ctx, org, known);
  await commandStarted(ctx);
  ctx.control({ injectSteerRejection: true });
  let injected;
  try {
    injected = await say(ctx, org, `The word is ${word}.`, "steer");
  } finally {
    ctx.control({});
  }
  await settled(ctx, org);
  runs = await runsOf(ctx, org);
  message = (await messagesOf(ctx, org)).find((m) => m.id === injected.id);
  events = await eventsOf(ctx, org);
  const injectedEvent = events.find(
    (e) => e.type === "message.steered" && e.payload.messageId === injected.id
  );
  const receiver = runs.find((r) => r.id === message.deliveredToRunId);
  checks.push(
    check(
      "injected_rejection_queues_message",
      injectedEvent?.payload.outcome === "queued",
      { source: "injected" }
    ),
    check(
      "injected_rejection_delivers_to_next_run",
      !!receiver && receiver.id !== second.id && !known.includes(receiver.id),
      { source: "injected" }
    )
  );
  return {
    checks,
    observations: {
      firstSteerOutcome: steerEvent?.payload.outcome ?? null,
      realRejectionObserved: realRejected,
      acceptedReplyHadWord,
      newRunsAfterAccept,
      injectedSteerOutcome: injectedEvent?.payload.outcome ?? null,
      injectedDeliveredToNewRun: !!receiver && receiver.id !== second.id,
      steerLedger: ledgerOf(ctx)
        .filter(
          (e) => e.kind === "steer" && [first.id, second.id].includes(e.runId)
        )
        .map((e) => ({ outcome: e.outcome, injected: e.injected })),
    },
  };
}

/** f. 대화 세션 재개와 설정 변경. 프로바이더 변경은 가짜 연결로 한다. */
async function sessionScene(ctx) {
  const org = await setupOrg(ctx, "Chaos session");
  const word = `C${ctx.marker.slice(-6).toUpperCase()}`;
  ctx.secrets.add(word);
  const step = async (body) => {
    const known = (await runsOf(ctx, org)).map((r) => r.id);
    await say(ctx, org, body);
    const run = await newRun(ctx, org, known);
    await settled(ctx, org);
    return endOf(ctx, run.id);
  };
  const changeTo = (provider, model) =>
    ctx.api(
      "PUT",
      `/api/organizations/${org.id}/agents/${org.leadId}/provider`,
      { provider, model }
    );
  const live = fakeOr(ctx);

  const planted = await step(
    `Remember this codeword: ${word}. Then send_message with body "NOTED" once.`
  );
  ctx.control({ stripConversation: true });
  let recalled;
  try {
    recalled = await step(
      "Do not call get_run_context. Send_message with only the codeword I told you earlier in this session. If you do not know it, send UNKNOWN."
    );
  } finally {
    ctx.control({});
  }
  const recalledWord = (await messagesOf(ctx, org)).some(
    (m) => m.author === "agent" && m.body.includes(word)
  );
  const checks = [
    check(
      "same_connection_resumes_session",
      !!planted.sessionAfter && recalled.resumedFrom === planted.sessionAfter,
      { source: live }
    ),
  ];

  // 모델만 바꾸면 세션을 유지한다. 다른 모델은 사람이 정한 것만 쓴다(비용).
  let last = recalled;
  const altModel = ctx.fake ? "fake-live-max" : ctx.altModel;
  if (altModel && ctx.remainingSceneRuns() >= 2) {
    const changed = await changeTo(ctx.liveId, altModel);
    if (changed.status >= 300) {
      checks.push(
        check("model_change_keeps_session", null, {
          source: live,
          reason: `모델 변경이 거절됨(${changed.status})`,
        })
      );
    } else {
      last = await step('Send_message with body "MODEL" once.');
      checks.push(
        check(
          "model_change_keeps_session",
          !!recalled.sessionAfter && last.resumedFrom === recalled.sessionAfter,
          { source: live }
        )
      );
    }
  } else
    checks.push(
      check("model_change_keeps_session", null, {
        source: live,
        reason: altModel
          ? "남은 예산 부족"
          : "다른 모델을 정하지 않음(BABOJUBOT_CHAOS_ALT_MODEL)",
      })
    );

  // 프로바이더를 가짜로 바꿨다 돌아오면 이전 세션은 쓰지 않는다.
  await changeTo("fake", "fake-mini");
  const onFake = await step('Send_message with body "FAKE" once.');
  await changeTo(ctx.liveId, ctx.model);
  const back =
    ctx.remainingSceneRuns() >= 1
      ? await step('Send_message with body "BACK" once.')
      : null;
  const events = await eventsOf(ctx, org);
  checks.push(
    check(
      "provider_change_starts_without_old_session",
      onFake.resumedFrom === null,
      { source: "fake" }
    ),
    check(
      "returning_provider_does_not_resume_old_session",
      back ? back.resumedFrom === null : null,
      {
        source: live,
        reason: back ? null : "남은 예산 부족",
      }
    )
  );
  return {
    checks,
    observations: {
      recalledWord,
      plantedHasSession: !!planted.sessionAfter,
      recallResumed: recalled.resumedFrom !== null,
      modelChanged: last !== recalled,
      fakeRunResumed: onFake.resumedFrom !== null,
      backRunResumed: back ? back.resumedFrom !== null : null,
      providerChangedEvents: events.filter(
        (e) => e.type === "agent.provider_changed"
      ).length,
    },
  };
}

/** g(선택). 끼워 넣기 수락 직후, 그리고 끼워 넣는 중에 서버를 강제로 끝낸다. 메시지는 복구 뒤 실행에 전달돼야 한다. */
async function steerKillScene(ctx) {
  const org = await setupOrg(ctx, "Chaos steer kill");
  const source = fakeOr(ctx);
  const first = await startLongRun(ctx, org);
  const accepted = await say(
    ctx,
    org,
    'When the command finishes, send_message with body "AFTER" once.',
    "steer"
  );
  await killAndRestart(ctx);
  const second = await newRun(ctx, org, first.known, 120_000);
  await commandStarted(ctx).catch(unlessTimeout([]));
  // 메시지의 깨우기를 마지막으로 받은 실행. 재시작 전 실행이 아니면 복구 뒤 실행이 받은 것이다.
  const deliveredAfterRestart = async (id, known) => {
    const [wake] = await ctx.query(
      "select run_id from wakes where message_id = $1",
      [id]
    );
    return wake?.run_id && !known.includes(wake.run_id) ? wake.run_id : null;
  };
  const acceptedLater = await waitFor(
    ctx,
    "수락된 메시지가 복구 뒤 실행에 전달됨",
    () => deliveredAfterRestart(accepted.id, [first.run.id]),
    { ms: 45_000 }
  ).catch(unlessTimeout(null));
  const checks = [
    check(
      "accepted_then_killed_steer_reaches_run_after_restart",
      !!acceptedLater,
      { source }
    ),
  ];
  // 받지 못했으면 그 상태를 남긴다(깨우기가 대기 중인데 메시지가 끼워 넣는 중으로 남았는지).
  const [stuck] = await ctx.query(
    "select (w.run_id is null) as pending, m.delivery from wakes w join messages m on m.id = w.message_id where m.id = $1",
    [accepted.id]
  );
  const observations = {
    acceptedDeliveredBeforeKill: accepted.deliveredToRunId === first.run.id,
    acceptedRecovered: !!acceptedLater,
    acceptedWakePending: stuck?.pending ?? null,
    acceptedMessageDelivery: stuck?.delivery ?? null,
  };
  if (ctx.remainingSceneRuns() >= 1) {
    // 응답을 기다리지 않고 바로 끝낸다. 끼워 넣기가 어디까지 갔든 메시지는 다음 실행에 와야 한다.
    const body =
      'When the command finishes, send_message with body "AFTER2" once.';
    ctx.secrets.add(body);
    const inFlight = ctx
      .api("POST", `/api/organizations/${org.id}/messages`, {
        body,
        delivery: "steer",
      })
      .catch(() => null);
    await sleep(30, ctx.signal);
    await killAndRestart(ctx);
    await inFlight;
    const id = (await messagesOf(ctx, org)).find((m) => m.body === body)?.id;
    const later = id
      ? await waitFor(
          ctx,
          "끼워 넣던 메시지가 복구 뒤 실행에 전달됨",
          () => deliveredAfterRestart(id, [first.run.id, second.id]),
          { ms: 120_000 }
        ).catch(unlessTimeout(null))
      : null;
    checks.push(
      check("steer_in_flight_when_killed_is_not_lost", id ? !!later : null, {
        source,
        reason: id ? null : "서버가 메시지를 저장하기 전에 끝남",
      })
    );
    observations.inFlightSaved = !!id;
    observations.inFlightRecovered = !!later;
  } else
    checks.push(
      check("steer_in_flight_when_killed_is_not_lost", null, {
        source,
        reason: "남은 예산 부족",
      })
    );
  await ctx.api(
    "POST",
    `/api/organizations/${org.id}/agents/${org.leadId}/interrupt`,
    {}
  );
  await settled(ctx, org);
  return { checks, observations };
}

/**
 * 장면 목록. 실행 순서는 이 순서다: 기본 검사 → 서버 강제 종료 검사 → 선택 검사.
 * `minLiveRuns`는 시작할 때 남아 있어야 하는 실제 실행 수다. 모자라면 시작하지 않는다.
 */
export const scenes = [
  {
    id: "a",
    title: "실행 중 취소",
    minLiveRuns: 2,
    database: "ephemeral",
    run: cancelScene,
  },
  {
    id: "d",
    title: "조직 간 동시 실행 제한",
    minLiveRuns: 3,
    database: "ephemeral",
    run: concurrencyScene,
  },
  {
    id: "e",
    title: "실행 중 메시지 전달",
    minLiveRuns: 3,
    database: "ephemeral",
    run: steerScene,
  },
  {
    id: "f",
    title: "대화 세션 재개와 설정 변경",
    minLiveRuns: 3,
    database: "ephemeral",
    run: sessionScene,
  },
  {
    id: "b",
    title: "서버 강제 종료 후 복구",
    minLiveRuns: 2,
    database: "persistent",
    run: restartScene,
  },
  {
    id: "c",
    title: "재시작 전후 같은 호출 키",
    minLiveRuns: 2,
    database: "persistent",
    run: idempotencyScene,
  },
  {
    id: "g",
    title: "메시지 전달 중·수락 직후 서버 강제 종료",
    minLiveRuns: 2,
    database: "persistent",
    optional: true,
    run: steerKillScene,
  },
];

/** 장면을 만드는 공통 도구. 자동 검사가 시험용 장면을 만들 때도 쓴다. */
export const sceneTools = {
  setupOrg,
  say,
  newRun,
  settled,
  runsOf,
  startLongRun,
  killAndRestart,
};
