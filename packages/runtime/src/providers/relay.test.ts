import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  destinationSchema,
  egressRefusalMessages,
  isDisconnect,
  type Destination,
  type EgressRefusal,
} from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";
import { refusing, resetRefusing } from "./connect-failure-support.ts";
import { createRelayHub, type RelayHooks } from "./relay.ts";

// 격리 실행의 중계(#149). 컨테이너에는 네트워크가 없고, 실행 시도마다 연 파일 소켓으로만 바깥과 조직 도구에 닿는다.
// 여기서는 컨테이너 쪽 대신 시험이 그 소켓에 직접 붙는다. 금지 목적지는 실제 listener가 연결을 받지 않았는지까지 본다.

// 허용된 목적지로 붙는 연결(`relay.ts` `dial`의 `net.connect`)을 정한 오류로 실패시킨다(connect-failure-support.ts).
vi.mock("node:net", async (importOriginal) =>
  (await import("./connect-failure-support.ts")).failingNet(
    await importOriginal()
  )
);
afterEach(() => {
  resetRefusing();
});

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

/**
 * 컨테이너 쪽처럼 egress.sock에 CONNECT를 보내 터널을 연다. 응답 머리는 node:http 클라이언트의 파서가 다 읽은 것(`connect` 이벤트)이고,
 * `head`는 머리 뒤에 함께 온 바이트다. 닫힘은 연 순간부터 듣는다(`closed`: 실제 `close` 이벤트, 상대가 끊어 난 오류는 닫힘의 일부).
 * 시험이 끝나면 연결을 닫는다. 터널이 아닌 답(거부)의 전체는 `answerVia`가 본다.
 */
function openTunnel(directory: string, target: string) {
  const request = http.request({
    socketPath: path.join(directory, "egress.sock"),
    method: "CONNECT",
    path: target,
    headers: { host: target },
  });
  return within(
    new Promise<{
      response: http.IncomingMessage;
      socket: net.Socket;
      head: Buffer;
      closed: Promise<void>;
    }>((resolve, reject) => {
      request.once("error", reject);
      request.once("connect", (response, socket: net.Socket, head: Buffer) => {
        const closed = new Promise<void>((done, fail) => {
          socket.on("error", (error) => {
            if (!isDisconnect(error)) fail(error);
          });
          socket.once("close", () => done());
        });
        // 시험이 끝나면 연결을 닫고 그 닫힘을 상한 안에서 확인한다. 끊김 밖의 오류는 거기서(또는 먼저 기다린 곳에서) 드러난다.
        onTestFinished(async () => {
          socket.destroy();
          await within(closed, 5_000, "the tunnel did not close");
        });
        resolve({ response, socket, head, closed });
      });
      request.end();
    }),
    5_000,
    `the relay did not answer CONNECT ${target}`
  );
}

/** 중계가 터널을 연 답: 200 Connection Established, 머리 줄 없음, 머리 뒤에 먼저 온 바이트 없음. */
function expectEstablished(tunnel: Awaited<ReturnType<typeof openTunnel>>) {
  expect({
    status: tunnel.response.statusCode,
    message: tunnel.response.statusMessage,
    headers: tunnel.response.rawHeaders,
    after: tunnel.head.length,
  }).toEqual({
    status: 200,
    message: "Connection Established",
    headers: [],
    after: 0,
  });
}

/** 터널이 닫히기를 상한 안에서 기다린다. 닫히지 않으면 그 이유로 실패한다(닫히지 않음을 시간으로 판정하지 않는다). */
const tunnelClosed = (tunnel: Awaited<ReturnType<typeof openTunnel>>) =>
  within(tunnel.closed, 5_000, "the tunnel did not close");

/**
 * 중계를 거친 요청 하나의 답 본문. 답은 200이어야 하고, 본문은 끝까지 읽는다. 읽기는 정상 끝·오류·중간 닫힘을 함께 받아, 답이
 * 중간에 끊기면 그 까닭으로 거절한다. 요청·답·본문은 각각 상한 안에 와야 한다.
 */
