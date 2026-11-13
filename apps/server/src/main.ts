import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  openEphemeralDatabase,
  type DatabaseHandle,
} from "@babojubot/db";
import {
  providerCapabilitiesSchema,
  providerIdSchema,
  providerReadinessCheckSchema,
  steerOutcomes,
  usageSchema,
  destinationSchema,
} from "@babojubot/contracts";
import {
  createConnection,
  createDockerEnvironment,
  createRelayHub,
  createFakeProviders,
  type ContainerSettings,
} from "@babojubot/runtime";
import { z } from "zod";
import { startServer } from "./app.ts";
import { shutdownBudget } from "./shutdown-budget.ts";
import { closeStarted } from "./shutdown.ts";
import { onStopRequest } from "./stop-request.ts";

// 환경 변수
// - DATABASE_URL: 외부 Postgres(운영). 없으면 embedded Postgres를 BABOJUBOT_HOME/postgres에 띄운다.
// - BABOJUBOT_EPHEMERAL_DB=1: 임시 embedded Postgres(E2E). 종료 때 지운다.
// - BABOJUBOT_FAKE_PROVIDERS: 가짜 프로바이더 연결 수(기본 1). 2 이상이면 `fake-2`(가짜 프로바이더 2)…가 더 생긴다(E2E).
// - BABOJUBOT_FAKE_PROVIDER_SETTINGS: 가짜 연결 ID별 설정 JSON(지원하는 일·준비 상태·사용량·끼워 넣기 응답·로그인 명령, E2E).
//   예: {"fake-2":{"capabilities":{"steer":false},"readiness":{"status":"not_ready","reason":"product_login_missing"}}}
// - PORT, HOST, EMBEDDED_POSTGRES_PORT, BABOJUBOT_HOME
//   HOST 기본값은 127.0.0.1이다. 인증이 없으므로 외부 주소로 열면 그 네트워크의 누구나 API와 Event stream을 쓴다.
// - EMBEDDED_POSTGRES_PORT: 내장 Postgres port(기본 54329). 0이면 켤 때 빈 port를 고른다(PORT=0과 같다).
// - BABOJUBOT_DOCKER_COMMAND·BABOJUBOT_CONTAINER_IMAGE·BABOJUBOT_MODEL_DESTINATIONS: 격리 실행의 Docker·중계 설정(아래 containerSettings).
// - BABOJUBOT_SHUTDOWN_TIMEOUT_MS: 종료 신호 뒤 프로세스가 끝나기까지의 시한(ms, 1~2147483647 정수, 기본 30000). 아니면 시작하지 않는다.
//   내장 DB면 비상 정지 몫(최대 1.5초, 시한의 절반 이하)을 남기고 정리를 끊는다(shutdown-budget.ts).
//   서버를 감싼 실행기(Docker·Kubernetes·Playwright)의 정지 시한은 이보다 길게 둔다. 실행기가 먼저 강제로 끝내면 내장 Postgres가 남고, 다음 시작이 그것을 정상 정지한다.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const env = process.env;
const productHome = path.resolve(
  env.BABOJUBOT_HOME ?? path.join(repoRoot, ".babojubot")
);
// 격리 실행(전역 설정의 스위치). Docker는 켰을 때만 쓴다.
// - BABOJUBOT_DOCKER_COMMAND: docker 프로그램(기본 docker)
// - BABOJUBOT_CONTAINER_IMAGE: 네 프로바이더가 든 공통 이미지(기본 babojubot-runner, docker/runner에서 만든다)
// - BABOJUBOT_MODEL_DESTINATIONS: 모든 연결이 더 여는 모델·로그인 목적지(JSON 배열, contracts `Destination`).
//   예: [{"host":"models.lan","port":8000,"addresses":["10.0.0.5"]}]. 연결마다 정한 필수 목적지에 더하며 초기 연구 승인 전에도 열린다.
// 실행 시도 컨테이너에는 네트워크가 없고(--network none) 실행 시도 밖의 중계가 정책대로 잇는다(#149).
const containerSettings: ContainerSettings = {
  docker: [env.BABOJUBOT_DOCKER_COMMAND || "docker"],
  image: env.BABOJUBOT_CONTAINER_IMAGE || "babojubot-runner",
  relay: createRelayHub(),
  destinations: z
    .array(destinationSchema)
    .parse(JSON.parse(env.BABOJUBOT_MODEL_DESTINATIONS || "[]")),
  // 같은 Docker를 쓰는 다른 제품 폴더의 컨테이너는 건드리지 않는다.
  owner: createHash("sha256").update(productHome).digest("hex").slice(0, 16),
};
// Real connections are opt-in. `claude:work`처럼 쓰면 같은 프로그램의 다른 계정 연결이 된다.
const enabled = (env.BABOJUBOT_PROVIDERS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const realProviders = [...new Set(enabled)].map((name) =>
  createConnection(name, {
    dataDir: productHome,
    mode: env.BABOJUBOT_CODEX_MODE === "exec" ? "exec" : "app-server",
    container: containerSettings,
  })
);

async function openConfiguredDatabase(): Promise<{
  handle: DatabaseHandle;
  label: string;
}> {
  if (env.DATABASE_URL)
    return {
      handle: await openDatabase({ url: env.DATABASE_URL }),
      label: "external Postgres",
    };
  if (env.BABOJUBOT_EPHEMERAL_DB === "1")
    return {
      handle: await openEphemeralDatabase({
        emergencyStopMs: budget.emergencyMs,
      }),
      label: "ephemeral embedded Postgres",
    };
  const dataDir = path.join(productHome, "postgres");
  const configuredPort = Number(env.EMBEDDED_POSTGRES_PORT ?? 54329);
  return {
    handle: await openDatabase({
      embedded: {
        dataDir,
        port: configuredPort === 0 ? undefined : configuredPort,
        persistent: true,
        emergencyStopMs: budget.emergencyMs,
      },
    }),
    label: `embedded Postgres ${dataDir}`,
  };
}

/** 가짜 연결 ID별 설정(runtime `FakeProviderSettings`). */
const fakeProviderSettingsSchema = z.record(
  providerIdSchema,
  z.strictObject({
    capabilities: providerCapabilitiesSchema.partial().optional(),
    readiness: providerReadinessCheckSchema.optional(),
    usage: usageSchema.optional(),
    steerOutcome: z.enum(steerOutcomes).optional(),
    loginCommand: z.string().nullable().optional(),
  })
);
const fakeProviderSettings = fakeProviderSettingsSchema.parse(
  JSON.parse(env.BABOJUBOT_FAKE_PROVIDER_SETTINGS || "{}")
);

// 종료: SIGINT(Ctrl+C)·SIGTERM·SIGHUP(터미널 닫힘)과, IPC 채널로 띄운 부모의 멈춤 메시지·채널 끊김(stop-request.ts)은
// 이 진입점만 받는다. Windows의 부모는 신호로 정리를 맡길 수 없어 메시지를 보낸다. 서버 정리를 끝낸 뒤 DB를 닫고, 성공하면 0,
// 정리나 시작에 실패하면 1로 끝난다. 닫는 순서와 실패 알림은 shutdown.ts가 맡는다. 시작하는 동안 온 요청은 시작을 마친 뒤 같은 순서로
// 정리한다(서버는 띄우지 않는다).
// 요청이 여러 번 와도 정리는 한 번이다.
// 정리가 시한 안에 끝나지 않으면 1로 끝내고, 그때 내장 Postgres는 DB 패키지가 프로세스 종료 때 멈춘다(즉시 정지).
const shutdownDeadlineMs = readShutdownDeadline(
  env.BABOJUBOT_SHUTDOWN_TIMEOUT_MS
);
const budget = shutdownBudget(shutdownDeadlineMs, !env.DATABASE_URL);
let stopping: Promise<void> | undefined;
onStopRequest(process, (reason) => {
  stopping ??= shutdown(reason);
});

const startup = start();
const { server, label } = await startup;
if (server)
  console.log(
    `BaboJUBot server on ${server.url} (${label}, product folder ${productHome})`
  );

async function start() {
  const { handle, label } = await openConfiguredDatabase();
  if (stopping) return { handle, label, server: undefined };
  try {
    const server = await startServer({
      db: handle.db,
      dataDir: productHome,
      port: Number(env.PORT ?? 3100),
      host: env.HOST ?? "127.0.0.1",
      // 컨테이너에서 이 컴퓨터의 DB 포트에 닿지 않는지도 안전 확인에서 본다.
      isolation: {
        docker: createDockerEnvironment(containerSettings),
        protectedPorts: [Number(new URL(handle.url).port) || 5432],
      },
      providers: [
        ...createFakeProviders(
          Math.max(1, Number(env.BABOJUBOT_FAKE_PROVIDERS ?? 1) || 1),
          { settings: fakeProviderSettings }
        ),
        ...realProviders,
      ],
      webDistDir: path.join(repoRoot, "apps/web/dist"),
    });
    return { handle, label, server };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function shutdown(reason: string) {
  // 시한이 지나 끝낼 때도 DB 패키지가 프로세스 종료 때 내장 Postgres에 즉시 정지를 보낸다. 그 몫까지 시한 안에 들게 먼저 끊는다.
  setTimeout(() => {
    console.error(
      `[server] shutdown after ${reason} did not finish in ${shutdownDeadlineMs / 1000}s`
    );
    process.exit(1);
  }, budget.cleanupMs).unref();
  const ok = await closeStarted(startup, (message, error) =>
    console.error(message, error)
  );
  process.exit(ok ? 0 : 1);
}

/** 정리 시한. Node 타이머는 1ms 미만이나 2147483647ms 초과를 1ms로 바꾸므로 그 범위의 정수만 받는다. */
function readShutdownDeadline(value: string | undefined): number {
  if (value === undefined || value === "") return 30_000;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647)
    throw new Error(
      `BABOJUBOT_SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, got "${value}"`
    );
  return ms;
}
