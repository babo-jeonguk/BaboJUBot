import { eventStreamPath, streamFrameSchema } from "@babojubot/contracts";
import { test, type Page, type WebSocket } from "@playwright/test";

/** 화면(`live-events.ts`)과 같은 frame 계약으로 구독 성립(`ready`)을 판정한다. */
export function isReadyFrame(payload: string | Buffer) {
  try {
    const frame = streamFrameSchema.safeParse(JSON.parse(String(payload)));
    return frame.success && frame.data.type === "ready";
  } catch {
    return false;
  }
}

/**
 * 화면을 열고 그 화면의 전체 조직 Event stream 구독이 성립할 때까지 기다린다. 그 뒤의 변화는 새로고침 없이 Event로 화면에 닿는다.
 * ready frame이 `timeout` 안에 오지 않거나 그 전에 page·Event stream이 닫히거나 오류가 나면 무엇을 기다렸는지 밝히며 실패한다.
 * 어느 경우든 등록한 listener를 해제하므로 같은 page에서 여러 번 불러도 쌓이지 않는다.
 *
 * 네트워크의 frame을 보므로 `routeWebSocket`으로 가로챈 page에는 쓰지 않는다. 그때 보이는 socket은 route와 서버 사이의
 * 연결이라, route가 화면에 무엇을 넘겼는지와 다르다.
 */
export async function openWithLiveEvents(
  page: Page,
  path: string,
  { timeout = 10_000 } = {}
) {
  await test.step(
    `${path} 화면을 열고 Event stream 구독 성립을 기다린다`,
    async () => {
      // 화면이 socket을 열기 전에 listener를 등록해야 ready frame을 놓치지 않는다.
      const ready = eventStreamReady(page, path, timeout);
      try {
        await Promise.all([ready.done, page.goto(path)]);
      } finally {
        ready.dispose();
      }
    },
    { box: true }
  );
}

function eventStreamReady(page: Page, path: string, timeout: number) {
  const sockets = new Set<WebSocket>();
  let dispose = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const fail = (reason: string) =>
      settle(
        new Error(`${path} 화면의 Event stream(${eventStreamPath}): ${reason}`)
      );
    const onFrame = ({ payload }: { payload: string | Buffer }) => {
      if (isReadyFrame(payload)) settle();
    };
    const onSocketError = (error: string) =>
      fail(`ready frame을 받기 전에 오류가 났다(${error})`);
    const onSocketClose = () => fail("ready frame을 받기 전에 닫혔다");
    const onPageClose = () => fail("ready frame을 받기 전에 page가 닫혔다");
    const onSocket = (ws: WebSocket) => {
      if (new URL(ws.url()).pathname !== eventStreamPath) return;
      sockets.add(ws);
      ws.on("framereceived", onFrame);
      ws.on("socketerror", onSocketError);
      ws.on("close", onSocketClose);
    };
    const timer = setTimeout(
      () =>
        fail(
          `화면을 열기 시작한 뒤 ${timeout}ms 안에 ready frame을 받지 못했다`
        ),
      timeout
    );
    dispose = () => {
      clearTimeout(timer);
      page.off("websocket", onSocket);
      page.off("close", onPageClose);
      for (const ws of sockets) {
        ws.off("framereceived", onFrame);
        ws.off("socketerror", onSocketError);
        ws.off("close", onSocketClose);
      }
      sockets.clear();
    };
    function settle(error?: Error) {
      dispose();
      if (error) reject(error);
      else resolve();
    }
    page.on("websocket", onSocket);
    page.on("close", onPageClose);
  });
  return { done, dispose: () => dispose() };
}
