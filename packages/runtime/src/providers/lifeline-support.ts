import net from "node:net";

/**
 * 시험이 띄운 프로그램이 살아 있는지를 번호(pid)가 아니라 그 프로그램이 쥔 연결로 본다(#259).
 * 프로그램은 시작하자마자 이 서버에 연결해 자기 이름을 보내고 연결을 쥔 채 돈다. 프로그램이 끝나면 운영체제가 연결을 닫으므로,
 * 닫힘은 그 프로그램이 끝났다는 뜻이다. 번호는 끝난 뒤 다른 프로그램에 다시 쓰일 수 있어(Windows는 특히 빠르다) 나중에 다시
 * 신호 0으로 보면 "살아 있음"으로 잘못 볼 수 있지만, 연결은 그 프로그램에만 묶인다. Node.js의 연결은 자식에게 물려주지 않는다.
 */
export async function openLifelines() {
  const server = net.createServer();
  /** 이름 → 그 연결. 닫히면 `closed`가 이행한다. */
  const lines = new Map<
    string,
    { open: boolean; closed: Promise<void>; socket: net.Socket }
  >();
  const arrived = new Map<string, () => void>();
  server.on("connection", (socket) => {
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
        socket,
        closed: new Promise<void>((resolve) =>
          socket.once("close", () => {
            line.open = false;
            resolve();
          })
        ),
      };
      lines.set(name, line);
      arrived.get(name)?.();
    };
    socket.on("data", read);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the lifeline server has no port");
  const { port } = address;

  /** `promise`를 `ms` 안에 기다린다. 넘기면 무엇을 기다렸는지 밝혀 실패한다. */
  const within = async (promise: Promise<void>, ms: number, what: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${what} within ${ms} ms`)),
            ms
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const connected = (name: string) =>
    lines.has(name)
      ? Promise.resolve()
      : new Promise<void>((resolve) => arrived.set(name, resolve));

  return {
    port,
    /**
     * 프로그램 안에 넣는 JavaScript 한 문장. 이 서버에 연결해 이름을 보내고 연결을 쥔다. CommonJS(`node -e`)와 ES 모듈 모두에서 돈다.
     * 연결이 끊기면(서버가 먼저 닫힘) 프로그램이 오류로 끝나지 않게 오류를 받는다.
     */
    hold: (name: string) =>
      `process.getBuiltinModule("node:net").connect(${port}, "127.0.0.1").on("error", () => {}).write(${JSON.stringify(`${name}\n`)});`,
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
    /** 서버와 남은 연결을 닫는다. 남은 연결이 있으면 그 프로그램은 시험이 따로 끈다. */
    close: async () => {
      for (const line of lines.values()) line.socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

export type Lifelines = Awaited<ReturnType<typeof openLifelines>>;
