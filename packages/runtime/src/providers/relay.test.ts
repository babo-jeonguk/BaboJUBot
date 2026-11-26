import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  attemptAll,
  destinationSchema,
  isDisconnect,
  egressRefusalMessages,
  type Destination,
  type EgressRefusal,
} from "@babojubot/contracts";
import {
  awaitedLater,
  ownClosable,
  ownedClosable,
  ownedListener,
} from "@babojubot/process/test-cleanup";
import { ownedConnect } from "@babojubot/process/testing";
import { within } from "@babojubot/process/test-support";
import {
  refusing,
  failingRelayCloses,
  givenUpAtReset,
  holdsOwner,
  holdsTest,
  nameFaults,
  resetRefusing,
  serverFaults,
  type Holds,
} from "./connect-failure-support.ts";
import { osFaults } from "./os-failure-support.ts";
import { createRelayHub, relaySockets, type RelayHooks } from "./relay.ts";

// 격리 실행의 중계(#149). 컨테이너에는 네트워크가 없고, 실행 시도마다 연 파일 소켓으로만 바깥과 조직 도구에 닿는다.
// 여기서는 컨테이너 쪽 대신 시험이 그 소켓에 직접 붙는다. 금지 목적지는 실제 listener가 연결을 받지 않았는지까지 본다.

// 허용된 목적지로 붙는 연결(`relay.ts` `dial`의 `net.connect`)을 정한 오류로 실패시킨다(connect-failure-support.ts).
// 같은 대역이 중계의 서버(`net.createServer`·`http.createServer`)를 만들어, 시험이 정한 듣기·닫기만 실패시킨다(`serverFaults`).
vi.mock("node:net", async (importOriginal) =>
  (await import("./connect-failure-support.ts")).failingNet(
    await importOriginal()
  )
);
vi.mock("node:http", async (importOriginal) =>
  (await import("./connect-failure-support.ts")).failingHttp(
    await importOriginal(),
    await import("node:net")
  )
);
// 목적지 이름의 풀이(`relay.ts` `resolveAll`)도 같은 대역이 정한 이름만 정한 주소로 답한다(`nameFaults`).
vi.mock("node:dns/promises", async (importOriginal) =>
  (await import("./connect-failure-support.ts")).failingDns(
    await importOriginal()
  )
);
// 이 컴퓨터의 주소 조회(`relay.ts`의 `os.networkInterfaces`)를 시험이 정한 동안 실패시킨다(`osFaults`, os-failure-support.ts).
vi.mock("node:os", async (importOriginal) =>
  (await import("./os-failure-support.ts")).failingOs(await importOriginal())
);
// 대역이 붙잡는 것(gate·콜백 안 기다림)을 쓰는 시험은 `holdsTest`로 둔다: 그 시험의 소유자를 문맥(`holds`)으로만 받고, 그 끝은 그 시험의
// 맨 나중 onTestFinished라 hub·중계·listener 닫기 뒤에 돌며 사건이 오지 않은 기다림과 reset 뒤의 시도를 그 시험의 실패로 알린다
// (connect-failure-support.ts `holdsTest`).
afterEach(() => {
  resetRefusing();
});

const destination = (value: unknown): Destination =>
  destinationSchema.parse(value);

/**
 * 연결 수를 세는 loopback listener. echo하거나 HTTP로 답한다. 서버는 만든 직후 이 시험의 정리에 맡긴다(`ownedListener`: 듣기·닫기
 * 상한, 받은 연결을 끊고 닫힘 확인, 닫기 오류는 실패). `connected()`는 첫 연결 신호다(받으면 이행, 거절하지 않음). 그 신호를 콜백
 * 안에서 기다리면 기다림의 해제는 부르는 쪽이 이 시험의 소유자(`holds.until`)로 맡는다.
 */
async function fixture(kind: "echo" | "http") {
  const accepted: net.Socket[] = [];
  const { server } = await ownedListener(
    kind === "http"
      ? http.createServer((req, res) =>
          res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
        )
      : net.createServer((socket) => socket.pipe(socket)),
    { port: 0, host: "127.0.0.1" },
    onTestFinished,
    `the ${kind} destination`
  );
  const first = Promise.withResolvers<void>();
  server.on("connection", (socket: net.Socket) => {
    accepted.push(socket);
    first.resolve();
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    accepted,
    connected: () => first.promise,
  };
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
  onTestFinished(() => within(relays.close(), 5_000, "the hub did not close"));
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
 * 컨테이너 쪽처럼 egress.sock에 CONNECT를 보내 터널을 연다(`ownedConnect`: 연결을 만든 직후 이 시험의 정리에 맡기고 그 위에 CONNECT를
 * 태운다. 터널은 그 연결이다). 응답 머리는 node:http 클라이언트의 파서가 다 읽은 것이고, `head`는 머리 뒤에 함께 온 바이트, `closed`는
 * 연결을 만든 순간부터 들은 닫힘이다. 터널이 아닌 답(거부)의 전체는 `answerVia`가 본다.
 */
const openTunnel = (directory: string, target: string) =>
  ownedConnect(onTestFinished, path.join(directory, "egress.sock"), target, {
    headers: { host: target },
    what: `CONNECT ${target} to the relay`,
  });

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
 * 중계를 거친 요청 하나를 보내고 답(머리)을 상한 안에서 받는다. 요청은 만든 직후 정리에 맡겨, 상한으로 실패해도 정리가 끊고 닫힘을
 * 확인한다. 본문은 부르는 쪽이 읽거나 버린다.
 */
function answerTo(options: http.RequestOptions) {
  const request = ownedClosable(
    onTestFinished,
    // 요청이 자기 연결을 소유한다(`agent: false`). 기본 agent는 keep-alive라 답이 끝나면 소켓이 풀로 돌아가, 요청의 닫힘이 연결의
    // 닫힘이 아니고 정리가 끊어도 연결이 남는다.
    http.request({ ...options, agent: false }),
    "the request through the relay"
  );
  return within(
    new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
      request.end();
    }),
    5_000,
    "the relay did not answer"
  );
}

/**
 * 받은 답의 본문과 그 끝. 본문을 모으고, 첫 조각이 오면 `onFirstChunk`를 한 번 부른다(시험이 답 도중에 끊는 자리). 끝은
 * `stream.finished`로 받는다: 정상 끝이면 `"ended"`, 오류·중간 닫힘이면 `"broken"`과 그 까닭(`cause`). 상한 안에 끝나야 한다.
 */
async function answerEnding(
  answer: http.IncomingMessage,
  onFirstChunk?: () => void
): Promise<
  | { body: string; ending: "ended" }
  | { body: string; ending: "broken"; cause: unknown }
> {
  let body = "";
  let chunks = 0;
  answer.setEncoding("utf8");
  answer.on("data", (chunk: string) => {
    body += chunk;
    chunks += 1;
    if (chunks === 1) onFirstChunk?.();
  });
  return within(
    finished(answer).then(
      () => ({ body, ending: "ended" as const }),
      (cause: unknown) => ({ body, ending: "broken" as const, cause })
    ),
    5_000,
    "the relay's answer did not end"
  );
}

/**
 * 중계를 거친 요청 하나의 답 본문(`answerTo`·`answerEnding`). 답은 200이어야 하고, 본문은 끝까지 읽는다. 답이 중간에 끊기면 그
 * 까닭(`cause`)과 함께 던진다.
 */
async function answerBody(options: http.RequestOptions) {
  const answer = await answerTo(options);
  expect(answer.statusCode).toBe(200);
  const read = await answerEnding(answer);
  if (read.ending === "broken")
    throw new Error("the relay's answer broke off", { cause: read.cause });
  return read.body;
}

/** 시작한 다시 보기가 상한 안에 끝나기를 기다린다. */
const revalidated = (revalidation: Promise<void>) =>
  within(revalidation, 5_000, "the revalidation did not end");

/**
 * 콜백(정책 hook·대역 구현)이 시험 칸에 담은 기다림을 본문이 상한 안에서 받는다. 콜백이 그 기다림을 시작하지 않았으면 그 이유로
 * 실패한다. 본문은 답 내용을 단언하기 전에 칸부터 받아, 콜백 안 사건의 실패가 그 까닭으로 본문에 닿게 한다.
 */
