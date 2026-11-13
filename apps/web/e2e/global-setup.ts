import { fileURLToPath } from "node:url";
import {
  startServerProcess,
  type ServerProcess,
} from "./support/server-process.ts";

// 공용 E2E API 서버. 모든 spec이 이 서버와 DB 하나를 같이 쓴다(화면 preview가 /api를 이 서버로 넘긴다).
// 서버의 수명은 Playwright의 webServer가 아니라 이 globalSetup이 직접 가진다. webServer는 Windows에서 서버를 taskkill /F로
// 끝내 정리할 기회를 주지 않는다. globalSetup이 돌려준 정리 함수는 webServer(화면 preview)를 끄기 전에 불리므로, 서버에
// 멈춤 요청을 보내고 정리를 마칠 때까지 기다린다(server-process.ts). 정리에 실패하면 실행 전체가 실패한다.
// 테스트가 실패해도 정리는 같다. 정리 함수를 돌려주기 전(setup 중)에 실패하면 Playwright가 정리 함수를 모르므로 여기서 정리한다.

const main = fileURLToPath(
  new URL("../../server/src/main.ts", import.meta.url)
);
/** 화면 preview가 API를 넘기는 port(playwright.config.ts). */
export const sharedApiPort = 3199;

/**
 * 공용 서버를 띄우고 정리 함수를 돌려준다. `afterStart`는 서버가 뜬 뒤 정리 함수를 돌려주기 전에 하는 일이며, 실패하면
 * 서버를 정리하고 그 실패를 그대로 던진다. 수명 시험(e2e/support/shared-server.spec.ts)이 다른 port와 함께 쓴다.
 */
export async function startSharedServer({
  port = sharedApiPort,
  afterStart,
}: {
  port?: number;
  afterStart?: (server: ServerProcess) => void | Promise<void>;
} = {}) {
  const server = await startServerProcess({
    entry: main,
    label: "공용 E2E 서버",
    env: {
      PORT: String(port),
      // 같은 가짜 adapter의 연결 둘로 프로바이더·모델 고르기를 검사한다(providers.spec.ts).
      BABOJUBOT_FAKE_PROVIDERS: "2",
      // `fake-2`는 끼워 넣기를 못 하고 제품 로그인이 없어 준비안됨이다(provider-contract.spec.ts).
      BABOJUBOT_FAKE_PROVIDER_SETTINGS: JSON.stringify({
        "fake-2": {
          capabilities: { steer: false },
          readiness: { status: "not_ready", reason: "product_login_missing" },
        },
      }),
    },
  });
  try {
    await afterStart?.(server);
  } catch (error) {
    await server.stop().catch((stopError: unknown) => {
      console.error("[e2e] 공용 E2E 서버 정리에도 실패했다", stopError);
    });
    throw error;
  }
  return () => server.stop();
}

export default function globalSetup() {
  return startSharedServer();
}
