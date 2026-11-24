import { once } from "node:events";
import net from "node:net";
import { isDisconnect } from "@babojubot/contracts";
import { expect, onTestFinished, test } from "vitest";
import { openLifelines } from "./lifeline-support.ts";
import { within } from "./test-support.ts";

/** 시험이 끝나면 끊는, 연결 서버로의 연결. 연결이 실패하면 그 실패로 거절한다. */
async function connect(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  onTestFinished(() => {
    socket.destroy();
  });
  // 연결의 끝은 처음부터 기록한다(연결 직후의 닫힘도 놓치지 않는다). 기록은 거절하지 않고 끝난 까닭(오류)을 값으로 담는다. 판정은
  // 닫힘을 기다리는 쪽(`closed`)이 그때 한다. 그래서 연결이 실패하면 그 실패는 연결 대기가 알리고, 아무도 받지 않는 거절이 남지
  // 않는다(#287 리뷰 STD-2).
  const ended = new Promise<Error | undefined>((resolve) => {
    let failure: Error | undefined;
    socket.on("error", (error) => (failure = error));
    socket.once("close", () => resolve(failure));
  });
  // 서버의 답(`ok`)을 읽어 둔다. 읽지 않은 데이터가 남으면 서버가 끊어도 이쪽의 끝(`end`)과 닫힘이 오지 않는다.
  socket.resume();
  await within(
    once(socket, "connect"),
    10_000,
    "the connection to the lifeline server did not open"
  );
  return {
    socket,
    /** 연결이 닫히면 이행한다. 상대가 끊어 생긴 끊김(재설정 등)은 닫힘이고, 그 밖의 오류로 끝났으면 그 오류로 거절한다. */
    closed: async () => {
      const failure = await ended;
      if (failure !== undefined && !isDisconnect(failure)) throw failure;
    },
  };
}

// 연결한 뒤 첫 줄(자기 이름)을 보내기 전에 멈춘 프로그램의 연결도 정리 대상이다(#286 항목 33). 이름을 받은 연결만 쥐면 `close()`가
// 그 연결을 닫지 않아, 서버 닫기가 그 프로그램이 끝날 때까지 기다리고 시험이 끝난 뒤에도 서버가 남는다.
test("closing the lifelines also closes a connection that never sent its name", async () => {
  const lifelines = await openLifelines();
  // 닫기가 이 시험의 대상이다. 시험이 닫기 전에 실패해도 정리가 닫는다(한 번만 닫는다, #287 리뷰 STD-1).
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= lifelines.close());
  onTestFinished(close);
  const silent = await connect(lifelines.port);
  // 서버는 연결을 온 차례대로 받는다. 뒤에 연 연결의 이름이 닿았으면 앞의 연결도 이미 받은 것이다.
  const named = await connect(lifelines.port);
  named.socket.write("named\n");
  await lifelines.connected("named");
  await close();
  await within(
    silent.closed(),
    10_000,
    "the connection that never sent its name is still open"
  );
  await within(named.closed(), 10_000, "the named connection is still open");
  expect(lifelines.names()).toEqual(["named"]);
});

/** 아무것도 듣지 않는 127.0.0.1의 포트. 운영체제가 고른 빈 포트를 잠깐 들은 뒤 닫는다. */
async function refusingPort() {
  const server = net.createServer();
  /** 듣고 있으면 닫는다. 듣기에 실패했거나 이미 닫았으면 닫을 것이 없다. */
  const close = async () => {
    if (!server.listening) return;
    await within(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
      10_000,
      "the probe server did not close"
    );
  };
  server.listen(0, "127.0.0.1");
  // 듣기를 기다리기 전에 정리를 등록한다. 기다림이 실패해도 듣기 시작한 서버를 남기지 않는다(#287 리뷰 STD-1).
  onTestFinished(close);
  await within(
    once(server, "listening"),
    10_000,
    "the probe server did not start listening"
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the probe server has no port");
  await close();
  return address.port;
}

// 시험의 연결 도움 자체(#287 리뷰 STD-2): 연결이 거절되면 그 거절로 실패하고, 닫힘을 기다리기 전에 실패해도 처리되지 않은 거절을
// 남기지 않는다. 남기면 러너가 시험 밖의 오류로 실패를 알린다.
test("the test's connection fails with a refused connection and leaves no unhandled rejection", async () => {
  await expect(connect(await refusingPort())).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
});
