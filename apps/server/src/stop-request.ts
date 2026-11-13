// 서버를 멈추라는 요청. 터미널·서비스 관리자의 신호(SIGINT·SIGTERM·SIGHUP)와, 서버를 IPC 채널로 띄운 부모의 멈춤 메시지다.
// Windows에서는 부모가 자식에게 신호로 정리를 맡길 수 없다(Node의 `kill("SIGTERM")`은 강제 종료). 그래서 서버를 직접 띄운
// 부모(E2E 실행기 등)는 `stopRequest` 메시지를 보내고 서버가 끝나며 내는 종료 코드를 기다린다. 모든 OS에서 같은 길이다.
// 그 밖의 메시지는 요청이 아니다. 부모와의 채널이 끊기면(부모가 사라짐) 서버를 챙길 쪽이 없으므로 같은 정리를 시작한다.
// IPC 채널 없이 띄운 서버는 신호만 받는다. `node --watch`(서버 `dev`)도 IPC 채널로 띄우지만 멈춤 메시지를 보내지 않고,
// 채널은 감시자가 서버를 다시 띄우려고 끝낼 때만 끊긴다. 사용자 API에는 서버를 멈추는 길을 두지 않는다.

/** 부모가 보내는 멈춤 메시지. 서버 밖의 부모(apps/web/e2e/support/server-process.ts)도 같은 모양을 보낸다. */
export const stopRequest = { type: "babojubot:stop" } as const;

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** 신호와 IPC 이벤트를 받을 수 있는 프로세스. `send`가 있으면 부모와 이어진 IPC 채널이 있다. */
type StopSource = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send?: unknown;
};

/**
 * 멈추라는 요청마다 `stop`을 부른다. 이유는 신호 이름, `"stop request"`, `"parent disconnected"` 중 하나다.
 * 같은 요청이 여러 번 올 수 있으므로 정리를 한 번만 하는 것은 받는 쪽이 맡는다.
 */
export function onStopRequest(
  proc: StopSource,
  stop: (reason: string) => void
) {
  for (const signal of signals) proc.on(signal, () => stop(signal));
  if (!proc.send) return;
  proc.on("message", (message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === stopRequest.type
    )
      stop("stop request");
  });
  proc.on("disconnect", () => stop("parent disconnected"));
}
