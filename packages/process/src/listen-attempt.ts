import type net from "node:net";

/**
 * 서버 하나의 듣기 시도. 듣기 시도의 처리기(`listening`·`error`)를 단 뒤 `listen`을 부르고, 그 시도가 끝나면(듣기 시작이면 이행, 듣기
 * 오류나 `listen`의 동기 예외면 그 오류로 거절) 끝나는 promise를 돌려준다. 끝나면 남은 쪽 처리기를 뗀다.
 * 서버의 `close`는 이 시도가 끝난 뒤에만 부른다. 주소 조회를 거치는 듣기(`listen(0, "127.0.0.1")`)에 그 전에 `close`를 부르면 Node는
 * 그 듣기를 취소해 `listening`도 `error`도 내지 않고, 닫기는 `ERR_SERVER_NOT_RUNNING`으로 끝난다(듣기 시도가 끝나지 않는다).
 * `node:net`을 값으로 불러오지 않는다(시험 대역이 `node:net`을 바꾸는 경로에서도 쓴다).
 */
export function listenAttempt(
  server: net.Server,
  listen: () => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      listen();
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error as Error);
    }
  });
}
