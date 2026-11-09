// 사람이 돌리는 실제 모델 호출 시험. CI와 자동 검사는 부르지 않는다. 구독 사용량이나 비용을 쓴다.
// 실제 서버의 조직 도구(MCP) 위에서 종료·세션 재개·끼워 넣기·취소·세션 실패·미리 압축을 한 번씩 돈다.
// 출력은 메타데이터뿐이다. 모델 원문·토큰은 찍지 않는다. `--record`면 원본을 Git 밖 `BABOJUBOT_HOME/recordings`에 남긴다.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createAntigravityProvider,
  createClaudeProvider,
  createCodexProvider,
  createOpenCodeProvider,
} from "../packages/runtime/src/index.ts";
import { openEphemeralDatabase } from "../packages/db/src/index.ts";
import { agentSessions } from "../packages/db/src/schema.ts";
import { startServer } from "../apps/server/src/index.ts";

// 저장소 루트는 drizzle에 의존하지 않으므로 db 패키지 기준으로 찾는다.
const { eq } = await import(
  createRequire(path.resolve("packages/db/package.json")).resolve("drizzle-orm")
);
const [provider, consent, ...flags] = process.argv.slice(2);
const factories = {
  claude: createClaudeProvider,
  codex: createCodexProvider,
  opencode: createOpenCodeProvider,
  antigravity: createAntigravityProvider,
};
const defaultCommand = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  antigravity: "agy",
};
if (
  !(provider in factories) ||
  consent !== "--allow-live" ||
  !process.env.BABOJUBOT_HOME
) {
  console.error(
    "Usage: BABOJUBOT_HOME=/absolute/product/home node scripts/provider-live.mjs <claude|codex|opencode|antigravity> --allow-live [--record] [--scenes=a,b]"
  );
  process.exit(2);
}
const record = flags.includes("--record");
const only = flags
  .find((flag) => flag.startsWith("--scenes="))
  ?.slice("--scenes=".length)
  .split(",");
const home = path.resolve(process.env.BABOJUBOT_HOME);
const model =
  process.env.BABOJUBOT_SMOKE_MODEL ?? (provider === "claude" ? "haiku" : null);
if (!model && provider !== "opencode") {
  console.error("Set BABOJUBOT_SMOKE_MODEL to the cheapest available model.");
  process.exit(2);
}
const mode =
  process.env.BABOJUBOT_CODEX_MODE === "exec" ? "exec" : "app-server";
const label = provider === "codex" ? `codex-${mode}` : provider;
const base = process.env.BABOJUBOT_LIVE_COMMAND ?? defaultCommand[provider];
let command = [base];
if (record) {
  const directory = path.join(home, "recordings", label, String(Date.now()));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.join(home, "recordings"), 0o700);
  command = [
    process.execPath,
    path.resolve("scripts/live/record-cli.mjs"),
    directory,
    base,
  ];
  console.error(`recording to ${directory}`);
}
const connection = factories[provider]({
  dataDir: home,
  command,
  ...(provider === "codex" ? { mode } : {}),
});
const stop = new AbortController();
const ready = await connection.adapter.checkReadiness(stop.signal);
console.log(JSON.stringify({ readiness: ready }));
if (ready.status === "not_ready") process.exit(1);

