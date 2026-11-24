import net from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { clusterUrl } from "./client.ts";
import { askServer, testPool } from "./testing.ts";
import { within } from "@babojubot/process/test-support";

// 시험이 여는 pg 연결의 상한(#288 외부 리뷰 5회차 parent 점검). 상한이 지나면 시험은 그 상한의 이유로 실패하고 그 연결도 끝나야
// 한다. 상한이 거절만 하고 연결 시도나 질의를 그대로 두면, 시험이 잡은 연결이 실패한 뒤에도 남는다(CODING_STANDARDS 「정리」).
// 시험이 띄운 서버로 본다. 받은 것을 읽기만 하고 답하지 않는 서버(연결 단계)와, 인증 끝·준비 알림만 보내고 질의에 답하지 않는
// 서버(질의 단계)에서는 서버 쪽에서 연결의 닫힘을 본다. 아무것도 읽지 않는 서버(멈춘 서버)는 상대의 끝도 읽지 않아 서버 쪽에서는
// 닫힘을 볼 수 없으므로, 묻는 쪽의 정리가 연결의 끝을 확인했는지(실패가 상한의 이유 하나뿐인지)로 본다.

// 인증 끝(AuthenticationOk)과 질의 준비(ReadyForQuery, idle). PostgreSQL 프로토콜 메시지 형식.
const readyForQuery = Buffer.from([
  0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49,
]);

/** 연결 단계에서 멈추는 서버(받은 것을 읽기만 함)와 질의 단계에서 멈추는 서버(준비 알림까지만 보냄). */
const stuckAt = [
  { what: "its connection", answers: false },
  { what: "its question", answers: true },
];
const serveUntil = (answers: boolean) => (socket: net.Socket) => {
  if (answers) socket.once("data", () => socket.write(readyForQuery));
  else socket.resume();
};

/** 시험이 띄운 서버. 받은 연결마다 `serve`를 부르고, 그 연결의 닫힘을 모은다. 시험이 끝나면 연결을 끊고 서버를 닫는다. */
async function fakeServer(serve: (socket: net.Socket) => void) {
  const server = net.createServer();
  const sockets = new Set<net.Socket>();
  const closed: Promise<void>[] = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    closed.push(
      new Promise<void>((resolve) => socket.once("close", () => resolve()))
    );
    // 시험이 끊는 연결은 재설정으로 끝날 수 있다. 그 끝은 위 `close`로 본다.
    socket.on("error", () => socket.destroy());
    serve(socket);
  });
  // 듣기 전에 정리에 맡긴다. 듣지 못한 서버(듣기 실패)는 닫을 것이 없다(닫으면 ERR_SERVER_NOT_RUNNING으로 실패한다).
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await within(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
        10_000,
        "the fake server did not close"
      );
  });
  await within(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    }),
    10_000,
    "the fake server did not start listening"
  );
  const { port } = server.address() as net.AddressInfo;
  return { url: clusterUrl(port, "postgres"), closed };
}

/** 서버 쪽에서 그 연결 하나가 닫히는 것을 본다. */
async function closedOnServer(closed: Promise<void>[]) {
  expect(closed).toHaveLength(1);
  await within(
    closed[0]!,
    5_000,
    "the connection to the fake server was left open"
  );
}

describe("asking a server with a limit", () => {
  /** 상한 500ms로 묻고, 그 상한의 이유 하나로 실패하는지 본다(정리가 연결의 끝을 확인하지 못하면 그 실패가 함께 묶여 다르다). */
  const asksInVain = (url: string) =>
    expect(
      askServer(
        url,
        (client) => client.query("select 1"),
        500,
        "the fake server did not answer"
      )
    ).rejects.toThrow(
      new Error("the fake server did not answer within 500 ms")
    );

  it.each(stuckAt)(
    "ends the connection when the server never answers $what",
    async ({ answers }) => {
      const { url, closed } = await fakeServer(serveUntil(answers));

      await asksInVain(url);

      await closedOnServer(closed);
    }
  );

  it("ends the connection when the server reads nothing at all", async () => {
    const { url, closed } = await fakeServer(() => {});

    await asksInVain(url);

    expect(closed).toHaveLength(1);
  });
});

// 시험이 여는 pg pool도 같은 기준이다: 연결과 질의마다 상한이 있고, 상한이 지나면 그 연결이 끝난다. pool의 끝은 닫기가 확인한다.
describe("a test's pg pool", () => {
  // 연결 단계는 pg-pool의 연결 상한이 소켓을 끊어 끝나고(pg의 연결 실패 문구), 질의 단계는 pg의 질의 상한이 끝낸다.
  it.each([
    {
      ...stuckAt[0]!,
      failure: "Connection terminated due to connection timeout",
    },
    { ...stuckAt[1]!, failure: "Query read timeout" },
  ])(
    "fails a query and ends its connection when the server never answers $what",
    async ({ answers, failure }) => {
      const { url, closed } = await fakeServer(serveUntil(answers));
      const { pool, close } = testPool(url, 500);
      onTestFinished(() => close(true, "the test's pool did not end"));

      await expect(
        within(pool.query("select 1"), 5_000, "the pool's query did not settle")
      ).rejects.toThrow(new Error(failure));

      await closedOnServer(closed);
    }
  );
});
