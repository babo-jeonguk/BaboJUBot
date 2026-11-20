import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { destinationSchema, type Destination } from "@babojubot/contracts";
import { createRelayHub, type RelayHooks } from "./relay.ts";

// 격리 실행의 중계(#149). 컨테이너에는 네트워크가 없고, 실행 시도마다 연 파일 소켓으로만 바깥과 조직 도구에 닿는다.
// 여기서는 컨테이너 쪽 대신 시험이 그 소켓에 직접 붙는다. 금지 목적지는 실제 listener가 연결을 받지 않았는지까지 본다.

const destination = (value: unknown): Destination =>
  destinationSchema.parse(value);

/** 연결 수를 세는 loopback listener. echo하거나 HTTP로 답한다. */
async function fixture(kind: "echo" | "http") {
  const accepted: net.Socket[] = [];
  const server =
    kind === "http"
      ? http.createServer((req, res) =>
          res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
        )
      : net.createServer((socket) => socket.pipe(socket));
  server.on("connection", (socket: net.Socket) => accepted.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // 러너가 시험이 끝나면 등록 역순으로 모두 정리한다. 중계 닫기가 실패해도 이 listener를 닫는다.
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of accepted) socket.destroy();
        server.close(() => resolve());
      })
  );
  return { port: (server.address() as net.AddressInfo).port, accepted };
}

function hub(overrides: Partial<RelayHooks> = {}) {
  const refused: { host: string; port: number; reason: string }[] = [];
  let research: Destination[] = [];
  const relays = createRelayHub();
  relays.attach({
    research: async () => research,
    tools: (req, res) =>
      res.end(
        JSON.stringify({
          url: req.url,
          run: req.headers["x-babojubot-relay-run"],
          organization: req.headers["x-babojubot-relay-organization"],
        })
      ),
    protectedPorts: () => [],
    refused: (_identity, detail) => refused.push(detail),
    ...overrides,
  });
  onTestFinished(() => relays.close());
  return {
    relays,
    refused,
    setResearch: (value: Destination[]) => {
      research = value;
    },
  };
}

const identity = {
  organizationId: "00000000-0000-4000-8000-00000000000a",
  agentId: "00000000-0000-4000-8000-00000000000b",
  runId: "00000000-0000-4000-8000-00000000000c",
};

/** 컨테이너 쪽처럼 egress.sock에 CONNECT를 보내고 응답 머리를 받는다. */
function connectVia(directory: string, target: string) {
  return new Promise<{ head: string; socket: net.Socket }>(
    (resolve, reject) => {
      const socket = net.connect(path.join(directory, "egress.sock"));
      let buffer = "";
      socket.once("error", reject);
      socket.on("connect", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      );
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        resolve({
          head: buffer.slice(0, end + 4) + buffer.slice(end + 4),
          socket,
        });
      };
      socket.on("data", onData);
    }
  );
}

const roundTrip = (socket: net.Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString()));
    socket.write(text);
  });

const closed = (socket: net.Socket) =>
  new Promise<void>((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once("close", () => resolve());
  });
/** 정해진 시간 안에 닫혔는지. 닫히지 않는 결함이 시험 시간 초과로 번지지 않게 한다. */
const closedWithin = (socket: net.Socket, ms = 2000) =>
  Promise.race([
    closed(socket).then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("open"), ms)),
  ]);

// Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행).
describe.skipIf(process.platform === "win32")("isolated run relay", () => {
  it("tunnels an allowed destination and refuses others before any connection reaches them", async () => {
    const target = await fixture("echo");
    const { relays, refused } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const ok = await connectVia(relay.directory, `localhost:${target.port}`);
    expect(ok.head).toMatch(/^HTTP\/1\.1 200/);
    expect(await roundTrip(ok.socket, "ping")).toBe("ping");
    ok.socket.destroy();

    const before = target.accepted.length;
    const denied = await connectVia(
      relay.directory,
      `127.0.0.1:${target.port}`
    );
    expect(denied.head).toMatch(/^HTTP\/1\.1 403/);
    expect(denied.head).toMatch(
      /x-babojubot-refusal: destination_not_allowed/i
    );
    const otherPort = await connectVia(
      relay.directory,
      `localhost:${target.port + 1}`
    );
    expect(otherPort.head).toMatch(/destination_not_allowed/);
    expect(target.accepted.length).toBe(before);
    expect(refused).toEqual([
      {
        host: "127.0.0.1",
        port: target.port,
        reason: "destination_not_allowed",
      },
      {
        host: "localhost",
        port: target.port + 1,
        reason: "destination_not_allowed",
      },
    ]);
  });

  it("refuses an allowed name that resolves to this computer unless that address is listed", async () => {
    const target = await fixture("echo");
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [destination({ host: "localhost", port: target.port })],
    });
    await relay.ready;
    const denied = await connectVia(
      relay.directory,
      `localhost:${target.port}`
    );
    expect(denied.head).toMatch(/address_not_allowed/);
    expect(target.accepted.length).toBe(0);
  });

  it("never opens the user API or DB port, even when the user listed this computer", async () => {
    const target = await fixture("echo");
    const { relays } = hub({ protectedPorts: () => [target.port] });
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const denied = await connectVia(
      relay.directory,
      `localhost:${target.port}`
    );
    expect(denied.head).toMatch(/address_not_allowed/);
    expect(target.accepted.length).toBe(0);
  });

  it("forwards a plain HTTP proxy request to the checked address and keeps its Host", async () => {
    const target = await fixture("http");
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${target.port}/page?x=1`,
        headers: { host: `localhost:${target.port}` },
      });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({
      url: "/page?x=1",
      host: `localhost:${target.port}`,
    });
  });

  it("passes a redirect back without following it, so the next request is checked again", async () => {
    const forbidden = await fixture("http");
    const accepted: string[] = [];
    const redirecting = http.createServer((req, res) => {
      accepted.push(req.url ?? "");
      res.writeHead(302, {
        location: `http://127.0.0.1:${forbidden.port}/inside`,
      });
      res.end();
    });
    await new Promise<void>((resolve) =>
      redirecting.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) =>
          redirecting.close((error) => (error ? reject(error) : resolve()))
        )
    );
    const port = (redirecting.address() as net.AddressInfo).port;
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const viaProxy = (target: string) =>
      new Promise<{ status: number; location?: string }>((resolve, reject) => {
        const req = http.request({
          socketPath: path.join(relay.directory, "egress.sock"),
          path: target,
        });
        req.on("response", (res) => {
          res.resume();
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
          });
        });
        req.on("error", reject);
        req.end();
      });
    const first = await viaProxy(`http://localhost:${port}/start`);
    expect(first).toEqual({
      status: 302,
      location: `http://127.0.0.1:${forbidden.port}/inside`,
    });
    // 클라이언트가 따라가도 새 요청은 다시 판정을 받는다.
    expect((await viaProxy(first.location!)).status).toBe(403);
    expect(accepted).toEqual(["/start"]);
    expect(forbidden.accepted).toHaveLength(0);
  });

  it("uses the organization's research list only as the policy hook gives it, and closes tunnels the user removes", async () => {
    const target = await fixture("echo");
    const { relays, refused, setResearch } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const entry = destination({
      host: "localhost",
      port: target.port,
      addresses: ["127.0.0.1", "::1"],
    });
    expect(
      (await connectVia(relay.directory, `localhost:${target.port}`)).head
    ).toMatch(/403/);
    setResearch([entry]);
    const open = await connectVia(relay.directory, `localhost:${target.port}`);
    expect(open.head).toMatch(/^HTTP\/1\.1 200/);
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    await closed(open.socket);
    expect(refused.at(-1)).toEqual({
      host: "localhost",
      port: target.port,
      reason: "policy_changed",
    });
  });

  it("closes a tunnel when the user removes only the internal address it needed, keeping the name and port", async () => {
    const target = await fixture("echo");
    const { relays, refused, setResearch } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    setResearch([
      destination({
        host: "localhost",
        port: target.port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const open = await connectVia(relay.directory, `localhost:${target.port}`);
    expect(open.head).toMatch(/^HTTP\/1\.1 200/);
    // 이름·포트는 그대로 두고 내부 주소 예외만 지운다. 새 연결은 거부되므로 열린 연결도 닫혀야 한다.
    setResearch([destination({ host: "localhost", port: target.port })]);
    await relays.revalidate(identity.organizationId);
    expect(await closedWithin(open.socket)).toBe("closed");
    expect(refused.at(-1)).toEqual({
      host: "localhost",
      port: target.port,
      reason: "policy_changed",
    });
    expect(
      (await connectVia(relay.directory, `localhost:${target.port}`)).head
    ).toMatch(/address_not_allowed/);
  });

  it("closes a connection admitted under the old policy when the user narrowed it while that connection was opening", async () => {
    const target = await fixture("echo");
    const entry = destination({
      host: "localhost",
      port: target.port,
      addresses: ["127.0.0.1", "::1"],
    });
    let current: Destination[] = [entry];
    let narrowing = true;
    const env = hub({
      // 첫 판정이 옛 목록을 읽은 직후 사용자가 목록을 비우고, 그 재검사가 끝난 뒤에야 연결이 열린다.
      research: async () => {
        const seen = current;
        if (narrowing) {
          narrowing = false;
          current = [];
          await env.relays.revalidate(identity.organizationId);
        }
        return seen;
      },
    });
    const relay = env.relays.open({ identity, required: [] });
    await relay.ready;
    const socket = net.connect(path.join(relay.directory, "egress.sock"));
    onTestFinished(() => void socket.destroy());
    socket.on("error", () => {});
    // 응답을 읽어야 끝(FIN)을 받고 닫힌다.
    let answer = "";
    socket.on("data", (chunk: Buffer) => (answer += chunk.toString("latin1")));
    socket.write(
      `CONNECT localhost:${target.port} HTTP/1.1\r\nHost: localhost:${target.port}\r\n\r\n`
    );
    expect(await closedWithin(socket)).toBe("closed");
    expect(answer).not.toMatch(/^HTTP\/1\.1 200/);
    expect(env.refused.at(-1)).toEqual({
      host: "localhost",
      port: target.port,
      reason: "policy_changed",
    });
  });

  it("answers 502 and keeps serving when a plain HTTP destination resets while the changed policy is rechecked", async () => {
    const target = await fixture("http");
    const entry = destination({
      host: "localhost",
      port: target.port,
      addresses: ["127.0.0.1", "::1"],
    });
    let calls = 0;
    // 중계가 목적지와 연 소켓을 잡아, 목적지가 끊은 것을 중계가 받았는지 본다.
    const connect = vi.spyOn(net, "connect");
    onTestFinished(() => void connect.mockRestore());
    const relayToTarget = () =>
      connect.mock.results
        .map((result) => result.value as net.Socket)
        .find((socket) => socket.remotePort === target.port);
    const env = hub({
      research: async () => {
        calls += 1;
        // 첫 판정 중에 정책이 바뀐 것처럼 재검사를 돌려, 연결 뒤 한 번 더 보게 한다.
        if (calls === 1) await env.relays.revalidate(identity.organizationId);
        // 연결 뒤 재검사(세 번째)를 기다리는 동안 목적지가 연결을 RST로 끊고, 중계의 소켓이 그 끊김으로 닫힌 뒤에 답한다.
        if (calls === 3) {
          await vi.waitUntil(
            () => target.accepted.length > 0 && relayToTarget(),
            {
              timeout: 5_000,
              interval: 5,
            }
          );
          const socket = relayToTarget()!;
          // RST는 오류(ECONNRESET) 뒤 close로 온다. once(…, "close")는 그 오류로 거절되므로 close만 듣는다.
          const closed = new Promise((resolve) =>
            socket.once("close", resolve)
          );
          target.accepted.at(-1)!.resetAndDestroy();
          await closed;
        }
        return [entry];
      },
    });
    // 처리되지 않은 소켓 오류는 서버 프로세스를 끝낸다. 시험에서는 여기에 잡힌다.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    onTestFinished(() => void process.off("uncaughtException", onUncaught));
    const relay = env.relays.open({ identity, required: [] });
    await relay.ready;
    const viaProxy = () =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({
          socketPath: path.join(relay.directory, "egress.sock"),
          path: `http://localhost:${target.port}/page`,
          agent: false,
        });
        // 응답이 오지 않으면 0으로 끝낸다(시험 시간 초과 대신).
        req.setTimeout(3000, () => {
          req.destroy();
          resolve(0);
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await viaProxy()).toBe(502);
    expect(uncaught).toEqual([]);
    // 같은 중계가 다음 요청을 그대로 처리한다.
    expect(await viaProxy()).toBe(200);
  });

  it("answers 502 and leaves why when it cannot connect to an allowed destination", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    // 받는 곳이 없는 포트: 잠깐 열어 번호를 받고 닫는다.
    const listener = net.createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve)
    );
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve()))
    );
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        // 이 컴퓨터에 따라 localhost는 두 주소로 풀린다. 둘 다 적어야 연결 시도까지 간다.
        destination({
          host: "localhost",
          port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const answer = await connectVia(relay.directory, `localhost:${port}`);
    answer.socket.destroy();
    expect(answer.head).toMatch(/^HTTP\/1\.1 502/);
    // 마지막으로 시도한 주소의 실패 코드는 이 컴퓨터의 IPv6 설정에 따라 다르다(ECONNREFUSED·EADDRNOTAVAIL 등).
    expect(warned).toHaveBeenCalledWith(
      expect.stringMatching(/answered 502 \(E[A-Z]+\)$/)
    );
  });

  it("refuses when the policy cannot be read", async () => {
    const target = await fixture("echo");
    const { relays } = hub({
      research: async () => {
        throw new Error("db down");
      },
    });
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    expect(
      (await connectVia(relay.directory, `localhost:${target.port}`)).head
    ).toMatch(/policy_unavailable/);
    expect(target.accepted.length).toBe(0);
  });

  it("refuses requests that are not an HTTP proxy request", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: "/relative",
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  /** 이 시험 동안 서버 닫기가 EBUSY로 실패하게 한다. 듣지 않던 서버의 원래 오류(ERR_SERVER_NOT_RUNNING)는 그대로 둔다. */
  const failServerCloses = () => {
    const close = net.Server.prototype.close;
    const failing = vi
      .spyOn(net.Server.prototype, "close")
      .mockImplementation(function (
        this: net.Server,
        callback?: (error?: Error) => void
      ) {
        return close.call(this, (error?: Error) =>
          callback?.(
            error ?? Object.assign(new Error("close failed"), { code: "EBUSY" })
          )
        );
      });
    onTestFinished(() => failing.mockRestore());
  };

  // 닫기 콜백의 실패는 거절로 드러낸다(CODING_STANDARDS.md#제품-코드). 남기기만 하고 "닫힘"으로 끝내지 않으며, 폴더 지우기는 그래도 한다
  // (#264 외부 리뷰 4회차, 실패를 기록하고 성공 쪽으로 진행하는 모양).
  it("fails its close with the cause when a relay server does not close, after still removing its folder", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    failServerCloses();
    await expect(relay.close()).rejects.toThrow(
      "a relay server did not close (EBUSY)"
    );
    expect(existsSync(relay.directory)).toBe(false);
  });

  // 닫기가 거절할 수 있게 된 뒤 그 호출자를 함께 점검했다(#264 외부 리뷰 5회차 STD-4). 열지 못해 스스로 닫는 중계는 닫기 실패를
  // 처리되지 않은 거절로 버리지 않고, 나중에 닫는 쪽(실행 시도·격리 확인의 정리)이 같은 실패를 받는다.
  it("closes itself after it could not open without dropping a close failure, and gives that failure to whoever closes it", async () => {
    const { relays } = hub();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    onTestFinished(() => void process.off("unhandledRejection", unhandled));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => vi.mocked(console.warn).mockRestore());
    const listen = vi
      .spyOn(net.Server.prototype, "listen")
      .mockImplementationOnce(function (this: net.Server) {
        process.nextTick(() =>
          this.emit(
            "error",
            Object.assign(new Error("listen failed"), { code: "EACCES" })
          )
        );
        return this;
      });
    onTestFinished(() => listen.mockRestore());
    failServerCloses();
    const relay = relays.open({ identity, required: [] });
    await expect(relay.ready).rejects.toThrow("listen failed");
    // 스스로 닫기를 마쳤다(폴더 지우기가 마지막 단계다).
    await vi.waitFor(() => expect(existsSync(relay.directory)).toBe(false));
    expect(unhandled).not.toHaveBeenCalled();
    await expect(relay.close()).rejects.toThrow(
      "a relay server did not close (EBUSY)"
    );
  });

  it("closes every relay when the hub closes and fails with each relay's failure, not only the first", async () => {
    const { relays } = hub();
    const first = relays.open({ identity, required: [] });
    const second = relays.open({ identity, required: [] });
    await Promise.all([first.ready, second.ready]);
    failServerCloses();
    await expect(relays.close()).rejects.toThrow(
      /^the relays could not be closed: /
    );
    expect(existsSync(first.directory)).toBe(false);
    expect(existsSync(second.directory)).toBe(false);
  });

  it("closes its tunnels and sockets when the run ends, so nothing can reuse them", async () => {
    const target = await fixture("echo");
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const open = await connectVia(relay.directory, `localhost:${target.port}`);
    await relay.close();
    await closed(open.socket);
    expect(existsSync(path.join(relay.directory, "egress.sock"))).toBe(false);
    await expect(
      connectVia(relay.directory, `localhost:${target.port}`)
    ).rejects.toThrow();
  });

  it("passes organization tool requests to the tools handler with this run's identity, overriding what the container claims", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "tools.sock"),
        path: "/api/tools/mcp",
        headers: { "x-babojubot-relay-run": "someone-else" },
      });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({
      url: "/api/tools/mcp",
      run: identity.runId,
      organization: identity.organizationId,
    });
  });

  it("lets this computer reach a server inside the container through connections the container opened", async () => {
    const service = await fixture("http");
    const { relays } = hub();
    const relay = relays.open({ identity, required: [], inbound: true });
    await relay.ready;
    // 컨테이너 쪽: inbound.sock에 미리 붙어 있다가 첫 바이트가 오면 컨테이너 안 서버에 잇는다.
    const reverse = () => {
      const socket = net.connect(path.join(relay.directory, "inbound.sock"));
      socket.once("data", (first) => {
        const local = net.connect(service.port, "127.0.0.1", () => {
          local.write(first);
          socket.pipe(local).pipe(socket);
        });
        reverse();
      });
      onTestFinished(() => void socket.destroy());
    };
    reverse();
    const origin = await relay.inboundOrigin();
    const first = (await (await fetch(`${origin}/one`)).json()) as {
      url: string;
    };
    const second = (await (await fetch(`${origin}/two`)).json()) as {
      url: string;
    };
    expect([first.url, second.url]).toEqual(["/one", "/two"]);
  });

  it("does not open a relay before the server attached its policy", () => {
    const relays = createRelayHub();
    expect(() => relays.open({ identity, required: [] })).toThrow();
  });
});
