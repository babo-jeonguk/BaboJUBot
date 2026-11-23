import { once } from "node:events";
import net from "node:net";
import { isDisconnect } from "@babojubot/contracts";
import { expect, onTestFinished, test } from "vitest";
import { openLifelines } from "./lifeline-support.ts";
import { within } from "./test-support.ts";

/**
 * 시험이 끝나면 끊는, 연결 서버로의 연결. `closed`는 그 연결이 닫히면 이행한다. 서버가 끊어 생긴 끊김(재설정 등)은 닫힘이고,
 * 그 밖의 오류로 끝나면 그 오류로 거절한다.
 */
async function connect(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  onTestFinished(() => {
    socket.destroy();
  });
  const closed = new Promise<void>((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.on("error", (error) => {
      if (!isDisconnect(error)) reject(error);
    });
  });
  // 서버의 답(`ok`)을 읽어 둔다. 읽지 않은 데이터가 남으면 서버가 끊어도 이쪽의 끝(`end`)과 닫힘이 오지 않는다.
  socket.resume();
  await within(
    once(socket, "connect"),
    10_000,
    "the connection to the lifeline server did not open"
  );
  return { socket, closed };
}

// 연결한 뒤 첫 줄(자기 이름)을 보내기 전에 멈춘 프로그램의 연결도 정리 대상이다(#286 항목 33). 이름을 받은 연결만 쥐면 `close()`가
// 그 연결을 닫지 않아, 서버 닫기가 그 프로그램이 끝날 때까지 기다리고 시험이 끝난 뒤에도 서버가 남는다.
test("closing the lifelines also closes a connection that never sent its name", async () => {
  const lifelines = await openLifelines();
  const silent = await connect(lifelines.port);
  // 서버는 연결을 온 차례대로 받는다. 뒤에 연 연결의 이름이 닿았으면 앞의 연결도 이미 받은 것이다.
  const named = await connect(lifelines.port);
  named.socket.write("named\n");
  await lifelines.connected("named");
  await lifelines.close();
  await within(
    silent.closed,
    10_000,
    "the connection that never sent its name is still open"
  );
  await within(named.closed, 10_000, "the named connection is still open");
  expect(lifelines.names()).toEqual(["named"]);
});
