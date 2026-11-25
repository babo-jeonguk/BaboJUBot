// 시험이 중계·프록시의 파일 소켓에 CONNECT를 보내는 vitest 시험 도움(`@babojubot/process/testing`). node:net·node:http를 쓰므로
// `test-cleanup.ts`와 따로 둔다: `vi.mock("node:net")` 대역의 factory가 불러오는 모듈(runtime `connect-failure-support.ts`)은
// `test-cleanup.ts`만 불러오고, 그 파일은 이 두 builtin을 값으로 불러오지 않는다.
import http from "node:http";
import net from "node:net";
import { isDisconnect } from "@babojubot/contracts";
import { ownClosable } from "./test-cleanup.ts";
import { within } from "./test-support.ts";

/** `ownedConnect`의 답: 답 머리, 터널(=CONNECT를 태운 연결), 머리 뒤에 함께 온 바이트, 연결을 만든 순간부터 들은 닫힘. */
type ConnectAnswer = {
  response: http.IncomingMessage;
  socket: net.Socket;
  head: Buffer;
  closed: Promise<void>;
};

/** `ownedConnect`가 CONNECT의 답 머리를 기다리는 기본 상한. */
const connectAnswerMs = 5_000;

/**
 * 파일 소켓 `socketPath`로 CONNECT `target`을 보내고 답 머리를 받는다. CONNECT를 태울 연결을 먼저 만들어 만든 같은 식에서 `own`에
 * 맡기고(`ownClosable`: `ownedClosable`과 같은 소유), 요청은 그 위에 탄다(`createConnection`). 터널은 그 연결 그 자체라(Node는
 * `connect`에 같은 소켓을 넘긴다) 답 전에 상한으로 실패해도, 터널을 얻은 뒤에도 그 한 정리가 끊고 닫힘을 확인한다. `closed`는 연결을
 * 만든 순간부터 들은 닫힘이다(거절하지 않음). 답 머리는 node:http 파서가 읽은 것이다(`connect`, 상태와 상관없이 온다). 답 전의
 * 연결·요청 오류와 상한(`answerMs`)은 거절이다. 터널을 연 뒤의 오류는 상대가 끊어 난 끊김이면 닫힘의 일부이고, 그 밖이면 러너의
 * 잡히지 않은 오류로 드러난다. `what`은 문구의 주어다(예: "CONNECT host:port to the relay").
 */
export function ownedConnect(
  own: (step: () => Promise<void>) => void,
  socketPath: string,
  target: string,
  {
    headers = {},
    answerMs = connectAnswerMs,
    what = `CONNECT ${target}`,
  }: {
    headers?: Record<string, string>;
    answerMs?: number;
    what?: string;
  } = {}
): Promise<ConnectAnswer> {
  const socket = net.connect(socketPath);
  const { closed } = ownClosable(own, socket, `${what}'s connection`);
  const request = http.request({
    method: "CONNECT",
    path: target,
    headers,
    createConnection: () => socket,
  });
  return within(
    new Promise<ConnectAnswer>((resolve, reject) => {
      request.once("error", reject);
      request.once("connect", (response, tunnel: net.Socket, head: Buffer) => {
        // CONNECT 답 뒤 Node는 요청이 붙인 소켓 처리기를 뗀다. 같은 동기 단계에서 터널의 오류를 받는다.
        tunnel.on("error", (error) => {
          if (!isDisconnect(error)) throw error;
        });
        resolve({ response, socket: tunnel, head, closed });
      });
      request.end();
    }),
    answerMs,
    `${what} was not answered`
  );
}
