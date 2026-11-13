import path from "node:path";
import { fileURLToPath } from "node:url";
import { openEphemeralDatabase } from "@babojubot/db";
import { createFakeProviders } from "@babojubot/runtime";
import { startServer } from "../src/app.ts";

// 시각을 테스트가 정하는 E2E 서버(apps/web/e2e/support/isolated-server.ts의 `clock` 서버). 제품 진입점(src/main.ts)에는
// 시계를 바꾸는 길을 두지 않고, 이 시험용 진입점만 서버의 `now`를 부모 프로세스가 IPC로 보낸 시각에 고정한다.
// 시계는 다음 시각을 받을 때까지 멈춰 있다. 기록 시각과 대시보드 기준 시각이 같은 시계에서 나와 날짜 경계가 실행 시각과 무관하다.
// 서버가 `now`로 적는 시각(실행 시도의 시작·종료 등)과 대시보드 기준 시각만 이 시계다. DB 기본값으로 적는 시각(조직 생성 시각 등)은 실제 시계다.
// 임시 embedded Postgres와 가짜 프로바이더 하나를 쓰고, 시작 줄·SIGTERM 정리는 제품 진입점과 같다.

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

/** 부모가 보낸 시각으로 옮기고 같은 id로 답한다. 답을 받은 뒤의 요청은 새 시각으로 기록·집계된다. */
process.on("message", (message: { id: number; now: string }) => {
  const next = new Date(message.now);
  if (Number.isNaN(next.getTime())) {
    process.send!({ id: message.id, error: `시각이 아니다: ${message.now}` });
    return;
  }
  clock = next;
  process.send!({ id: message.id });
});

const handle = await openEphemeralDatabase();
const server = await startServer({
  db: handle.db,
  port: Number(env.PORT ?? 0),
  host: env.HOST ?? "127.0.0.1",
  providers: createFakeProviders(1),
  now: () => new Date(clock),
  webDistDir: path.join(repoRoot, "apps/web/dist"),
});
console.log(`BaboJUBot server on ${server.url} (test clock)`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void (async () => {
    let failed = false;
    await server.close().catch((error: unknown) => {
      failed = true;
      console.error("[clock-server] close failed", error);
    });
    await handle.close().catch((error: unknown) => {
      failed = true;
      console.error("[clock-server] db close failed", error);
    });
    process.exit(failed ? 1 : 0);
  })();
}
process.on("SIGTERM", stop);
// IPC가 끊기면(부모가 사라짐) 스스로 정리한다.
process.on("disconnect", stop);
