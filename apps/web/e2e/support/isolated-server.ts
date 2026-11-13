import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { startServerProcess } from "./server-process.ts";

// 공용 E2E 서버(e2e/global-setup.ts)는 모든 spec과 반복 실행이 DB 하나를 같이 써서 비어 있다고 가정할 수 없다.
// 빈 상태나 전체 개수처럼 서버 전체를 보는 검사는 이 fixture가 테스트마다 띄우는 자기 서버에서 한다.
// 서버는 임시 embedded Postgres와 임시 제품 폴더를 쓰고, 빈 port를 골라 빌드된 화면(apps/web/dist)과 API를 한 origin으로 낸다.
// 화면 빌드는 공용 설정의 webServer(`vite build`)가 테스트 전에 끝낸다.
// 띄우기·멈추기와 정리 확인은 공용 서버와 같다(server-process.ts). 멈추라고 하기 전에 끝난 서버는 종료 코드가 0이어도 실패다.

const main = fileURLToPath(
  new URL("../../../server/src/main.ts", import.meta.url)
);
// 시각을 테스트가 정하는 서버의 시험용 진입점. 제품 진입점과 같은 서버를 띄우되 `now`만 IPC로 받은 시각에 고정한다.
const clockMain = fileURLToPath(
  new URL("../../../server/test/clock-server.ts", import.meta.url)
);

type IsolatedServer = {
  url: string;
  /**
   * 서버 시계를 이 시각으로 옮긴다. 기록 시각과 대시보드 기준 시각 모두 이 시계다. 서버가 받았다고 답한 뒤 돌아온다.
   * `clock`을 주고 띄운 서버만 할 수 있다.
   */
  setNow: (iso: string) => Promise<void>;
  /** 서버 프로세스 ID. fixture 시험(isolated-server.spec.ts)이 서버가 끝났는지 볼 때 쓴다. */
  pid: number;
  /** 서버가 띄운 임시 내장 Postgres의 프로세스 ID(fixture 시험용). */
  postgresPid: number;
  /** 서버의 제품 폴더·임시 폴더를 담은 폴더. 멈춘 뒤에는 없다(fixture 시험용). */
  folder: string;
  /** 서버 프로세스. fixture 시험이 fixture 밖에서 멈춤 요청을 보내 테스트 도중 서버가 끝나는 경우를 만들 때 쓴다. */
  child: ChildProcess;
  stop: () => Promise<void>;
};

/**
 * `clock`(ISO 시각)을 주면 서버 시계가 그 시각에 멈춘 채 시작하고 `setNow`로만 움직인다. 없으면 제품 진입점을 실제 시계로 띄운다.
 */
export async function startIsolatedServer({
  clock,
}: { clock?: string } = {}): Promise<IsolatedServer> {
  const server = await startServerProcess({
    entry: clock ? clockMain : main,
    label: "격리 E2E 서버",
    env: {
      // 조직 생성만 보므로 기본 가짜 프로바이더 하나면 된다. 공용 서버의 프로바이더 고르기용 설정은 넘기지 않는다.
      BABOJUBOT_FAKE_PROVIDERS: "1",
      ...(clock && { BABOJUBOT_TEST_CLOCK_START: clock }),
    },
  });
  return { ...server, setNow: clockSetter(server.child, !!clock) };
}

/** 시계 서버에 시각을 보내고 받았다는 답을 기다린다. 답에 오류가 있으면 던진다. */
function clockSetter(child: ChildProcess, enabled: boolean) {
  let nextId = 0;
  return (iso: string) => {
    if (!enabled)
      return Promise.reject(
        new Error("시계를 옮기려면 `clock`을 주고 서버를 띄워야 한다")
      );
    const id = ++nextId;
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (reply: { id: number; error?: string }) => {
        if (reply.id === id)
          done(reply.error ? new Error(reply.error) : undefined);
      };
      const onExit = () =>
        done(new Error(`시계를 ${iso}로 옮기기 전에 서버가 끝났다`));
      child.on("message", onMessage);
      child.on("exit", onExit);
      child.send({ id, now: iso }, (error) => error && done(error));
    });
  };
}

/** 테스트마다 빈 DB의 자기 서버를 띄우고 `baseURL`을 그 서버로 바꾼다. 테스트가 끝나면 서버를 멈추고 그 폴더를 지운다. */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const server = await startIsolatedServer();
    try {
      await use(server.url);
    } finally {
      await server.stop();
    }
  },
});

/**
 * 시각이 `clock`에 멈춘 자기 서버에서 도는 테스트. `baseURL`은 그 서버이고, `server.setNow`로 서버 시계를 옮긴다.
 * 날짜 경계를 보는 검사가 실행하는 날의 벽시계에 기대지 않게 한다.
 */
export const withServerClock = (clock: string) =>
  base.extend<{ server: IsolatedServer }>({
    // eslint-disable-next-line no-empty-pattern
    server: async ({}, use) => {
      const server = await startIsolatedServer({ clock });
      try {
        await use(server);
      } finally {
        await server.stop();
      }
    },
    baseURL: async ({ server }, use) => use(server.url),
  });