const fromHook = <T>(held: Promise<T> | undefined, what: string) =>
  within(
    held ?? Promise.reject(new Error(`the hook did not start ${what}`)),
    5_000,
    `${what} in the hook did not end`
  );

/**
 * egress.sock에 보낸 평문 HTTP 요청 하나의 답 상태와 머리(node:http 파서가 읽은 것, `answerTo`). `target`은 요청 줄의 대상(보통
 * 절대 주소, 프록시 요청이 아닌 요청을 보는 시험은 상대 경로)이다. 본문은 버린다.
 */
async function headVia(
  directory: string,
  target: string,
  headers?: http.OutgoingHttpHeaders
) {
  const answer = await answerTo({
    socketPath: path.join(directory, "egress.sock"),
    path: target,
    ...(headers && { headers }),
  });
  answer.resume();
  return { status: answer.statusCode, headers: answer.headers };
}

/**
 * 중계가 목적지로 붙는 연결(`relay.ts` `dial`의 `net.connect`)을 동작을 바꾸지 않는 spy로 기록한다. 돌려주는 함수는 목적지 `port`로
 * 붙으려 한 소켓들이다(`localhost`가 두 주소로 풀리면 거부된 시도도 들어 있다).
 */
function watchDials() {
  const connecting = vi.spyOn(net, "connect");
  onTestFinished(() => void connecting.mockRestore());
  return (port: number) =>
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
}

/** 중계들이 소켓을 열고 듣기 시작하기를 상한 안에서 기다린다. */
const ready = (...relays: { ready: Promise<void> }[]) =>
  within(
    Promise.all(relays.map((relay) => relay.ready)),
    5_000,
    "the relay did not become ready"
  );