const busy = path.resolve("scripts/live/busy.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 지침은 고정한다. 지침이 바뀌면 제품은 세션을 잇지 않으므로, 장면별 요청은 메시지로 보낸다.
const brief =
  'This is a short automated connectivity test authorized by the owner. Do exactly what the owner\'s latest message asks, using the tools it names, even if an earlier turn of this test finished. If the owner has not sent a message yet, call get_run_context once, then send_message with body "OK" once in the default conversation. Do not start research or create files. End immediately afterward.';
let scene = { transform: (input) => input };
let clockShiftMs = 0;
const workspace = await mkdtemp(path.join(tmpdir(), "babojubot-live-"));
const database = await openEphemeralDatabase();
const results = [];
let server;
let passedAll;
try {
  server = await startServer({
    db: database.db,
    dataDir: workspace,
    port: 0,
    now: () => new Date(Date.now() + clockShiftMs),
    providers: [
      {
        ...connection,
        adapter: {
          ...connection.adapter,
          execute(input, control) {
            return connection.adapter.execute(
              scene.transform({
                ...input,
                instructions: [{ path: "AGENTS.md", content: brief }],
              }),
              {
                ...control,
                signal: AbortSignal.any([control.signal, stop.signal]),
              }
            );
          },
        },
      },
    ],
  });
  const api = async (method, route, body) => {
    const response = await fetch(server.url + route, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const startedAt = Date.now();
  const created = await api("POST", "/api/organizations", {
    name: "Live provider test",
    goal: "Connectivity test only.",
    completionCriteria: "A short reply.",
    lead: { provider: connection.id, model },
  });
  if (created.status >= 300) throw new Error(`organization: ${created.status}`);
  const org = created.body.id;
  const runs = async () =>
    (await api("GET", `/api/organizations/${org}/runs`)).body;
  const detail = async (id) =>
    (await api("GET", `/api/organizations/${org}/runs/${id}`)).body;
  const replies = async () =>
    (await api("GET", `/api/organizations/${org}/messages`)).body.messages
      .filter((message) => message.author === "agent")
      .map((message) => message.body);
  const activityTypes = (run) =>
    run.transcript
      .filter((event) => event.type === "run.activity")
      .map(
        (event) => event.payload.activity.activity ?? event.payload.activity
      );
  const session = async () =>
    (
      await database.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.organizationId, org))
    )[0];
  const say = (body, delivery = "next_run") =>
    api("POST", `/api/organizations/${org}/messages`, { body, delivery });
  const finished = async (id) => {
    const run = await detail(id);
    return {
      status: run.status,
      cancelReason: run.cancelReason ?? null,
      error: run.error ?? null,
      usage: run.usage ?? null,
      seconds: run.finishedAt
        ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
        : null,
    };
  };
  const newest = async () => (await runs())[0];
  /** 다음 실행 시도가 시작해 활동을 낼 때까지 기다린다. */
  const started = async (previousId, withinMs = 90000) => {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      const run = await newest();
      if (run && run.id !== previousId && run.status === "running") {
        const full = await detail(run.id);
        if (activityTypes(full).length) return run;
      }
      await sleep(500);
    }
    throw new Error("run did not start");
  };
  const wanted = (name) => !only || only.includes(name);
  const attempt = async (name, body) => {
    if (!wanted(name)) return;
    const at = Date.now();
    try {
      results.push({ scene: name, ...(await body()) });
    } catch (error) {
      results.push({ scene: name, failed: String(error.message ?? error) });
    }
    console.log(
      JSON.stringify({ ...results.at(-1), elapsed: (Date.now() - at) / 1000 })
    );
    scene = { transform: (input) => input };
  };

  await attempt("finish", async () => {
    await server.drain();
    const run = await newest();
    const full = await detail(run.id);
    return {
      // 맥락은 입력에도 있어 모델이 get_run_context를 건너뛸 수 있다. 활동으로만 남긴다.
      ok:
        run.status === "completed" &&
        (await replies()).some((reply) => reply.trim() === "OK"),
      seconds: (Date.now() - startedAt) / 1000,
      ...(await finished(run.id)),
      activities: activityTypes(full).map((a) => a.tool ?? a.type),
    };
  });

  // #125: 기다리는 서브에이전트와 45초 백그라운드 명령을 띄운 작업이 실행 하나에서 끝나고, 기다리는 동안 활동에 보인다.
  await attempt("background", async () => {
    await server.drain();
    const previous = (await newest())?.id;
    await say(
      `Do these in order. 1) If you have a tool for launching a subagent, launch one subagent in the foreground (not in the background) whose only job is to reply with the word SUB, and wait for its answer; if you have no such tool, skip this step. 2) Run the shell command \`node ${busy} 45\` in the background (the shell tool's run_in_background option) and end your turn right away without waiting for it. 3) When you are told the background command finished, send_message with body "BG DONE" once.`
    );
    const run = await started(previous);
    while ((await detail(run.id)).status === "running") await sleep(500);
    await server.drain();
    const full = await detail(run.id);
    const progress = activityTypes(full)
      .filter((a) => a.type === "progress")
      .map((a) => a.text);
    const result = await finished(run.id);
    return {
      ok:
        result.status === "completed" &&
        result.seconds >= 45 &&
        progress.includes("백그라운드 작업이 끝나기를 기다립니다.") &&
        (await replies()).some((reply) => reply.trim() === "BG DONE"),
      progress,
      runs: (await runs()).length,
      ...result,
    };
  });

  await attempt("resume", async () => {
    const word = `WORD${Date.now().toString(36).toUpperCase()}`;
    await say(
      `Remember this codeword: ${word}. Then send_message with body "NOTED" once.`
    );
    await server.drain();
    const before = await session();
    let handed;
    // 이어 받은 세션 말고는 말을 알 길이 없도록 이번 실행 시도의 맥락에서 지난 대화를 지운다.
    scene = {
      transform: (input) => {
        handed = input.previousSession;
        return {
          ...input,
          context: { ...input.context, conversation: [] },
        };
      },
    };
    await say(
      "Do not call get_run_context. Send_message with only the codeword I told you earlier in this session. If you do not know it, send UNKNOWN."
    );
    await server.drain();
    const run = await newest();
    const last = (await replies()).at(-1) ?? "";
    return {
      ok: last.includes(word) && !!handed,
      resumedSession: !!handed,
      recalled: last.includes(word),
      sameSessionId: before?.state?.id === (await session())?.state?.id,
      ...(await finished(run.id)),
    };
  });

  await attempt("usage-and-transcript", async () => {
    const row = await session();
    return {
      ok: true,
      maintenance: row?.maintenance
        ? {
            tokens: row.maintenance.tokens,
            ttlMs: row.maintenance.ttlMs,
            lastRequestAgeSeconds:
              (Date.now() - Date.parse(row.maintenance.lastRequestAt)) / 1000,
            tools: row.maintenance.tools?.length ?? 0,
          }
        : null,
      sessionKeys: Object.keys(row?.state ?? {}),
    };
  });

  if (connection.adapter.capabilities.steer)
    await attempt("steer", async () => {
      const word = `STEER${Date.now().toString(36).toUpperCase()}`;
      const previous = (await newest())?.id;
      await say(
        `First run the shell command \`node ${busy} 25\` in the foreground and wait for it to finish. Only after it finishes, send_message once. If I send another message while it runs, the body must be exactly the word that message gives; otherwise send NONE.`
      );
      const run = await started(previous);
      await sleep(4000);
      const sent = await say(`The word is ${word}.`, "steer");
      while ((await detail(run.id)).status === "running") await sleep(250);
      await server.drain();
      const last = (await replies()).at(-1) ?? "";
      return {
        ok:
          sent.status < 300 &&
          sent.body.deliveredToRunId === run.id &&
          last.includes(word),
        httpStatus: sent.status,
        deliveredToRun: sent.body.deliveredToRunId === run.id,
        delivery: sent.body.delivery ?? null,
        tookWord: last.includes(word),
        // 시험이 정한 단어만 담기는 답장이다.
        replies: await replies(),
        word,
        runs: (await runs()).filter((r) => r.id === run.id).length,
        ...(await finished(run.id)),
      };
    });

  await attempt("cancel", async () => {
    const marker = 3000 + (Date.now() % 600);
    const previous = (await newest())?.id;
    await say(
      `Run the shell command \`node ${busy} ${marker}\` in the foreground and wait for it. Do nothing else.`
    );
    const run = await started(previous);
    await sleep(6000);
    const listed = () => {
      try {
        return execFileSync("pgrep", ["-fc", `^node ${busy} ${marker}`])
          .toString()
          .trim();
      } catch {
        return "0";
      }
    };
    const runningBefore = listed();
    const at = Date.now();
    await say('Stop that. Send_message with body "STOPPED" once.', "interrupt");
    while ((await detail(run.id)).status === "running") await sleep(100);
    const settleSeconds = (Date.now() - at) / 1000;
    await server.drain();
    return {
      ok:
        (await detail(run.id)).status === "cancelled" &&
        listed() === "0" &&
        (await replies()).at(-1)?.trim() === "STOPPED",
      runningBefore,
      runningAfter: listed(),
      settleSeconds,
      afterwards: (await replies()).at(-1)?.trim() === "STOPPED",
      ...(await finished(run.id)),
    };
  });

  await attempt("unusable-session", async () => {
    const previous = (await session())?.state;
    if (typeof previous?.id !== "string") return { ok: false, noSession: true };
    // 형식은 그대로 두고 끝자리만 바꿔 "형식 오류"가 아닌 "없는 세션"을 시험한다.
    const fake = `${previous.id.slice(0, -8)}${"12345678"}`;
    scene = {
      transform: (input) => ({
        ...input,
        previousSession: { ...input.previousSession, id: fake },
      }),
    };
    await say('Send_message with body "FRESH" once.');
    await server.drain();
    const run = await newest();
    const after = (await session())?.state?.id;
    return {
      ok: run.status === "completed" && after !== fake,
      movedToNewSession: after !== fake && after !== previous.id,
      progress: activityTypes(await detail(run.id))
        .filter((a) => a.type === "progress")
        .map((a) => a.text),
      ...(await finished(run.id)),
    };
  });

  if (connection.adapter.capabilities.precompact)
    await attempt("precompact", async () => {
      // 실제 예약 경로를 쓰되 작은 세션도 대상이 되게 기록된 크기와 시계만 옮긴다.
      await say('Send_message with body "READY" once.');
      await server.drain();
      const before = await session();
      if (!before?.maintenance) return { ok: false, noMaintenanceFacts: true };
      await database.db
        .update(agentSessions)
        .set({ maintenance: { ...before.maintenance, tokens: 400000 } })
        .where(eq(agentSessions.id, before.id));
      clockShiftMs =
        Date.parse(before.maintenance.lastRequestAt) +
        before.maintenance.ttlMs * 0.9 -
        Date.now() +
        1000;
      const at = Date.now();
      await server.tickCompactions();
      clockShiftMs = 0;
      const after = await session();
      const stateRuns = await runs();
      return {
        ok: after.maintenance === null && after.state?.id === before.state?.id,
        realTokens: before.maintenance.tokens,
        sameSessionId: after.state?.id === before.state?.id,
        runCount: stateRuns.length,
        seconds: (Date.now() - at) / 1000,
      };
    });

  console.log(
    JSON.stringify({
      provider: label,
      model: model ?? "catalog-free",
      passed: results.filter((r) => r.ok).map((r) => r.scene),
      failed: results.filter((r) => !r.ok).map((r) => r.scene),
    })
  );
  passedAll = results.every((r) => r.ok);
} finally {
  stop.abort();
  await server?.close();
  await database.close();
  await rm(workspace, { recursive: true, force: true });
}
process.exit(passedAll ? 0 : 1);
