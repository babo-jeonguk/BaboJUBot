import net from "node:net";
import { fileURLToPath } from "node:url";
import { attemptEach, combinedFailure } from "@babojubot/contracts";
import { within } from "./test-support.ts";

/** 시험 프로그램 안에서 연결을 쥐는 실제 파일. */
const holder = fileURLToPath(
  new URL("../test-fixtures/lifeline.mjs", import.meta.url)
);

/**
 * 시험이 띄운 프로그램이 살아 있는지를 번호(pid)가 아니라 그 프로그램이 쥔 연결로 본다(#259).
 * 프로그램은 시작하자마자 이 서버에 연결해 자기 이름을 보내고 연결을 쥔 채 돈다. 프로그램이 끝나면 운영체제가 연결을 닫으므로,
 * 닫힘은 그 프로그램이 끝났다는 뜻이다. 번호는 끝난 뒤 다른 프로그램에 다시 쓰일 수 있어(Windows는 특히 빠르다) 나중에 다시
 * 신호 0으로 보면 "살아 있음"으로 잘못 볼 수 있지만, 연결은 그 프로그램에만 묶인다. Node.js의 연결은 자식에게 물려주지 않는다.
 */
export async function openLifelines() {
  const server = net.createServer();
  /** 이름 → 그 연결. 닫히면 `closed`가 이행한다. */
  const lines = new Map<string, { open: boolean; closed: Promise<void> }>();
  const arrived = new Map<string, () => void>();
  /** 받은 모든 연결. 이름(첫 줄)을 보내기 전에 멈춘 프로그램의 연결도 받은 즉시 정리 대상이다(`close`). */
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    // 끝난 프로그램의 연결은 Windows에서 재설정(ECONNRESET)으로 끝난다. 닫힘으로 다루고 오류는 그 신호로만 본다.
    socket.on("error", () => socket.destroy());
    const read = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", read);
      const name = buffer.slice(0, newline);
      const line = {
        open: true,
        closed: new Promise<void>((resolve) =>
          socket.once("close", () => {
            line.open = false;
            resolve();
          })
        ),
      };
      lines.set(name, line);
      arrived.get(name)?.();
      // 이름을 받았다고 답한다. 프로그램은 이 답 뒤에 이어 갈 수 있다(`hold`의 `then`).
      socket.write("ok\n");
    };
    socket.on("data", read);
  });
  /** 서버와 받은 연결(이름을 보내지 않은 연결 포함)을 닫고, 닫기의 실패를 거절로 상한 안에 알린다. */
  const closeAll = async () => {
    for (const socket of sockets) socket.destroy();
    await within(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
      10_000,
      "the lifeline server did not close"
    );
  };
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      }),
      10_000,
      "the lifeline server did not start listening"
    );
  } catch (error) {
    // 부른 쪽은 서버를 받지 못해 닫을 수 없다. 듣고 있는 서버(`listening`은 듣기를 마친 순간부터 참이다)는 여기서 닫고 그 끝을
    // 기다리며, 닫기의 실패는 듣기의 실패와 함께 알린다(#287 리뷰 권고). 듣지 못한 서버는 닫을 것이 없다.
    const failures = server.listening ? await attemptEach([closeAll]) : [];
    throw combinedFailure(
      [error, ...failures],
      "the lifeline server did not start"
    );
  }
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the lifeline server has no port");
  const { port } = address;

  const connected = (name: string) =>
    lines.has(name)
      ? Promise.resolve()
      : new Promise<void>((resolve) => arrived.set(name, resolve));

  return {
    port,
    /**
     * 연결을 쥐는 실제 파일(`test-fixtures/lifeline.mjs`)의 경로. 파일로 된 시험 프로그램(가짜 CLI)은 이 파일을 불러 그 `hold(port,
     * name, then)`을 직접 부른다. 같은 프로그램이 여럿 뜨면 이름에 자기 번호를 붙여 서로 구별한다.
     */
    module: holder,
    /**
     * 프로그램 안에 넣는 JavaScript 문장. 연결을 쥐는 일은 실제 파일(`test-fixtures/lifeline.mjs`)이 맡고, 이 문장은 그 파일을
     * 불러 부르기만 한다: 이 서버에 연결해 이름을 보내고 연결을 쥐며, 서버가 이름을 받았다고 답하면 `then`을 실행한다(그 뒤로는
     * 이 프로그램이 끝나면 닫힘이 반드시 보인다). 동기 `require`로 부르므로 CommonJS(`node -e`)와 ES 모듈 모두에서 돈다.
     */
    hold: (name: string, then = "") =>
      `{ process.getBuiltinModule("node:module").createRequire(${JSON.stringify(holder)})(${JSON.stringify(holder)}).hold(${port}, ${JSON.stringify(name)}, () => { ${then} }); }`,
    /** `name`의 연결이 왔을 때까지 기다린다. */
    connected: (name: string, ms = 10_000) =>
      within(connected(name), ms, `${name} did not connect`),
    /** `name`의 프로그램이 끝나 연결이 닫힐 때까지 기다린다. 연결이 온 적이 없으면 그것부터 기다린다. */
    closed: async (name: string, ms = 10_000) =>
      within(
        connected(name).then(() => lines.get(name)!.closed),
        ms,
        `${name} is still running`
      ),
    /** 지금 그 연결이 열려 있는가(그 프로그램이 아직 돈다). 연결이 온 적이 없으면 던진다. */
    open: (name: string) => {
      const line = lines.get(name);
      if (!line) throw new Error(`${name} never connected`);
      return line.open;
    },
    /** 연결이 온 모든 이름. */
    names: () => [...lines.keys()],
    /** 서버와 남은 연결(이름을 보내지 않은 연결 포함)을 닫는다. 남은 연결이 있으면 그 프로그램은 시험이 따로 끈다. */
    close: closeAll,
  };
}

export type Lifelines = Awaited<ReturnType<typeof openLifelines>>;