async function answerBody(options: http.RequestOptions) {
  const answer = await within(
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(options);
      req.on("response", resolve);
      req.on("error", reject);
      req.end();
    }),
    5_000,
    "the relay did not answer"
  );
  expect(answer.statusCode).toBe(200);
  return within(text(answer), 5_000, "the relay's answer did not end");
}

/** egress.sock에 CONNECT를 보내고 중계가 연결을 끝낼 때까지 받은 응답 전체(UTF-8)를 상한 안에서 받는다. 거부의 답을 본다. */
function answerVia(directory: string, target: string) {
  const socket = net.connect(path.join(directory, "egress.sock"));
  onTestFinished(() => void socket.destroy());
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("connect", () =>
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
  );
  return within(
    new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }),
    5_000,
    `the relay did not end its answer to CONNECT ${target}`
  );
}

/** 중계가 `reason`으로 거부할 때 보내는 답 전체: 403 머리와 사용자 안내 본문. */
function refusal(reason: EgressRefusal) {
  const body = `${egressRefusalMessages[reason]}\n`;
  return (
    "HTTP/1.1 403 Forbidden\r\n" +
    `X-BaboJUBot-Refusal: ${reason}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body
  );
}

/** 터널로 보낸 것이 그 바이트 수만큼 되돌아오기를 상한 안에서 기다리고, 받은 것을 돌려준다. */
const roundTrip = (socket: net.Socket, text: string) =>
  within(
    new Promise<string>((resolve) => {
      const expected = Buffer.byteLength(text);
      const chunks: Buffer[] = [];
      let size = 0;
      const read = (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size < expected) return;
        socket.off("data", read);
        resolve(Buffer.concat(chunks).toString());
      };
      socket.on("data", read);
      socket.write(text);
    }),
    5_000,
    "the tunnel did not send back what it was given"
  );

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
    const ok = await openTunnel(relay.directory, `localhost:${target.port}`);
    expectEstablished(ok);
    expect(await roundTrip(ok.socket, "ping")).toBe("ping");
    ok.socket.destroy();

    const before = target.accepted.length;
    expect(await answerVia(relay.directory, `127.0.0.1:${target.port}`)).toBe(
      refusal("destination_not_allowed")
    );
    expect(
      await answerVia(relay.directory, `localhost:${target.port + 1}`)
    ).toBe(refusal("destination_not_allowed"));
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
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("address_not_allowed")
    );
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
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("address_not_allowed")
    );
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
    const body = await answerBody({
      socketPath: path.join(relay.directory, "egress.sock"),
      path: `http://localhost:${target.port}/page?x=1`,
      headers: { host: `localhost:${target.port}` },
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
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("destination_not_allowed")
    );
    setResearch([entry]);
    const open = await openTunnel(relay.directory, `localhost:${target.port}`);
    expectEstablished(open);
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    await tunnelClosed(open);
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
    const open = await openTunnel(relay.directory, `localhost:${target.port}`);
    expectEstablished(open);
    // 이름·포트는 그대로 두고 내부 주소 예외만 지운다. 새 연결은 거부되므로 열린 연결도 닫혀야 한다.
    setResearch([destination({ host: "localhost", port: target.port })]);
    await relays.revalidate(identity.organizationId);
    await tunnelClosed(open);
    expect(refused.at(-1)).toEqual({
      host: "localhost",
      port: target.port,
      reason: "policy_changed",
    });
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("address_not_allowed")
    );
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
    // 판정 뒤 정책이 바뀌어 다시 본 연결은 열지 않고 그 이유로 거부한다(200을 보내지 않는다).
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("policy_changed")
    );
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

  // 목적지가 요청을 받고 답하기 전에 끊은 것은 목적지 장애다. 중계가 정책 변경으로 그 연결을 거둔 것과 같은 오류 코드(ECONNRESET)여도
  // 원인을 남긴다(#286 항목 4와 같은 모양).
  it("answers 502 and leaves why when a plain HTTP destination resets before answering", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const server = http.createServer((req) => req.socket.resetAndDestroy());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const port = (server.address() as net.AddressInfo).port;
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
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${port}/page`,
        agent: false,
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(502);
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "[provider] the relay could not forward a request to an allowed destination; it answered 502 (ECONNRESET)",
    ]);
  });

  // 답을 보내기 시작한 목적지가 중간에 끊으면(RST든 FIN이든) 받은 조각을 끝난 답처럼 넘기지 않는다. 머리는 이미 나갔으므로 502를 새로
  // 쓰지 않고 요청자 연결을 끊으며, 원인을 한 번 남기고 그 연결을 정리한다(#290 3회차 SPEC-4).
  it.each([
    ["resets", (socket: net.Socket) => socket.resetAndDestroy()],
    ["closes", (socket: net.Socket) => socket.destroy()],
  ])(
    "cuts the request, leaves why once, and lets go of the connection when a plain HTTP destination %s mid-answer",
    async (_how, breakOff) => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const answering: net.Socket[] = [];
      const server = http.createServer((req, res) => {
        answering.push(req.socket);
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      onTestFinished(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          })
      );
      const port = (server.address() as net.AddressInfo).port;
      const { relays, refused, setResearch } = hub();
      setResearch([
        destination({
          host: "localhost",
          port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await relay.ready;
      const received = await new Promise<{ body: string; ending: string }>(
        (resolve, reject) => {
          const req = http.request({
            socketPath: path.join(relay.directory, "egress.sock"),
            path: `http://localhost:${port}/page`,
            agent: false,
          });
          req.on("response", (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
              breakOff(answering[0]!);
            });
            res.on("end", () => resolve({ body, ending: "ended" }));
            res.on("error", () => resolve({ body, ending: "broken" }));
          });
          req.on("error", reject);
          req.end();
        }
      );
      expect(received).toEqual({ body: "part", ending: "broken" });
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] an allowed destination's answer broke off in the relay (ECONNRESET)",
      ]);
      // 정리한 연결은 정책이 줄어도 다시 거둘 것이 없다.
      setResearch([]);
      await relays.revalidate(identity.organizationId);
      expect(refused).toEqual([]);
    }
  );

  // 답 중간에 HTTP 형식이 깨지면 목적지 쪽 요청이 그 원인(파서 오류)을 알린다. 뒤따르는 연결 끊김(ECONNRESET)으로 바꿔 남기지 않는다
  // (#286 병합분 항목 11).
  it("leaves the parser's cause once when a plain HTTP destination's answer turns malformed mid-way", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const answering: net.Socket[] = [];
    const server = net.createServer((socket) => {
      answering.push(socket);
      socket.once("data", () =>
        socket.write(
          "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\npart\r\n"
        )
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          for (const socket of answering) socket.destroy();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const port = (server.address() as net.AddressInfo).port;
    const { relays, refused, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const received = await new Promise<{ body: string; ending: string }>(
      (resolve, reject) => {
        const req = http.request({
          socketPath: path.join(relay.directory, "egress.sock"),
          path: `http://localhost:${port}/page`,
          agent: false,
        });
        req.on("response", (res) => {
          let body = "";
          // 첫 조각을 받은 뒤에 목적지가 형식에 맞지 않는 조각 길이를 보낸다(받은 연결 모두에서).
          res.once("data", () => {
            for (const socket of answering) socket.write("zz\r\n");
          });
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ body, ending: "ended" }));
          res.on("error", () => resolve({ body, ending: "broken" }));
        });
        req.on("error", reject);
        req.end();
      }
    );
    expect(received).toEqual({ body: "part", ending: "broken" });
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "[provider] an allowed destination's answer broke off in the relay (HPE_INVALID_CHUNK_SIZE)",
    ]);
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    expect(refused).toEqual([]);
  });

  // 목적지가 넘길 답 없이 요청을 닫으면(요청하지 않은 101 Switching Protocols 등) 그 끝도 알린다. 요청자에는 502로 답하고 연결
  // 등록을 놓는다(#296 외부 리뷰 1회차 SPEC-1). 어떤 이유로 닫혔든 같은 끝이다.
  it("answers 502, leaves why and lets go of the connection when a plain HTTP destination closes the request without an answer", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const answering: net.Socket[] = [];
    const server = net.createServer((socket) => {
      answering.push(socket);
      socket.once("data", () =>
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n"
        )
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          for (const socket of answering) socket.destroy();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const port = (server.address() as net.AddressInfo).port;
    const { relays, refused, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${port}/page`,
        agent: false,
      });
      // 답이 오지 않는 결함이 시험 시간 초과로 번지지 않게 한다.
      req.setTimeout(10_000, () =>
        reject(new Error("the relay did not answer within 10 s"))
      );
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(502);
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "[provider] the relay could not forward a request to an allowed destination; it answered 502 (closed_without_answer)",
    ]);
    // 놓은 연결은 정책이 줄어도 다시 거둘 것이 없다.
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    expect(refused).toEqual([]);
  });

  // 목적지 쪽 요청에 넘긴 소켓의 오류는 그 요청의 끝 하나로만 알린다. 연결 단계의 오류 처리가 같은 실패를 따로 한 번 더 남기지
  // 않는다(#296 외부 리뷰 1회차 SPEC-1). 중계가 목적지로 붙는 연결(`net.connect`)은 동작을 바꾸지 않는 spy로 기록만 하고, 목적지
  // 포트로 간 그 소켓에 연결 끊김이 아닌 오류(실제 연결에서 결정적으로 만들 수 없는 오류)를 넣는다.
  it("leaves a socket failure after the answer began once, as the answer's end", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const connecting = vi.spyOn(net, "connect");
    onTestFinished(() => connecting.mockRestore());
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const port = (server.address() as net.AddressInfo).port;
    /** 중계가 목적지 포트로 붙으려 한 소켓들. `localhost`가 두 주소로 풀리면 거부된 시도도 들어 있다. */
    const dialed = () =>
      connecting.mock.calls.flatMap((args, index) => {
        const options: unknown = args[0];
        const result = connecting.mock.results[index];
        return typeof options === "object" &&
          options !== null &&
          "port" in options &&
          Number(options.port) === port &&
          result?.type === "return"
          ? [result.value]
          : [];
      });
    const { relays, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    /** 오류를 넣을 때 살아 있던 소켓: 답을 나르는 연결이다. */
    let carrying: net.Socket[] = [];
    const received = await new Promise<{ status: number; ending: string }>(
      (resolve, reject) => {
        const req = http.request({
          socketPath: path.join(relay.directory, "egress.sock"),
          path: `http://localhost:${port}/page`,
          agent: false,
        });
        // 답이 끝나지 않는 결함이 시험 시간 초과로 번지지 않게 한다.
        req.setTimeout(10_000, () =>
          reject(new Error("the relayed answer did not end within 10 s"))
        );
        req.on("response", (res) => {
          const status = res.statusCode ?? 0;
          res.once("data", () => {
            carrying = dialed().filter((socket) => !socket.destroyed);
            for (const socket of carrying)
              socket.destroy(
                Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
              );
          });
          res.on("end", () => resolve({ status, ending: "ended" }));
          res.on("error", () => resolve({ status, ending: "broken" }));
        });
        req.on("error", reject);
        req.end();
      }
    );
    expect(received).toEqual({ status: 200, ending: "broken" });
    expect(carrying).toHaveLength(1);
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "[provider] an allowed destination's answer broke off in the relay (ETIMEDOUT)",
    ]);
  });

  // 요청자가 답을 다 받기 전에 떠난 것은 답이다. 원인을 남기지 않고, 목적지 쪽 연결도 닫아 정리한다.
  it("closes the destination side without a warning when the requester leaves mid-answer", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const ended: string[] = [];
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part");
      res.on("close", () => ended.push("closed"));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const port = (server.address() as net.AddressInfo).port;
    const { relays, refused, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${port}/page`,
        agent: false,
      });
      req.on("response", (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      // 떠난 뒤의 오류는 이미 정해진 결과를 바꾸지 않는다.
      req.on("error", reject);
      req.end();
    });
    await expect
      .poll(() => ended, { timeout: 2000, interval: 20 })
      .toEqual(["closed"]);
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    expect(refused).toEqual([]);
    expect(warned).not.toHaveBeenCalled();
  });

  // 같은 모양의 요청 쪽: 요청자가 본문을 다 보내기 전에 떠나면 목적지는 나머지 본문을 기다린다. 중계가 목적지 쪽을 닫고 연결을 정리한다.
  it("closes the destination side without a warning when the requester leaves while still sending its body", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const ended: string[] = [];
    let received!: () => void;
    const bodyArrived = new Promise<void>((resolve) => (received = resolve));
    const server = http.createServer((req, res) => {
      req.once("data", () => received());
      req.on("end", () => res.end("done"));
    });
    server.on("connection", (socket: net.Socket) =>
      socket.on("close", () => ended.push("closed"))
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const port = (server.address() as net.AddressInfo).port;
    const { relays, refused, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const req = http.request({
      socketPath: path.join(relay.directory, "egress.sock"),
      path: `http://localhost:${port}/upload`,
      method: "POST",
      agent: false,
    });
    // 답 전에 스스로 끊은 요청은 Node가 "socket hang up"(ECONNRESET)으로 알린다. 시험 쪽 요청자의 끝이다.
    const hungUp = new Promise<string | undefined>((resolve) =>
      req.once("error", (error: NodeJS.ErrnoException) => resolve(error.code))
    );
    req.write("part");
    await bodyArrived;
    req.destroy();
    expect(await hungUp).toBe("ECONNRESET");
    await expect
      .poll(() => ended, { timeout: 2000, interval: 20 })
      .toEqual(["closed"]);
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    expect(refused).toEqual([]);
    expect(warned).not.toHaveBeenCalled();
  });

  // 연결 실패의 원인은 그 연결이 실제로 받은 오류 코드다(#286 항목 14). 연결 경계에 정한 오류를 넣어, 이 시스템의 이름 풀이·IPv6
  // 설정과 상관없이 중계가 확인한 주소·포트로 붙고 그 오류 코드를 그대로 남기며 502로 답하는지 본다. 실제 연결에서 나오지 않는
  // 코드(EHOSTUNREACH)를 넣어, 다른 실패가 끼어들면 드러나게 한다. 이름 풀이의 실패 원인은 egress-policy.test.ts가 풀이 함수를 넣어 본다.
  it("answers 502 and leaves the code the connection failed with, dialing only the checked address and port", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const port = 40_123;
    refusing.refuse = { port, code: "EHOSTUNREACH" };
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] }),
      ],
    });
    await relay.ready;
    expect(await answerVia(relay.directory, `127.0.0.1:${port}`)).toBe(
      "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    expect(refusing.dialed.mock.calls).toEqual([[{ host: "127.0.0.1", port }]]);
    expect(warned.mock.calls).toEqual([
      [
        "[provider] the relay could not connect to an allowed destination; it answered 502 (EHOSTUNREACH)",
      ],
    ]);
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
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("policy_unavailable")
    );
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
    const open = await openTunnel(relay.directory, `localhost:${target.port}`);
    expectEstablished(open);
    await relay.close();
    await tunnelClosed(open);
    expect(existsSync(path.join(relay.directory, "egress.sock"))).toBe(false);
    // 지운 소켓 파일에는 연결할 곳이 없다.
    await expect(
      openTunnel(relay.directory, `localhost:${target.port}`)
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes organization tool requests to the tools handler with this run's identity, overriding what the container claims", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const body = await answerBody({
      socketPath: path.join(relay.directory, "tools.sock"),
      path: "/api/tools/mcp",
      headers: { "x-babojubot-relay-run": "someone-else" },
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
