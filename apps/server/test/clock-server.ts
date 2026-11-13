import path from "node:path";
import { fileURLToPath } from "node:url";
import { openEphemeralDatabase } from "@babojubot/db";
import { createFakeProviders } from "@babojubot/runtime";
import { startServer } from "../src/app.ts";
import { shutdownBudget } from "../src/shutdown-budget.ts";
import { onStopRequest } from "../src/stop-request.ts";

// 시각을 테스트가 정하는 E2E 서버(apps/web/e2e/support/isolated-server.ts의 `clock` 서버). 제품 진입점(src/main.ts)에는
// 시계를 바꾸는 길을 두지 않고, 이 시험용 진입점만 서버의 `now`를 부모 프로세스가 IPC로 보낸 시각에 고정한다.
// 시계는 다음 시각을 받을 때까지 멈춰 있다. 기록 시각과 대시보드 기준 시각이 같은 시계에서 나와 날짜 경계가 실행 시각과 무관하다.
// 서버가 `now`로 적는 시각(실행 시도의 시작·종료 등)과 대시보드 기준 시각만 이 시계다. DB 기본값으로 적는 시각(조직 생성 시각 등)은 실제 시계다.
// 임시 embedded Postgres와 가짜 프로바이더(BABOJUBOT_FAKE_PROVIDERS개)를 쓴다. 시작 줄과 멈춤 요청(신호·부모의 멈춤 메시지·
// 채널 끊김, src/stop-request.ts)·정리 시한(BABOJUBOT_SHUTDOWN_TIMEOUT_MS)은 제품 진입점과 같은 방식이다. 시작 중에 온 요청도
// 시작을 마친 뒤 정리한다.

const env = process.env;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const start = env.BABOJUBOT_TEST_CLOCK_START;
let clock = new Date(start ?? Number.NaN);
if (Number.isNaN(clock.getTime()))
  throw new Error(`BABOJUBOT_TEST_CLOCK_START가 시각이 아니다: ${start}`);
if (!process.send) throw new Error("IPC 채널로 띄워야 시계를 옮길 수 있다");
const deadlineMs = Number(env.BABOJUBOT_SHUTDOWN_TIMEOUT_MS ?? 30_000);
if (!Number.isInteger(deadlineMs) || deadlineMs < 1)
  throw new Error(
    `BABOJUBOT_SHUTDOWN_TIMEOUT_MS가 양의 정수가 아니다: ${deadlineMs}`
  );
const budget = shutdownBudget(deadlineMs, true);

/** 부모가 보낸 시각으로 옮기고 같은 id로 답한다. 답을 받은 뒤의 요청은 새 시각으로 기록·집계된다. 멈춤 메시지는 시각이 아니다. */
process.on("message", (message: { id?: number; now?: unknown }) => {
  if (typeof message?.id !== "number" || !("now" in message)) return;
  const next = new Date(message.now as string);
  if (Number.isNaN(next.getTime())) {
    process.send!({ id: message.id, error: `시각이 아니다: ${message.now}` });
    return;
  }
  clock = next;
  process.send!({ id: message.id });
});

// 멈춤 요청은 시작 전에 받는다. 시작 중에 온 요청으로 내장 Postgres를 남긴 채 끝나지 않는다.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  // 정리가 시한을 넘기면 끝낸다. 그때 내장 Postgres는 DB 패키지가 프로세스 종료 때 즉시 멈춘다.
  setTimeout(() => {
    console.error(`[clock-server] shutdown did not finish in ${deadlineMs}ms`);
    process.exit(1);
  }, budget.cleanupMs).unref();
  void (async () => {
    let failed = false;
    const fail = (error: unknown) => {
      failed = true;
      console.error("[clock-server] shutdown failed", error);
    };
    const started = await startup.catch(fail);
    if (started) {
      await started.server?.close().catch(fail);
      await started.handle.close().catch(fail);
    }
    process.exit(failed ? 1 : 0);
  })();
};
onStopRequest(process, stop);

const startup = (async () => {
  const handle = await openEphemeralDatabase({
    emergencyStopMs: budget.emergencyMs,
  });
  if (stopping) return { handle, server: undefined };
  try {
    const server = await startServer({
      db: handle.db,
      port: Number(env.PORT ?? 0),
      host: env.HOST ?? "127.0.0.1",
      providers: createFakeProviders(
        Math.max(1, Number(env.BABOJUBOT_FAKE_PROVIDERS ?? 1) || 1)
      ),
      now: () => new Date(clock),
      webDistDir: path.join(repoRoot, "apps/web/dist"),
    });
    return { handle, server };
  } catch (error) {
    await handle.close();
    throw error;
  }
})();
const { server } = await startup;
if (server) console.log(`BaboJUBot server on ${server.url} (test clock)`);