/** egress.sock에 CONNECT를 보내고 중계가 연결을 끝낼 때까지 받은 응답 전체(UTF-8)를 상한 안에서 받는다. 거부의 답을 본다. */
function answerVia(directory: string, target: string) {
  // 연결을 만든 직후 정리를 맡긴다. 정리는 연결을 닫고 그 닫힘(`close`)을 상한 안에서 확인한다.
  const socket = ownedClosable(
    onTestFinished,
    net.connect(path.join(directory, "egress.sock")),
    "the CONNECT connection"
  );
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
    await ready(relay);
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
    await ready(relay);
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
    await ready(relay);
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
    await ready(relay);
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
    const { server: redirecting } = await ownedListener(
      http.createServer((req, res) => {
        accepted.push(req.url ?? "");
        res.writeHead(302, {
          location: `http://127.0.0.1:${forbidden.port}/inside`,
        });
        res.end();
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the redirecting destination"
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
    await ready(relay);
    const viaProxy = async (target: string) => {
      const { status, headers } = await headVia(relay.directory, target);
      return { status, location: headers.location };
    };
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
    await ready(relay);
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
    await revalidated(relays.revalidate(identity.organizationId));
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
    await ready(relay);
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
    await revalidated(relays.revalidate(identity.organizationId));
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

  holdsTest(
    "closes a connection admitted under the old policy when the user narrowed it while that connection was opening",
    async ({ holds }) => {
      const target = await fixture("echo");
      const entry = destination({
        host: "localhost",
        port: target.port,
        addresses: ["127.0.0.1", "::1"],
      });
      let current: Destination[] = [entry];
      let narrowing = true;
      /** hook이 시작한 재검사. hook 안에서는 담고 기다리기만 하고, 그 결과는 답을 받은 뒤 본문이 받는다(`holds.until`). */
      const started: { revalidation?: Promise<void> } = {};
      const env = hub({
        // 첫 판정이 옛 목록을 읽은 직후 사용자가 목록을 비우고, 그 재검사가 끝난 뒤에야 연결이 열린다.
        research: async () => {
          const seen = current;
          if (narrowing) {
            narrowing = false;
            current = [];
            started.revalidation = awaitedLater(
              holds.until(
                env.relays.revalidate(identity.organizationId),
                "the revalidation the policy hook started"
              )
            );
            await started.revalidation;
          }
          return seen;
        },
      });
      const relay = env.relays.open({ identity, required: [] });
      await ready(relay);
      const answer = await answerVia(
        relay.directory,
        `localhost:${target.port}`
      );
      // 답 내용보다 먼저 hook의 재검사를 받는다(그 실패가 정책 읽기 실패로 접힌 답보다 먼저 까닭으로 드러난다).
      await fromHook(started.revalidation, "the revalidation");
      // 판정 뒤 정책이 바뀌어 다시 본 연결은 열지 않고 그 이유로 거부한다(200을 보내지 않는다).
      expect(answer).toBe(refusal("policy_changed"));
      expect(env.refused.at(-1)).toEqual({
        host: "localhost",
        port: target.port,
        reason: "policy_changed",
      });
    }
  );

  holdsTest(
    "answers 502 and keeps serving when a plain HTTP destination resets while the changed policy is rechecked",
    async ({ holds }) => {
      const target = await fixture("http");
      const entry = destination({
        host: "localhost",
        port: target.port,
        addresses: ["127.0.0.1", "::1"],
      });
      let calls = 0;
      // 중계가 목적지와 연 소켓을 잡아, 목적지가 끊은 것을 중계가 받았는지 본다.
      const dialed = watchDials();
      /**
       * hook이 담는 것: 첫 판정 중의 재검사, 목적지의 첫 연결, 중계가 목적지로 연 소켓의 닫힘(각 `holds.until`), 재검사 때 살아 있던 그
       * 소켓들. hook 안에서는 담고 기다리기만 하고, 결과와 단언은 답을 받은 뒤 본문에서 한다.
       */
      const recheck: {
        revalidation?: Promise<void>;
        reached?: Promise<void>;
        closed?: Promise<void>;
        carrying?: net.Socket[];
      } = {};
      const env = hub({
        research: async () => {
          calls += 1;
          // 첫 판정 중에 정책이 바뀐 것처럼 재검사를 돌려, 연결 뒤 한 번 더 보게 한다.
          if (calls === 1) {
            recheck.revalidation = awaitedLater(
              holds.until(
                env.relays.revalidate(identity.organizationId),
                "the revalidation the policy hook started"
              )
            );
            await recheck.revalidation;
          }
          // 연결 뒤 재검사(세 번째)를 기다리는 동안 목적지가 연결을 RST로 끊고, 중계의 소켓이 그 끊김으로 닫힌 뒤에 답한다.
          // 재검사는 중계가 목적지에 붙은(`dial`이 이행한) 뒤에 불리므로, 목적지가 그 연결을 받았다는 사건만 기다리면 중계의 소켓은 이미
          // 있다. hook 안 기다림은 `holds.until`로 시험 칸에 담는다: 이 시험의 reset 전에 시작한 기다림은 그 reset(시험 끝, hub·중계 닫기보다
          // 먼저)이 풀고, 결과는 본문이 답을 받은 뒤 `fromHook`으로 먼저 받는다. hook 안에 상한을 두면 그 거절이 정책 읽기 실패로 접힌다.
          if (calls === 3) {
            recheck.reached = awaitedLater(
              holds.until(
                target.connected(),
                "the destination's first connection"
              )
            );
            await recheck.reached;
            const carrying = dialed(target.port).filter(
              (socket) => !socket.destroyed
            );
            recheck.carrying = carrying;
            const [socket] = carrying;
            if (socket) {
              // RST는 오류(ECONNRESET) 뒤 close로 온다. once(…, "close")는 그 오류로 거절되므로 close만 듣는다.
              const closed = new Promise<void>((resolve) =>
                socket.once("close", () => resolve())
              );
              target.accepted.at(-1)!.resetAndDestroy();
              recheck.closed = awaitedLater(
                holds.until(
                  closed,
                  "the close of the relay's socket to the destination"
                )
              );
              await recheck.closed;
            }
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
      await ready(relay);
      const viaProxy = async () =>
        (await headVia(relay.directory, `http://localhost:${target.port}/page`))
          .status;
      const first = await viaProxy();
      // 답 내용보다 먼저 hook의 세 기다림을 받는다(사건으로 풀렸는지, 실패면 그 까닭).
      await fromHook(recheck.revalidation, "the revalidation");
      await fromHook(recheck.reached, "the destination's first connection");
      // 재검사 때 중계가 목적지로 연 소켓은 정확히 하나였다(그것을 목적지가 끊었다).
      expect(recheck.carrying).toHaveLength(1);
      await fromHook(
        recheck.closed,
        "the close of the relay's socket to the destination"
      );
      expect(first).toBe(502);
      expect(uncaught).toEqual([]);
      // 같은 중계가 다음 요청을 그대로 처리한다.
      expect(await viaProxy()).toBe(200);
    }
  );

  // 목적지가 요청을 받고 답하기 전에 끊은 것은 목적지 장애다. 중계가 정책 변경으로 그 연결을 거둔 것과 같은 오류 코드(ECONNRESET)여도
  // 원인을 남긴다(#286 항목 4와 같은 모양).
  it("answers 502 and leaves why when a plain HTTP destination resets before answering", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const { server } = await ownedListener(
      http.createServer((req) => req.socket.resetAndDestroy()),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
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
    await ready(relay);
    const { status } = await headVia(
      relay.directory,
      `http://localhost:${port}/page`
    );
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
      const { server } = await ownedListener(
        http.createServer((req, res) => {
          answering.push(req.socket);
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("part");
        }),
        { port: 0, host: "127.0.0.1" },
        onTestFinished,
        "the destination"
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
      await ready(relay);
      const answer = await answerTo({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${port}/page`,
      });
      // 첫 조각을 받으면 목적지가 답 도중에 끊는다. 끊긴 까닭은 중계의 경고 줄이 본다.
      const { body, ending } = await answerEnding(answer, () =>
        breakOff(answering[0]!)
      );
      expect({ body, ending }).toEqual({ body: "part", ending: "broken" });
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] an allowed destination's answer broke off in the relay (ECONNRESET)",
      ]);
      // 정리한 연결은 정책이 줄어도 다시 거둘 것이 없다.
      setResearch([]);
      await revalidated(relays.revalidate(identity.organizationId));
      expect(refused).toEqual([]);
    }
  );

  // 답 중간에 HTTP 형식이 깨지면 목적지 쪽 요청이 그 원인(파서 오류)을 알린다. 뒤따르는 연결 끊김(ECONNRESET)으로 바꿔 남기지 않는다
  // (#286 병합분 항목 11).
  it("leaves the parser's cause once when a plain HTTP destination's answer turns malformed mid-way", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const answering: net.Socket[] = [];
    const { server } = await ownedListener(
      net.createServer((socket) => {
        answering.push(socket);
        socket.once("data", () =>
          socket.write(
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\npart\r\n"
          )
        );
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
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
    await ready(relay);
    const answer = await answerTo({
      socketPath: path.join(relay.directory, "egress.sock"),
      path: `http://localhost:${port}/page`,
    });
    // 첫 조각을 받은 뒤에 목적지가 형식에 맞지 않는 조각 길이를 보낸다(받은 연결 모두에서).
    const { body, ending } = await answerEnding(answer, () => {
      for (const socket of answering) socket.write("zz\r\n");
    });
    expect({ body, ending }).toEqual({ body: "part", ending: "broken" });
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "[provider] an allowed destination's answer broke off in the relay (HPE_INVALID_CHUNK_SIZE)",
    ]);
    setResearch([]);
    await revalidated(relays.revalidate(identity.organizationId));
    expect(refused).toEqual([]);
  });

  // 목적지가 넘길 답 없이 요청을 닫으면(요청하지 않은 101 Switching Protocols 등) 그 끝도 알린다. 요청자에는 502로 답하고 연결
  // 등록을 놓는다(#296 외부 리뷰 1회차 SPEC-1). 어떤 이유로 닫혔든 같은 끝이다.
  it("answers 502, leaves why and lets go of the connection when a plain HTTP destination closes the request without an answer", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const { server } = await ownedListener(
      net.createServer((socket) => {
        socket.once("data", () =>
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n"
          )
        );
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
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
    await ready(relay);
    const { status } = await headVia(
      relay.directory,
      `http://localhost:${port}/page`
    );
    expect(status).toBe(502);
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "[provider] the relay could not forward a request to an allowed destination; it answered 502 (closed_without_answer)",
    ]);
    // 놓은 연결은 정책이 줄어도 다시 거둘 것이 없다.
    setResearch([]);
    await revalidated(relays.revalidate(identity.organizationId));
    expect(refused).toEqual([]);
  });

  // 목적지 쪽 요청에 넘긴 소켓의 오류는 그 요청의 끝 하나로만 알린다. 연결 단계의 오류 처리가 같은 실패를 따로 한 번 더 남기지
  // 않는다(#296 외부 리뷰 1회차 SPEC-1). 중계가 목적지로 붙는 연결(`net.connect`)은 동작을 바꾸지 않는 spy로 기록만 하고, 목적지
  // 포트로 간 그 소켓에 연결 끊김이 아닌 오류(실제 연결에서 결정적으로 만들 수 없는 오류)를 넣는다.
  it("leaves a socket failure after the answer began once, as the answer's end", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const dialed = watchDials();
    const { server } = await ownedListener(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part");
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
    );
    const port = (server.address() as net.AddressInfo).port;
    const { relays, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    /** 오류를 넣을 때 살아 있던 소켓: 답을 나르는 연결이다. */
    let carrying: net.Socket[] = [];
    const answer = await answerTo({
      socketPath: path.join(relay.directory, "egress.sock"),
      path: `http://localhost:${port}/page`,
    });
    const { ending } = await answerEnding(answer, () => {
      carrying = dialed(port).filter((socket) => !socket.destroyed);
      for (const socket of carrying)
        socket.destroy(
          Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
        );
    });
    expect({ status: answer.statusCode, ending }).toEqual({
      status: 200,
      ending: "broken",
    });
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
    let closed!: () => void;
    /** 목적지 쪽 답이 닫혔다(중계가 목적지 쪽을 정리했다). */
    const destinationClosed = awaitedLater(
      new Promise<void>((resolve) => (closed = resolve))
    );
    const { server } = await ownedListener(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part");
        res.on("close", () => {
          ended.push("closed");
          closed();
        });
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
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
    await ready(relay);
    const answer = await answerTo({
      socketPath: path.join(relay.directory, "egress.sock"),
      path: `http://localhost:${port}/page`,
    });
    // 첫 조각을 받으면 요청자가 떠난다(응답을 끊으면 그 연결이 끊긴다).
    const { body, ending } = await answerEnding(answer, () => answer.destroy());
    expect({ body, ending }).toEqual({ body: "part", ending: "broken" });
    await within(
      destinationClosed,
      5_000,
      "the destination side did not close"
    );
    expect(ended).toEqual(["closed"]);
    setResearch([]);
    await revalidated(relays.revalidate(identity.organizationId));
    expect(refused).toEqual([]);
    expect(warned).not.toHaveBeenCalled();
  });

  // 같은 모양의 요청 쪽: 요청자가 본문을 다 보내기 전에 떠나면 목적지는 나머지 본문을 기다린다. 중계가 목적지 쪽을 닫고 연결을 정리한다.
  it("closes the destination side without a warning when the requester leaves while still sending its body", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const ended: string[] = [];
    let received!: () => void;
    const bodyArrived = awaitedLater(
      new Promise<void>((resolve) => (received = resolve))
    );
    let closed!: () => void;
    /** 목적지가 받은 연결이 닫혔다(중계가 목적지 쪽을 정리했다). */
    const destinationClosed = awaitedLater(
      new Promise<void>((resolve) => (closed = resolve))
    );
    const { server } = await ownedListener(
      http.createServer((req, res) => {
        req.once("data", () => received());
        req.on("end", () => res.end("done"));
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
    );
    server.on("connection", (socket: net.Socket) =>
      socket.on("close", () => {
        ended.push("closed");
        closed();
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
    await ready(relay);
    // 요청은 만든 직후 정리에 맡긴다(정리가 끊고 닫힘을 확인한다).
    const req = ownedClosable(
      onTestFinished,
      http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${port}/upload`,
        method: "POST",
        agent: false,
      }),
      "the upload through the relay"
    );
    // 답 전에 스스로 끊은 요청은 Node가 "socket hang up"(ECONNRESET)으로 알린다. 시험 쪽 요청자의 끝이다.
    const hungUp = awaitedLater(
      new Promise<string | undefined>((resolve) =>
        req.once("error", (error: NodeJS.ErrnoException) => resolve(error.code))
      )
    );
    req.write("part");
    await within(bodyArrived, 5_000, "the destination did not get the body");
    req.destroy();
    expect(
      await within(hungUp, 5_000, "the request did not end after it left")
    ).toBe("ECONNRESET");
    await within(
      destinationClosed,
      5_000,
      "the destination side did not close"
    );
    expect(ended).toEqual(["closed"]);
    setResearch([]);
    await revalidated(relays.revalidate(identity.organizationId));
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
    await ready(relay);
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
    await ready(relay);
    expect(await answerVia(relay.directory, `localhost:${target.port}`)).toBe(
      refusal("policy_unavailable")
    );
    expect(target.accepted.length).toBe(0);
  });

  // 정책 hook이 기다리는 사건이 오지 않아도 그 기다림은 시험 끝의 해제(소유자의 reset)로 풀리고, 풀린 까닭이 본문에 닿는다(#286 PR
  // #300 외부 리뷰 1회차 STD-1). 바깥 답 기다림의 상한은 hook 안 기다림을 끝내지 못한다. 사건이 오지 않은 채 reset에 닿은 기다림은
  // 소유자의 끝(`end`, 시험 수명의 끝)이 그 이름과 함께 실패로 알린다(본문이 바깥 답 기다림의 상한으로 먼저 실패해도 어느 기다림이
  // 멈췄는지 결과에 남는다, 2회차). 풀린 hook은 던지고, 제품은 연결 없이 정책 읽기 실패로 거부한다. 이 시험의 소유자가 아닌 따로 만든
  // 소유자로 reset과 끝을 본문에서 부른다(이 시험의 끝이 실패하지 않게). 1회차의 `expect(() => resetRefusing()).toThrow(…)`는 reset이
  // 보고하던 동작을 고정한 줄이라 끝이 보고하는 단언으로 바꿨다.
  it("releases a policy hook's wait at the double's reset when its event never comes, and gives the body why", async () => {
    const target = await fixture("echo");
    const asked = Promise.withResolvers<void>();
    const owner = holdsOwner();
    /** hook이 담은 기다림. 본문이 해제 뒤 받는다. */
    const hooked: { wait?: Promise<never> } = {};
    const { relays } = hub({
      research: () => {
        asked.resolve();
        hooked.wait = awaitedLater(
          owner.holds.until(
            new Promise<never>(() => {}),
            "the event that never comes"
          )
        );
        return hooked.wait;
      },
    });
    // 이 소유자는 대역의 reset이 풀지 않는다. 본문이 먼저 실패해도 hub 닫기보다 먼저 풀리게 hub 뒤에 등록한다(onTestFinished는
    // 등록 역순으로 돈다).
    onTestFinished(() => owner.giveUp());
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    const answer = awaitedLater(
      answerVia(relay.directory, `localhost:${target.port}`)
    );
    await within(asked.promise, 5_000, "the relay did not look up its policy");
    owner.giveUp();
    await expect(
      fromHook(hooked.wait, "the wait for the event that never comes")
    ).rejects.toMatchObject({
      message: "the event that never comes was given up at the double's reset",
    });
    expect(() => owner.end()).toThrow(
      new Error(
        "the test ended while hook waits had not ended: the event that never comes"
      )
    );
    expect(await answer).toBe(refusal("policy_unavailable"));
    expect(target.accepted.length).toBe(0);
  });

  // 소유자의 reset(`giveUp`) 뒤에 시작한 기다림·gate는 등록되지 않고 곧바로 거절되며, 그 소유자의 끝(`end`)이 그 시도를 그 시험의
  // 실패로 알린다(#286 PR #300 외부 리뷰 2회차 STD-1). 고치기 전에는 reset 뒤의 기다림이 등록되어 다음 reset까지 남았고, 그 이름은
  // 다음 시험의 reset이 알렸다. 이 시험의 소유자가 아닌 따로 만든 소유자로 본다(이 시험의 끝이 실패하지 않게).
  it("refuses a hold begun after its owner's reset at once and reports it as that owner's failure when it ends", async () => {
    const owner = holdsOwner();
    owner.giveUp();
    await expect(
      within(
        owner.holds.until(
          new Promise<never>(() => {}),
          "a wait begun after the reset"
        ),
        5_000,
        "the wait begun after the reset was not refused"
      )
    ).rejects.toMatchObject({
      message:
        "a wait begun after the reset was given up at the double's reset",
    });
    // 사건이 이미 왔어도 reset 뒤의 기다림은 거절한다(사건이 이기면 끝난 시험의 hook이 이어 돈다).
    await expect(
      within(
        owner.holds.until(
          Promise.resolve("came"),
          "a wait whose event already came"
        ),
        5_000,
        "the wait whose event already came did not end"
      )
    ).rejects.toMatchObject({
      message:
        "a wait whose event already came was given up at the double's reset",
    });
    const lateGate = owner.holds.gate();
    expect(
      await within(
        lateGate.until,
        5_000,
        "the gate made after the reset was not released"
      )
    ).toBe("reset");
    expect(() => owner.end()).toThrow(
      new Error(
        "holds began after the double's reset: a wait begun after the reset, a wait whose event already came, a gate"
      )
    );
  });

  it("refuses requests that are not an HTTP proxy request", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    expect((await headVia(relay.directory, "/relative")).status).toBe(400);
  });

  /** 중계 폴더 안의 파일 소켓 `name`의 주소. */
  const socketOf = (relay: { directory: string }, name: string) =>
    path.join(relay.directory, name);
  /**
   * `addresses`에서 듣는 중계 서버의 닫기가 EBUSY로 실패를 알리게 하고(서버는 실제로 닫힌다), 그로 남은 폴더를 정리에 맡긴다
   * (`failingRelayCloses`). `closing`은 그 중계들의 닫기다.
   */
  const failCloses = (
    closing: () => Promise<unknown>,
    ...addresses: string[]
  ) =>
    failingRelayCloses(
      onTestFinished,
      (address) => addresses.includes(address),
      closing
    );
  /** 중계 서버 하나의 닫기가 실패했을 때의 거절: 남긴 폴더를 밝히고, 원인 사슬 끝에 그 닫기 오류가 있다. */
  const keptFolder = (relay: { directory: string }, code: string) => ({
    message: `the relay could not be closed; its folder ${relay.directory} is kept`,
    code: "relay_folder_kept",
    cause: {
      message: `a relay server did not close (${code})`,
      code,
      cause: { code },
    },
  });
  /** 남긴 폴더의 위치를 알리는 중계의 경고. 거절을 받는 쪽은 코드만 기록한다. */
  const keptWarning = (relay: { directory: string }, codes: string) =>
    `[provider] the isolated run relay's servers did not all close; its folder is kept at ${relay.directory} (${codes})`;
  // 닫기 콜백의 실패는 거절로 드러낸다(CODING_STANDARDS.md#제품-코드). 서버가 닫혔음을 확인하지 못했으므로 그 소켓 파일이 있는 폴더도
  // 지우지 않고 남긴다(#297 자원 표, 닫힘 확인 뒤에만 지우기). 실패 원인은 닫기의 거절에 남는다.
  it("fails its close with the cause when a relay server does not close, and keeps its folder", async () => {
    const { relays } = hub();
    const warned = vi.spyOn(console, "warn");
    onTestFinished(() => warned.mockRestore());
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    const { failedAt } = failCloses(
      () => relay.close(),
      socketOf(relay, relaySockets.egress)
    );
    await expect(
      within(relay.close(), 5_000, "the relay did not close")
    ).rejects.toMatchObject(keptFolder(relay, "EBUSY"));
    expect(failedAt).toEqual([socketOf(relay, relaySockets.egress)]);
    expect(existsSync(relay.directory)).toBe(true);
    expect(warned.mock.calls).toEqual([[keptWarning(relay, "EBUSY")]]);
  });

  // 닫기가 거절할 수 있게 된 뒤 그 호출자를 함께 점검했다(#264 외부 리뷰 5회차 STD-4). 열지 못해 스스로 닫는 중계는 닫기 실패를
  // 처리되지 않은 거절로 버리지 않고, 나중에 닫는 쪽(실행 시도·격리 확인의 정리)이 같은 실패를 받는다. 스스로 닫기와 나중의 닫기는 한
  // 번의 닫기다(같은 결과를 받는다).
  it("closes itself after it could not open without dropping a close failure, and gives that failure to whoever closes it", async () => {
    const { relays } = hub();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    onTestFinished(() => void process.off("unhandledRejection", unhandled));
    const warned = vi.spyOn(console, "warn");
    onTestFinished(() => warned.mockRestore());
    serverFaults.listen = { code: "EACCES" };
    const relay = relays.open({ identity, required: [] });
    const { failedAt } = failCloses(
      () => relay.close(),
      socketOf(relay, relaySockets.tools)
    );
    await expect(ready(relay)).rejects.toMatchObject({
      message: "listen failed",
      code: "EACCES",
    });
    expect(serverFaults.refusedListen.mock.calls).toEqual([
      [socketOf(relay, relaySockets.egress)],
    ]);
    await expect(
      within(relay.close(), 5_000, "the relay did not close")
    ).rejects.toMatchObject(keptFolder(relay, "EBUSY"));
    expect(failedAt).toEqual([socketOf(relay, relaySockets.tools)]);
    expect(warned.mock.calls).toEqual([
      ["[provider] the isolated run relay could not open; closing it (EACCES)"],
      [keptWarning(relay, "EBUSY")],
    ]);
    expect(unhandled).not.toHaveBeenCalled();
    expect(existsSync(relay.directory)).toBe(true);
  });

  it("closes every relay when the hub closes and fails with each relay's failure, not only the first", async () => {
    const { relays } = hub();
    const warned = vi.spyOn(console, "warn");
    onTestFinished(() => warned.mockRestore());
    const first = relays.open({ identity, required: [] });
    const second = relays.open({ identity, required: [] });
    await ready(first, second);
    // hub의 닫기는 남은 중계만 닫으므로, 정리에는 시험이 부른 그 닫기를 넘긴다(부르기 전에 실패했으면 정리가 처음 부른다).
    let hubClosing: Promise<void> | undefined;
    const { failedAt } = failCloses(
      () => (hubClosing ??= relays.close()),
      socketOf(first, relaySockets.egress),
      socketOf(second, relaySockets.egress)
    );
    const failure = await within(
      (hubClosing = relays.close()).then(
        () => undefined,
        (error: unknown) => error
      ),
      5_000,
      "the hub did not close"
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [keptFolder(first, "EBUSY"), keptFolder(second, "EBUSY")],
    });
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(warned.mock.calls).toEqual([
      [keptWarning(first, "EBUSY")],
      [keptWarning(second, "EBUSY")],
    ]);
    expect(failedAt).toEqual([
      socketOf(first, relaySockets.egress),
      socketOf(second, relaySockets.egress),
    ]);
    expect(existsSync(first.directory)).toBe(true);
    expect(existsSync(second.directory)).toBe(true);
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
    await ready(relay);
    const open = await openTunnel(relay.directory, `localhost:${target.port}`);
    expectEstablished(open);
    await within(relay.close(), 5_000, "the relay did not close");
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
    await ready(relay);
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
    await ready(relay);
    // 컨테이너 쪽: inbound.sock에 붙은 연결마다 컨테이너 안 서버로 가는 연결을 미리 이어 둔다. 중계는 받은 역방향 연결을 쌓아 두고
    // 이 컴퓨터의 연결(요청은 `agent: false`라 요청마다 새 연결) 하나에 하나씩 쓰므로, 요청 둘에 짝 둘을 연다. 답이 끝나면 짝의 두
    // 소켓이 함께 닫힌다. 모든 소켓은 본문에서 만든 같은 식에서 이 시험의 정리에 맡기고(정리가 끊고 닫힘을 확인한다), 처리기 안에서
    // 소켓을 얻지 않는다(정리가 시작된 뒤 새 소켓을 얻는 길이 없다, #286 PR #300 외부 리뷰 1회차 STD-2).
    for (const pair of ["first", "second"]) {
      const reverse = ownedClosable(
        onTestFinished,
        net.connect(path.join(relay.directory, "inbound.sock")),
        `the ${pair} reverse connection from the container side`
      );
      const local = ownedClosable(
        onTestFinished,
        net.connect(service.port, "127.0.0.1"),
        `the ${pair} connection to the server inside the container`
      );
      reverse.pipe(local).pipe(reverse);
    }
    const origin = await within(
      relay.inboundOrigin(),
      5_000,
      "the inbound origin did not end"
    );
    const { hostname, port, host } = new URL(origin);
    const ask = async (where: string) =>
      JSON.parse(await answerBody({ host: hostname, port, path: where }));
    expect([await ask("/one"), await ask("/two")]).toEqual([
      { url: "/one", host },
      { url: "/two", host },
    ]);
  });

  // 닫기가 시작되면 중계는 새 서버를 만들지 않고, 이미 듣기를 시작한 서버는 듣기 시도가 끝난 뒤 닫는다(#286 PR #299 외부 리뷰
  // 1회차 SPEC-2). 닫기 전에 요청했지만 `ready` 뒤에 이어진 획득, 닫기 시작 뒤의 획득, 듣기 시도 중의 닫기 모두 `relay_closed`로
  // 거절되고 닫기는 듣는 서버를 남기지 않는다. 고치기 전 코드가 만든 loopback 서버는 이 시험의 정리가 닫는다.
  /**
   * 대역이 만든 서버 가운데 포트로 들은 것(중계의 loopback 서버)을 모아 돌려주고, 그 듣기가 시작될 때 `onListen`을 부른다. 시험이 끝날
   * 때 아직 듣는 것이 있으면 받은 연결을 끊고 닫힘을 상한 안에서 확인한 뒤, 닫기 실패와 함께 "중계가 놓친 서버"로 실패한다.
   */
  const watchLoopback = (onListen: () => void = () => {}) => {
    const servers: net.Server[] = [];
    const loopbacks: { server: net.Server; sockets: Set<net.Socket> }[] = [];
    serverFaults.listening = (address, server) => {
      if (typeof address !== "number") return;
      const sockets = new Set<net.Socket>();
      server.on("connection", (socket: net.Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      servers.push(server);
      loopbacks.push({ server, sockets });
      onListen();
    };
    onTestFinished(() => {
      const left = loopbacks.filter(({ server }) => server.listening);
      return attemptAll(
        [
          ...left.map(({ server, sockets }) => () => {
            for (const socket of sockets) socket.destroy();
            return within(
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
              ),
              5_000,
              "a loopback server the relay left did not close"
            );
          }),
          () => {
            if (left.length > 0)
              throw new Error(
                `the relay left ${left.length} loopback server(s) listening`
              );
          },
        ],
        "the relay's loopback servers"
      );
    });
    return servers;
  };
  const relayClosed = { code: "relay_closed" };

  it.each([
    ["asked before its close began and resumed after", "before"],
    ["asked after its close began", "after"],
  ] as const)(
    "opens no inbound server once its close began (%s)",
    async (_name, order) => {
      const { relays } = hub();
      const relay = relays.open({ identity, required: [], inbound: true });
      await ready(relay);
      const loopbacks = watchLoopback();
      let origin: Promise<string>, closing: Promise<void>;
      if (order === "before") {
        origin = relay.inboundOrigin();
        closing = relay.close();
      } else {
        closing = relay.close();
        origin = relay.inboundOrigin();
      }
      await expect(
        within(origin, 5_000, "the inbound origin did not end")
      ).rejects.toMatchObject(relayClosed);
      await within(closing, 5_000, "the relay did not close");
      expect(loopbacks).toEqual([]);
      expect(existsSync(relay.directory)).toBe(false);
    }
  );

  it("closes an inbound server only after its listening began, and gives no origin once its close began", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [], inbound: true });
    await ready(relay);
    // 듣기가 불린 신호와 그때 시작한 닫기를 따로 기다린다(닫기 promise를 그대로 넘기면 신호가 닫기 끝을 따라간다).
    const began = Promise.withResolvers<void>();
    /** 콜백이 시작한 닫기. 만드는 자리에서 시험 칸에 담는다. 본문이 신호를 놓치면(그때 시험은 이미 실패했다) 그 거절은 처리되지 않은 거절로 새지 않고 버려진다. */
    const started: { closing?: Promise<void> } = {};
    // loopback 서버의 듣기는 주소 조회를 거쳐 다음 차례에 시작된다. 그 사이에 닫기를 시작한다.
    const loopbacks = watchLoopback(() => {
      started.closing = awaitedLater(relay.close());
      began.resolve();
    });
    const origin = relay.inboundOrigin();
    await within(began.promise, 5_000, "the inbound server did not listen");
    await fromHook(started.closing, "the relay's close");
    await expect(
      within(origin, 5_000, "the inbound origin did not end")
    ).rejects.toMatchObject(relayClosed);
    expect(loopbacks.map((server) => server.listening)).toEqual([false]);
    expect(existsSync(relay.directory)).toBe(false);
  });

  // 닫기가 시작된 뒤 받은 연결도 끊는다(#286 PR #299 외부 리뷰 1회차 대응 점검). 서버는 차례로 닫히므로 앞 서버를 닫는 동안 뒤 서버가
  // 연결을 받을 수 있고, net 서버(inbound)의 닫기는 받은 연결이 모두 끝나야 끝난다. 앞 서버의 닫기를 붙잡아 그 순간을 상태로 만든다.
  holdsTest(
    "drops a connection it accepts after its close began, so its close ends",
    async ({ holds }) => {
      const { relays } = hub();
      const accepted = Promise.withResolvers<void>();
      serverFaults.listening = (address, server) => {
        if (
          typeof address === "string" &&
          address.endsWith(relaySockets.inbound)
        )
          // 중계의 처리기(만들 때와 듣기 전에 단 것) 뒤에 불린다.
          server.on("connection", () => accepted.resolve());
      };
      const relay = relays.open({ identity, required: [], inbound: true });
      const release = holds.gate();
      serverFaults.holdClose = {
        at: (address) => address === socketOf(relay, relaySockets.egress),
        held: release,
      };
      await ready(relay);
      const closing = relay.close();
      ownedClosable(
        onTestFinished,
        net.connect(socketOf(relay, relaySockets.inbound)),
        "a late inbound connection"
      );
      await within(
        accepted.promise,
        5_000,
        "the relay did not accept the late connection"
      );
      release.open();
      await within(closing, 5_000, "the relay did not close");
      expect(existsSync(relay.directory)).toBe(false);
    }
  );

  // 대역이 붙잡은 닫기는 본문이 풀지 못한 채 끝나도 대역의 reset(afterEach)이 이 시험의 소유자를 통해 푼다(#286 PR #299 외부 리뷰
  // 2회차 STD-1). 본문이 실패하면 아무도 풀지 않아 hub·중계 닫기(onTestFinished)가 그 닫기에 걸렸다. vitest는 afterEach를 모든
  // onTestFinished보다 먼저 부른다(5.0.5 러너 `test.afterEach` 다음 `test.onFinished`, 본문이 실패한 시험으로 실행해 확인). 이 시험의
  // 소유자의 끝은 본문이 등록한 정리 뒤에 돈다(`holdsTest` fixture가 본문 전에 그 시험의 첫 onTestFinished로 등록). 본문이 등록한
  // 정리가 돌 때 소유자는 reset을 거쳤고 아직 끝나지 않았다(#286 PR #300 외부 리뷰 2회차).
  holdsTest(
    "lets the double's reset release a held relay close the body never released",
    async ({ holds }) => {
      onTestFinished(() => expect(holds.state).toBe("givenUp"));
      const { relays } = hub();
      const relay = relays.open({ identity, required: [] });
      const held = holds.gate();
      const caught = Promise.withResolvers<void>();
      serverFaults.heldClose.mockImplementation(() => caught.resolve());
      serverFaults.holdClose = {
        at: (address) => address === socketOf(relay, relaySockets.egress),
        held,
      };
      await ready(relay);
      const closing = relay.close();
      await within(caught.promise, 5_000, "the relay's close was not held");
      resetRefusing();
      await within(closing, 5_000, "the relay did not close");
      expect(existsSync(relay.directory)).toBe(false);
    }
  );

  // 목적지 연결 획득(정책 조회 → 이름 풀이 → 주소마다 연결)도 중계의 수명을 따른다(#286 PR #299 외부 리뷰 2회차 SPEC-3). 닫기가
  // 시작되면 진행 중인 조회의 기다림을 끝내고, 연결 중인 소켓을 끊고, 다음 주소에 붙지 않으며, 그 획득의 끝을 본 뒤 끝난다.
  // 목적지는 시험이 소유한 listener 하나이고, 그 포트로 가는 중계의 연결은 대역이 붙지 않은 채 붙잡는다(`holdConnect`).
  const kinds = ["CONNECT", "HTTP"] as const;
  const heldDestination = async () => {
    const { server } = await ownedListener(
      net.createServer(),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the destination"
    );
    const { port } = server.address() as net.AddressInfo;
    refusing.holdConnect = { port };
    return port;
  };
  /** egress.sock에 CONNECT나 절대 주소 GET의 머리를 쓰는 연결. 만든 직후 정리에 맡기고, 만든 순간부터 들은 닫힘을 돌려준다. */
  const ask = (
    relay: { directory: string },
    kind: (typeof kinds)[number],
    authority: string
  ) => {
    const socket = net.connect(socketOf(relay, relaySockets.egress));
    const { closed } = ownClosable(
      onTestFinished,
      socket,
      `the ${kind} request to the relay`
    );
    socket.on("error", (error) => {
      if (!isDisconnect(error)) throw error;
    });
    socket.on("connect", () =>
      socket.write(
        kind === "CONNECT"
          ? `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`
          : `GET http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\n\r\n`
      )
    );
    return { socket, closed };
  };
  /**
   * 정책 조회를 이 시험의 소유자(`holds`, 본문이 첫 줄에서 잡아 넘김)의 gate로 붙잡는 hub. 대역의 reset으로 풀리면 조회 실패로 던진다(중계는 연결 없이 거부한다). 조회가 풀리면 `allowed`를
   * 돌려주고, 보호 포트는 `protectedPorts`가 답한다(기본: 없음, `hub`의 기본과 같다).
   */
  const heldLookupHub = (
    holds: Holds,
    allowed: Destination[],
    protectedPorts: () => number[] = () => []
  ) => {
    const lookup = holds.gate();
    const asked = Promise.withResolvers<void>();
    const { relays } = hub({
      research: async () => {
        asked.resolve();
        if ((await lookup.until) === "reset")
          throw givenUpAtReset("the held policy lookup");
        return allowed;
      },
      protectedPorts,
    });
    return {
      relays,
      lookup,
      asked: () =>
        within(asked.promise, 5_000, "the relay did not look up its policy"),
    };
  };
  /** 붙잡은 연결을 차례로 받는다(`n`번째). */
  const heldConnects = () => {
    const sockets: PromiseWithResolvers<net.Socket>[] = [];
    const nth = (index: number) =>
      (sockets[index] ??= Promise.withResolvers<net.Socket>());
    let count = 0;
    refusing.heldConnect.mockImplementation((socket) =>
      nth(count++).resolve(socket)
    );
    return (n: number) =>
      within(
        nth(n - 1).promise,
        5_000,
        `the relay did not make connection ${n} to the destination`
      );
  };

  // 목적지가 IP 문자열이라 이름 풀이(스레드풀 I/O)를 거치지 않는다. 고치기 전에는 조회 뒤 판정·연결이 모두 microtask라 서버 닫기
  // 콜백(nextTick 이후)보다 먼저 연결을 시작했다.
  holdsTest.for(kinds)(
    "starts no destination connection from a policy lookup that ends after its close began (%s)",
    async (kind, { holds }) => {
      const port = await heldDestination();
      const { relays, lookup, asked } = heldLookupHub(holds, [
        destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await ready(relay);
      ask(relay, kind, `127.0.0.1:${port}`);
      await asked();
      const closing = relay.close();
      lookup.open();
      await within(closing, 5_000, "the relay did not close");
      expect(refusing.heldConnect).not.toHaveBeenCalled();
    }
  );

  // 닫기는 서버의 정책 조회를 기다리지 않는다(조회는 서버의 일이라 결과만 버린다). 조회는 열지 않는다: 대역의 reset이 풀어 조회
  // 실패로 끝난다.
  holdsTest(
    "ends its close while a policy lookup is still held",
    async ({ holds }) => {
      const port = await heldDestination();
      const { relays, asked } = heldLookupHub(holds, [
        destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await ready(relay);
      ask(relay, "CONNECT", `127.0.0.1:${port}`);
      await asked();
      await within(relay.close(), 5_000, "the relay did not close");
      expect(existsSync(relay.directory)).toBe(false);
    }
  );

  it.each(kinds)(
    "drops a destination connection still being made when its close begins (%s)",
    async (kind) => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const port = await heldDestination();
      const { relays, setResearch } = hub();
      setResearch([
        destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await ready(relay);
      const connection = heldConnects();
      ask(relay, kind, `127.0.0.1:${port}`);
      const socket = await connection(1);
      const closing = relay.close();
      expect(socket.destroyed).toBe(true);
      await within(closing, 5_000, "the relay did not close");
      expect(refusing.heldConnect).toHaveBeenCalledTimes(1);
      expect(warned).not.toHaveBeenCalled();
    }
  );

  // 이름이 주소 셋으로 풀린다. 첫 주소는 연결 실패, 둘째 주소를 붙잡은 사이 닫기가 시작된다. 닫기 뒤에는 남은 셋째 주소로 넘어가지
  // 않고(연결은 두 번뿐, 502 경고도 없음) 붙잡힌 연결을 끊는다. 주소가 둘이면 남은 주소가 없어 "더 시도하지 않음"을 지키지 못했다
  // (#286 PR #299 외부 리뷰 3회차 STD-R3).
  it("tries no further address of a destination once its close began", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const port = await heldDestination();
    nameFaults.lookup = {
      host: "relay-retry.test",
      addresses: ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
    };
    const { relays, setResearch } = hub();
    setResearch([
      destination({ host: "relay-retry.test", port, addresses: ["127.0.0.1"] }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    const connection = heldConnects();
    ask(relay, "CONNECT", `relay-retry.test:${port}`);
    (await connection(1)).destroy(
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      })
    );
    const second = await connection(2);
    const closing = relay.close();
    expect(second.destroyed).toBe(true);
    await within(closing, 5_000, "the relay did not close");
    expect(refusing.heldConnect).toHaveBeenCalledTimes(2);
    expect(nameFaults.looked.mock.calls).toEqual([
      ["relay-retry.test", { all: true, verbatim: true }],
    ]);
    expect(warned).not.toHaveBeenCalled();
  });

  // 닫기 시작 뒤에 끝난 정책 조회는 목적지 이름 풀이를 새로 시작하지 않는다. 고치기 전에는 조회 뒤 풀이 호출까지 microtask라 서버
  // 닫기 콜백보다 먼저 풀이를 시작했다.
  holdsTest(
    "starts no name lookup from a policy lookup that ends after its close began",
    async ({ holds }) => {
      const port = await heldDestination();
      nameFaults.lookup = { host: "relay-late.test", addresses: ["127.0.0.1"] };
      const { relays, lookup, asked } = heldLookupHub(holds, [
        destination({
          host: "relay-late.test",
          port,
          addresses: ["127.0.0.1"],
        }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await ready(relay);
      ask(relay, "CONNECT", `relay-late.test:${port}`);
      await asked();
      const closing = relay.close();
      lookup.open();
      await within(closing, 5_000, "the relay did not close");
      expect(nameFaults.looked).not.toHaveBeenCalled();
    }
  );

  // hub 닫기는 모든 중계의 닫기를 같은 동기 구간에서 먼저 시작한 뒤 정책을 뗀다(#286 PR #299 외부 리뷰 2회차 대응, 감독 결정).
  // 고치기 전에는 정책을 먼저 떼고 중계를 하나씩 닫아, 앞 중계를 닫는 사이 뒤 중계가 받은 요청이 떼어진 정책을 만났다. 앞 중계의
  // 닫기를 붙잡아 그 순간을 상태로 만든다.
  /** 먼저 연 중계의 egress 서버 닫기를 이 시험의 소유자(`holds`)의 gate로 붙잡는다. 붙잡힌 것을 알리는 `caught`와 놓는 gate를 돌려준다. */
  const holdFirstClose = (holds: Holds, first: { directory: string }) => {
    const held = holds.gate();
    const caught = Promise.withResolvers<void>();
    serverFaults.heldClose.mockImplementation(() => caught.resolve());
    serverFaults.holdClose = {
      at: (address) => address === socketOf(first, relaySockets.egress),
      held,
    };
    return {
      held,
      caught: () =>
        within(caught.promise, 5_000, "the first relay's close was not held"),
    };
  };

  holdsTest(
    "starts every relay's close before it detaches the policy, so a tools request meets no detached policy",
    async ({ holds }) => {
      const { relays } = hub();
      const first = relays.open({ identity, required: [] });
      const second = relays.open({ identity, required: [] });
      await ready(first, second);
      const tools = net.connect(socketOf(second, relaySockets.tools));
      const { closed } = ownClosable(
        onTestFinished,
        tools,
        "the tools connection to the second relay"
      );
      tools.on("error", (error) => {
        if (!isDisconnect(error)) throw error;
      });
      const received = vi.fn();
      tools.on("data", received);
      await within(
        new Promise<void>((resolve) => tools.once("connect", () => resolve())),
        5_000,
        "the tools connection did not connect"
      );
      const { held, caught } = holdFirstClose(holds, first);
      const closing = relays.close();
      await caught();
      tools.write("GET /api/tools/mcp HTTP/1.1\r\nHost: tools\r\n\r\n");
      await within(
        closed,
        5_000,
        "the second relay did not drop its tools connection"
      );
      expect(received).not.toHaveBeenCalled();
      held.open();
      await within(closing, 5_000, "the hub did not close");
    }
  );

  // 같은 창에서 정책 조회가 끝난 연결이 떼어진 정책의 보호 포트(빈 목록)로 판정되어 이 컴퓨터의 보호 포트에 붙었다. 고친 뒤에는 hub
  // 닫기가 시작될 때 그 중계가 끊겨 연결이 닫힌다(연결 시작보다 먼저).
  holdsTest(
    "starts no connection to a protected port from a policy lookup that ends while the hub closes",
    async ({ holds }) => {
      const port = await heldDestination();
      const { relays, lookup, asked } = heldLookupHub(
        holds,
        [destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] })],
        () => [port]
      );
      const first = relays.open({ identity, required: [] });
      const second = relays.open({ identity, required: [] });
      await ready(first, second);
      const dialed = Promise.withResolvers<void>();
      refusing.heldConnect.mockImplementation(() => dialed.resolve());
      const { socket, closed } = ask(second, "CONNECT", `127.0.0.1:${port}`);
      const received = vi.fn();
      socket.on("data", received);
      await asked();
      const { held, caught } = holdFirstClose(holds, first);
      const closing = relays.close();
      await caught();
      lookup.open();
      await within(
        Promise.race([dialed.promise, closed]),
        5_000,
        "the CONNECT neither reached the destination nor closed"
      );
      expect(refusing.heldConnect).not.toHaveBeenCalled();
      // 거부의 답도 없다: 판정 전에 hub 닫기가 그 중계를 끊었다.
      expect(received).not.toHaveBeenCalled();
      held.open();
      await within(closing, 5_000, "the hub did not close");
    }
  );

  // 보호 포트를 읽지 못하면 정책을 모르는 것이다. 새 연결은 열지 않는다(연구 목록을 못 읽을 때와 같이). 고치기 전에는 규칙 계산의
  // 예외가 처리되지 않은 거절로 새어 답이 없었다.
  it("refuses a connection while the protected ports cannot be read", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const port = await heldDestination();
    const { relays, setResearch } = hub({
      protectedPorts: () => {
        throw new Error("protected ports down");
      },
    });
    setResearch([
      destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    expect(await answerVia(relay.directory, `127.0.0.1:${port}`)).toBe(
      refusal("policy_unavailable")
    );
    expect(refusing.heldConnect).not.toHaveBeenCalled();
    expect(warned.mock.calls).toEqual([
      ["[provider] the protected ports could not be read (Error)"],
    ]);
  });

  // 정책을 다시 볼 때 보호 포트를 읽지 못하면 이 컴퓨터의 모든 포트를 보호하는 것으로 본다(모름을 허용으로 바꾸지 않음). 고치기 전에는
  // 다시 보기가 던져 이 컴퓨터로 간 연결이 그대로 남았다.
  it("closes a connection to this computer when the protected ports cannot be read on a revalidation", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const target = await fixture("echo");
    let ports = (): number[] => [];
    const { relays, refused } = hub({ protectedPorts: () => ports() });
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
    await ready(relay);
    const tunnel = await openTunnel(
      relay.directory,
      `localhost:${target.port}`
    );
    expectEstablished(tunnel);
    ports = () => {
      throw new Error("protected ports down");
    };
    await revalidated(relays.revalidate(identity.organizationId));
    await tunnelClosed(tunnel);
    expect(refused).toEqual([
      { host: "localhost", port: target.port, reason: "policy_unavailable" },
    ]);
    expect(warned.mock.calls).toEqual([
      ["[provider] the protected ports could not be read (Error)"],
    ]);
  });

  // 다시 볼 때 정책을 읽지 못해 닫는 연결은 정책을 확인하지 못한 것으로 알린다(사용자가 목록을 줄여 닫은 것이 아님). 고치기 전에는
  // 연구 목록을 읽지 못해 필수 목적지만 남긴 다시 보기가 그 연결을 `policy_changed`로 닫았다(#286 PR #299 감독 사전 점검).
  it("tells a connection closed because the policy could not be read on a revalidation as policy_unavailable", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const target = await fixture("echo");
    const allowed = [
      destination({
        host: "localhost",
        port: target.port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ];
    let research = async (): Promise<Destination[]> => allowed;
    const { relays, refused } = hub({ research: () => research() });
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    const tunnel = await openTunnel(
      relay.directory,
      `localhost:${target.port}`
    );
    expectEstablished(tunnel);
    research = async () => {
      throw new Error("db down");
    };
    await revalidated(relays.revalidate(identity.organizationId));
    await tunnelClosed(tunnel);
    expect(refused).toEqual([
      { host: "localhost", port: target.port, reason: "policy_unavailable" },
    ]);
    expect(warned.mock.calls).toEqual([
      ["[provider] the research destinations could not be read (Error)"],
    ]);
  });

  // 목적지 판정의 입력은 정책(연구 목록·보호 포트)만이 아니라 이 컴퓨터의 주소(OS 조회)도다. 그 조회가 실패하면 판정 재료를 모르는
  // 것이므로 정책을 못 읽을 때와 같이 새 연결은 열지 않고, 다시 보기는 좁혀 `policy_unavailable`로 닫는다(#286 PR #299 외부 리뷰
  // 3회차 SPEC-4). 고치기 전에는 판정 도중 OS를 직접 읽어 그 실패가 판정의 예외로 새어, 새 연결은 답이 없고(처리되지 않은 거절)
  // 다시 보기는 던져 연결을 회수하지 못했다. 실패는 실제 OS 조회 경계(`node:os` 모듈 대역)에 넣는다.
  const addressesUnreadable =
    "[provider] this computer's addresses could not be read (ERR_SYSTEM_ERROR)";
  /** egress.sock을 거친 HTTP 절대 주소 요청 하나의 답 상태와 거부 이유(`headVia`). */
  const httpAnswer = async (
    relay: { directory: string },
    authority: string
  ) => {
    const { status, headers } = await headVia(
      relay.directory,
      `http://${authority}/`,
      { host: authority }
    );
    return { status, refusal: headers["x-babojubot-refusal"] };
  };

  it.each(kinds)(
    "refuses a new connection while this computer's addresses cannot be read (%s)",
    async (kind) => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const port = await heldDestination();
      const { relays, refused, setResearch } = hub();
      setResearch([
        destination({ host: "127.0.0.1", port, addresses: ["127.0.0.1"] }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await ready(relay);
      osFaults.interfaces = { cause: "ENOMEM" };
      if (kind === "CONNECT")
        expect(await answerVia(relay.directory, `127.0.0.1:${port}`)).toBe(
          refusal("policy_unavailable")
        );
      else
        expect(await httpAnswer(relay, `127.0.0.1:${port}`)).toEqual({
          status: 403,
          refusal: "policy_unavailable",
        });
      expect(refusing.heldConnect).not.toHaveBeenCalled();
      expect(refused).toEqual([
        { host: "127.0.0.1", port, reason: "policy_unavailable" },
      ]);
      expect(warned.mock.calls).toEqual([[addressesUnreadable]]);
    }
  );

  it("closes a connection as policy_unavailable when a revalidation cannot read this computer's addresses", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const target = await fixture("echo");
    const { relays, refused, setResearch } = hub();
    setResearch([
      destination({
        host: "localhost",
        port: target.port,
        addresses: ["127.0.0.1", "::1"],
      }),
    ]);
    const relay = relays.open({ identity, required: [] });
    await ready(relay);
    const tunnel = await openTunnel(
      relay.directory,
      `localhost:${target.port}`
    );
    expectEstablished(tunnel);
    osFaults.interfaces = { cause: "ENOMEM" };
    setResearch([]);
    await revalidated(relays.revalidate(identity.organizationId));
    await tunnelClosed(tunnel);
    expect(refused).toEqual([
      { host: "localhost", port: target.port, reason: "policy_unavailable" },
    ]);
    expect(warned.mock.calls).toEqual([[addressesUnreadable]]);
  });

  // 판정 도중(이름 풀이) 사용자가 목록을 비우고 그때부터 이 컴퓨터의 주소를 읽지 못한다. 판정은 앞서 읽은 재료로 허용해 연결하고,
  // 판정 뒤 다시 보기가 주소를 읽지 못해 그 연결을 열지 않고 `policy_unavailable`로 거부한다.
  it.each(kinds)(
    "refuses a connection whose recheck after its decision cannot read this computer's addresses (%s)",
    async (kind) => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const target = await fixture(kind === "CONNECT" ? "echo" : "http");
      nameFaults.lookup = {
        host: "relay-recheck.test",
        addresses: ["127.0.0.1"],
      };
      const { relays, refused, setResearch } = hub();
      setResearch([
        destination({
          host: "relay-recheck.test",
          port: target.port,
          addresses: ["127.0.0.1"],
        }),
      ]);
      const relay = relays.open({ identity, required: [] });
      await ready(relay);
      // 판정 도중(이름 풀이 안)에 시작한 다시 보기. 응답을 기다리는 사이 거절돼도 처리되지 않은 거절로 남지 않게, 시작하는 자리에서
      // 나중에 기다릴 것으로 맡긴다.
      const started: { revalidation?: Promise<void> } = {};
      nameFaults.looked.mockImplementation(() => {
        osFaults.interfaces = { cause: "ENOMEM" };
        setResearch([]);
        started.revalidation = awaitedLater(
          relays.revalidate(identity.organizationId)
        );
      });
      const authority = `relay-recheck.test:${target.port}`;
      const answer =
        kind === "CONNECT"
          ? await answerVia(relay.directory, authority)
          : await httpAnswer(relay, authority);
      // 답 내용보다 먼저 콜백이 시작한 다시 보기를 받는다. 판정 도중의 이름 풀이는 한 번이고, 그 안에서 다시 보기를 한 번 시작했다.
      await fromHook(started.revalidation, "the revalidation");
      expect(nameFaults.looked).toHaveBeenCalledTimes(1);
      expect(answer).toEqual(
        kind === "CONNECT"
          ? refusal("policy_unavailable")
          : { status: 403, refusal: "policy_unavailable" }
      );
      expect(refused).toEqual([
        {
          host: "relay-recheck.test",
          port: target.port,
          reason: "policy_unavailable",
        },
      ]);
      // 판정 도중의 다시 보기와 판정 뒤 다시 보기가 각각 한 번 읽지 못했다.
      expect(warned.mock.calls).toEqual([
        [addressesUnreadable],
        [addressesUnreadable],
      ]);
    }
  );

  it("does not open a relay before the server attached its policy", () => {
    const relays = createRelayHub();
    expect(() => relays.open({ identity, required: [] })).toThrow();
  });
});
