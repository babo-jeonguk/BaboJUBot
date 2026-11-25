import { mkdtempSync, rmSync } from "node:fs";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  continueAfterFailure,
  egressRefusalMessages,
  failureCode,
  isDisconnect,
  orIfProbeFailed,
  orIfUnreadable,
  settled,
  type Destination,
  type EgressRefusal,
} from "@babojubot/contracts";
import { listenAttempt } from "@babojubot/process";
import {
  allowsConnection,
  decideDestination,
  type EgressRules,
} from "./egress-policy.ts";
import { passAnswer } from "./answer-flow.ts";

/**
 * 격리 실행의 중계(#149). 실행 시도 컨테이너에는 네트워크가 없고(`--network none`), 실행 시도마다 이 컴퓨터에 연 폴더의
 * 파일 소켓만 읽기로 넣는다. 컨테이너 안의 이미지 프로그램(docker/runner/relay.mjs)이 loopback 포트를 이 소켓에 잇는다.
 * - `egress.sock`: HTTP 프록시(CONNECT, 절대 주소 요청). 목적지마다 정책을 다시 읽어 판정하고, 확인한 주소로만 연결한다.
 * - `tools.sock`: 조직 도구. 요청에 이 실행 시도의 신원을 덧붙여 서버의 도구 경로로 넘긴다.
 * - `inbound.sock`: 이 컴퓨터가 컨테이너 안 서버(OpenCode)를 부르는 길. 컨테이너가 미리 붙여 둔 연결을 하나씩 쓴다.
 * 소켓은 이 컴퓨터가 만들고 컨테이너는 만들지 않는다. 실행 시도가 끝나면 열린 연결과 소켓을 모두 닫으며 다른 실행 시도와 나누지 않는다.
 */

/** 중계의 주인. 정책은 이 조직·실행 시도의 것만 쓴다. 세션 정비(미리 압축)는 실행 시도가 없다. */
export type RelayIdentity = {
  organizationId: string;
  agentId?: string;
  runId?: string;
};

/** 서버가 붙이는 정책·도구. 붙이기 전에는 중계를 열지 않는다(실행 시작 거부). */
export type RelayHooks = {
  /** 이 조직의 연구 목적지. 초기 연구 승인 전이면 빈 목록이다. 읽지 못하면 던진다(거부). 연결마다 부른다. */
  research(identity: RelayIdentity): Promise<readonly Destination[]>;
  /** 조직 도구 경로. 요청에는 중계가 `x-babojubot-relay-run`·`x-babojubot-relay-organization` 머리를 덮어써 넣는다. */
  tools: http.RequestListener;
  /** 이 컴퓨터에서 어떤 예외로도 열지 않는 포트(사용자 API·DB). */
  protectedPorts(): number[];
  /** 거부를 알린다. 실행 활동·서버 기록에 남긴다. 비밀값은 없다. */
  refused?(
    identity: RelayIdentity,
    detail: { host: string; port: number; reason: EgressRefusal }
  ): void;
};

export type OpenRelay = {
  /** 컨테이너에 읽기로 넣을 폴더(이 컴퓨터 경로). */
  directory: string;
  /** 소켓을 모두 연 때. 실패하면(듣기 오류, 듣는 사이 닫기가 시작되면 `relay_closed`) 거부된다. */
  ready: Promise<void>;
  /**
   * 컨테이너 안 서버로 가는 이 컴퓨터 loopback 주소(origin). `inbound`로 연 중계만. 첫 호출이 서버를 얻고 그 결과를 다시 돌려준다. 그
   * 서버를 얻기 전(또는 듣는 사이)에 닫기가 시작됐으면 `relay_closed`로 거절한다. 이미 낸 주소는 닫기 뒤에도 그대로 돌려준다(그 서버는
   * 닫기가 닫는다).
   */
  inboundOrigin(): Promise<string>;
  /** 열린 연결을 끊고 소켓·폴더를 지운다. 여러 번 불러도 된다. */
  close(): Promise<void>;
};

export type RelayHub = {
  attach(hooks: RelayHooks): void;
  /** 실행 시도 하나의 중계를 연다. `required`는 그 연결이 늘 여는 모델·로그인 목적지다. */
  open(input: {
    identity: RelayIdentity;
    required: readonly Destination[];
    inbound?: boolean;
  }): OpenRelay;
  /** 열린 연결을 지금 정책으로 다시 보고 허용되지 않는 것을 닫는다(사용자가 목록을 줄였을 때). 새 연결과 같은 규칙으로 이름·포트·연결한 주소를 본다. */
  revalidate(organizationId?: string): Promise<void>;
  /** 모든 중계를 닫고 정책을 뗀다. 다시 붙이기 전에는 열지 않는다(서버 재시작 때 정책이 준비되기 전 실행 시작 거부). */
  close(): Promise<void>;
};

/** 중계가 조직 도구 요청에 덮어써 넣는 신원 머리. 서버가 토큰의 실행 시도·조직과 대조한다. */
export const relayIdentityHeaders = {
  run: "x-babojubot-relay-run",
  organization: "x-babojubot-relay-organization",
} as const;

/** 컨테이너 안 프로그램이 쓰는 이름. docker/runner/relay.mjs와 같아야 한다. */
export const relaySockets = {
  egress: "egress.sock",
  tools: "tools.sock",
  inbound: "inbound.sock",
} as const;

type Tunnel = {
  host: string;
  port: number;
  address: string;
  sockets: net.Socket[];
  /** 목적지 답을 넘기는 연결이면, 중계가 스스로 이 연결을 끊을 때(정책 변경·중계 닫기) 소켓보다 먼저 부를 그 답의 취소. */
  cancel?: () => void;
};

type Relay = {
  identity: RelayIdentity;
  required: readonly Destination[];
  tunnels: Set<Tunnel>;
  /** 정책을 다시 볼 때마다 오른다. 판정 중에 바뀌었는지 연결이 확인한다. */
  revision: number;
  close(): Promise<void>;
};

function hostAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => entry.address.split("%")[0]!);
}

async function resolveAll(host: string) {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function refusalHead(reason: EgressRefusal, status = 403) {
  const body = `${egressRefusalMessages[reason]}\n`;
  return (
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : "Forbidden"}\r\n` +
    `X-BaboJUBot-Refusal: ${reason}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body
  );
}

/** `host:port`, `[v6]:port`. */
function splitAuthority(value: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
  if (!match) return null;
  return { host: (match[1] ?? match[2])!, port: Number(match[3]) };
}

/** 확인한 주소에 차례로 붙는다. 이름을 다시 풀지 않는다. 붙은 주소를 함께 돌려준다. */
function dial(
  addresses: string[],
  port: number
): Promise<{ socket: net.Socket; address: string; release: () => void }> {
  return new Promise((resolve, reject) => {
    const next = (index: number, last?: Error) => {
      if (index >= addresses.length)
        return reject(last ?? new Error("no address"));
      const address = addresses[index]!;
      const socket = net.connect({ host: address, port });
      socket.setTimeout(15_000, () => socket.destroy(new Error("timeout")));
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeAllListeners("error");
        // 돌려주는 소켓에는 늘 오류 리스너가 있다. 부르는 쪽이 기다리는 사이 난 오류는 이 연결만 닫는다.
        // 부르는 쪽은 자기 처리를 따로 붙이고, 소켓의 오류를 모두 맡게 되면 `release`로 이 처리를 뗀다.
        const release = closeOnError(
          socket,
          "a relay connection to an allowed destination"
        );
        resolve({ socket, address, release });
      });
      socket.once("error", (error) => next(index + 1, error));
    };
    next(0);
  });
}

/**
 * 소켓 오류로 그 연결만 닫는다. 상대가 끊어 난 오류는 답이고, 그 밖의 오류는 무엇이 실패했는지 남긴다. 이 처리를 떼는 함수를
 * 돌려준다(소켓을 넘겨받은 쪽이 오류를 맡을 때).
 */
function closeOnError(socket: net.Socket, what: string): () => void {
  const onError = (error: Error) => {
    if (!isDisconnect(error))
      console.warn(
        `[provider] ${what} failed; the connection is closed (${failureCode(error)})`
      );
    socket.destroy();
  };
  socket.on("error", onError);
  return () => socket.off("error", onError);
}

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function createRelayHub(): RelayHub {
  let hooks: RelayHooks | undefined;
  const relays = new Set<Relay>();

  const refuse = (
    relay: Relay,
    host: string,
    port: number,
    reason: EgressRefusal
  ) => {
    /* 알리기 실패는 거부를 바꾸지 않는다. */
    continueAfterFailure(
      () => hooks?.refused?.(relay.identity, { host, port, reason }),
      (error) =>
        console.warn(
          `[provider] a relay refusal could not be reported; the refusal stands (${failureCode(error)})`
        )
    );
  };

  /** 확인한 주소에 붙는다. 붙지 못하면 원인을 남기고 `undefined`(부르는 쪽이 502로 답한다). */
  const dialAllowed = (addresses: string[], port: number) =>
    orIfProbeFailed(
      () => dial(addresses, port),
      undefined,
      (error) =>
        console.warn(
          `[provider] the relay could not connect to an allowed destination; it answered 502 (${failureCode(error)})`
        )
    );

  const rulesFor = (
    relay: Relay,
    research: readonly Destination[]
  ): EgressRules => ({
    destinations: [...relay.required, ...research],
    protectedPorts: hooks?.protectedPorts() ?? [],
    hostAddresses: hostAddresses(),
  });

  /** 다시 볼 때의 지금 규칙. 연구 목록을 읽지 못하거나 붙인 것이 없으면 필수 목적지만 쓴다. */
  const currentRules = async (relay: Relay): Promise<EgressRules> => {
    const research =
      (await continueAfterFailure(
        async () => (await hooks?.research(relay.identity)) ?? [],
        (error) =>
          console.warn(
            `[provider] the research destinations could not be read; only required destinations are allowed (${failureCode(error)})`
          )
      )) ?? [];
    return rulesFor(relay, research);
  };

  /** 열린 연결 하나를 지금 규칙에 맞지 않아 회수한다. 소켓을 닫고 이유를 알린다. */
  const revoke = (relay: Relay, tunnel: Tunnel) => {
    relay.tunnels.delete(tunnel);
    tunnel.cancel?.();
    for (const socket of tunnel.sockets) socket.destroy();
    refuse(relay, tunnel.host, tunnel.port, "policy_changed");
  };

  const decide = async (relay: Relay, host: string, port: number) => {
    const research = await continueAfterFailure(
      () => hooks!.research(relay.identity),
      (error) =>
        console.warn(
          `[provider] the research destinations could not be read; the connection is refused (${failureCode(error)})`
        )
    );
    if (!research)
      return { allowed: false as const, reason: "policy_unavailable" as const };
    return decideDestination(rulesFor(relay, research), host, port, resolveAll);
  };

  const egressServer = (relay: Relay) => {
    const server = http.createServer();
    server.on("connect", (req, client: net.Socket, head: Buffer) => {
      closeOnError(client, "a relay client connection");
      const target = splitAuthority(req.url ?? "");
      if (!target) {
        client.end(refusalHead("protocol_not_supported", 400));
        return;
      }
      const revision = relay.revision;
      void decide(relay, target.host, target.port).then(async (decision) => {
        if (!decision.allowed) {
          refuse(relay, target.host, target.port, decision.reason);
          client.end(refusalHead(decision.reason));
          return;
        }
        const dialed = await dialAllowed(decision.addresses, target.port);
        if (!dialed) {
          client.end(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
          );
          return;
        }
        const { socket: upstream, address } = dialed;
        if (client.destroyed) return void upstream.destroy();
        const tunnel: Tunnel = {
          host: target.host,
          port: target.port,
          address,
          sockets: [client, upstream],
        };
        relay.tunnels.add(tunnel);
        const end = () => {
          relay.tunnels.delete(tunnel);
          client.destroy();
          upstream.destroy();
        };
        upstream.on("error", end).on("close", end);
        client.on("close", end);
        // 판정 뒤 정책이 바뀌었으면 이미 등록한 연결도 새 규칙으로 다시 본다.
        if (relay.revision !== revision) {
          const ok = allowsConnection(
            await currentRules(relay),
            tunnel.host,
            tunnel.port,
            tunnel.address
          );
          if (!relay.tunnels.has(tunnel)) return;
          if (!ok) {
            relay.tunnels.delete(tunnel);
            refuse(relay, tunnel.host, tunnel.port, "policy_changed");
            upstream.destroy();
            client.end(refusalHead("policy_changed"));
            return;
          }
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    });
    server.on("request", (req, res) => {
      const url = orIfUnreadable(() => new URL(req.url ?? ""), undefined);
      if (!url || url.protocol !== "http:") {
        res.writeHead(400, {
          "x-babojubot-refusal": "protocol_not_supported",
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
        });
        res.end(egressRefusalMessages.protocol_not_supported);
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const port = Number(url.port || 80);
      const revision = relay.revision;
      void decide(relay, host, port).then(async (decision) => {
        if (!decision.allowed) {
          refuse(relay, host, port, decision.reason);
          res.writeHead(403, {
            "x-babojubot-refusal": decision.reason,
            "content-type": "text/plain; charset=utf-8",
            connection: "close",
          });
          res.end(egressRefusalMessages[decision.reason]);
          return;
        }
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(req.headers))
          if (!hopByHop.has(name) && value !== undefined) headers[name] = value;
        const badGateway = () => {
          if (!res.headersSent) res.writeHead(502, { connection: "close" });
          res.end();
        };
        // CONNECT와 같이 확인한 주소에 차례로 붙는다(이름을 다시 풀지 않는다).
        const dialed = await dialAllowed(decision.addresses, port);
        if (!dialed) return void badGateway();
        const socket = dialed.socket;
        const tunnel: Tunnel = {
          host,
          port,
          address: dialed.address,
          sockets: [req.socket, socket],
        };
        relay.tunnels.add(tunnel);
        const done = () => relay.tunnels.delete(tunnel);
        // 판정 뒤 정책이 바뀌었으면 이미 등록한 연결도 새 규칙으로 다시 본다.
        if (relay.revision !== revision) {
          const ok = allowsConnection(
            await currentRules(relay),
            tunnel.host,
            tunnel.port,
            tunnel.address
          );
          if (!relay.tunnels.has(tunnel)) {
            socket.destroy();
            return void badGateway();
          }
          if (!ok) {
            relay.tunnels.delete(tunnel);
            refuse(relay, host, port, "policy_changed");
            socket.destroy();
            if (!res.headersSent) {
              res.writeHead(403, {
                "x-babojubot-refusal": "policy_changed",
                "content-type": "text/plain; charset=utf-8",
                connection: "close",
              });
              res.end(egressRefusalMessages.policy_changed);
            }
            return;
          }
        }
        // 기다리는 사이 목적지가 끊었으면 이 요청만 502로 끝낸다.
        if (socket.destroyed) {
          done();
          return void badGateway();
        }
        // 목적지 쪽 요청 하나의 끝(답 전의 연결 실패, 답 중간의 끊김·형식 오류, 요청자의 떠남, 중계의 취소)은 답 흐름 한 곳이 한 번
        // 맡는다(`passAnswer`).
        const outgoing = http.request(
          {
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers,
            setHost: false,
            createConnection: () => socket,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            answer.pass([{ stream: response, by: "upstream" }]);
          }
        );
        const answer = passAnswer<never>(outgoing, res, (end) => {
          done();
          switch (end.by) {
            // 요청자가 끝까지 받았거나 먼저 떠났거나, 중계가 스스로 끊었다(정책 변경·중계 닫기). 모두 답이다. 이 중계는 목적지의 답을
            // 거부하지 않는다(`refused` 없음).
            case "complete":
            case "requester":
            case "refused":
            case "cancelled":
              return;
            case "upstream":
              if (res.headersSent) {
                console.warn(
                  `[provider] an allowed destination's answer broke off in the relay (${failureCode(end.error)})`
                );
                return;
              }
              console.warn(
                `[provider] the relay could not forward a request to an allowed destination; it answered 502 (${failureCode(end.error)})`
              );
              badGateway();
              return;
            default: {
              const unhandled: never = end;
              throw new Error(
                `unhandled answer end ${JSON.stringify(unhandled)}`
              );
            }
          }
        });
        // 중계가 이 연결을 끊을 때(정책 변경·중계 닫기) 소켓을 닫기 전에 답 흐름을 취소로 끝낸다.
        tunnel.cancel = answer.cancel;
        // 요청이 소켓을 받으면(Node 문서 `'socket'`) 그 소켓의 오류는 요청의 오류로 답 흐름 한 곳이 알린다. 연결 단계의 처리를 뗀다.
        outgoing.once("socket", dialed.release);
        req.pipe(outgoing);
      });
    });
    server.on("upgrade", (_req, socket: net.Socket) =>
      socket.end(refusalHead("protocol_not_supported", 400))
    );
    server.on("clientError", (_error, socket) => socket.destroy());
    return server;
  };

  const toolsServer = (relay: Relay) =>
    http.createServer((req, res) => {
      req.headers[relayIdentityHeaders.organization] =
        relay.identity.organizationId;
      if (relay.identity.runId)
        req.headers[relayIdentityHeaders.run] = relay.identity.runId;
      else delete req.headers[relayIdentityHeaders.run];
      hooks!.tools(req, res);
    });

  return {
    attach(value) {
      hooks = value;
    },
    open({ identity, required, inbound }) {
      if (!hooks) throw new Error("isolated run relay is not ready");
      const directory = mkdtempSync(path.join(os.tmpdir(), "babojubot-relay-"));
      /** 이 중계가 얻은 서버와 그 듣기 시도의 끝(들었는가). 서버는 `own` 하나만 얻고, 닫기가 시작된 뒤로는 늘지 않는다. */
      const owned: { server: net.Server; listened: Promise<boolean> }[] = [];
      const idle: net.Socket[] = [];
      const waiting: ((socket: net.Socket) => void)[] = [];
      const loose = new Set<net.Socket>();
      let local: Promise<string> | undefined;
      let ended: Promise<void> | undefined;
      /** 닫기가 시작되었는가. 닫기의 첫 동기 구간에서 세우고, 그 뒤 `own`은 새 서버를 만들지 않는다. */
      let closing = false;
      const closed = () =>
        Object.assign(
          new Error("the relay is closing; no new server is opened"),
          { code: "relay_closed" }
        );
      const relay: Relay = {
        identity: { ...identity },
        required: [...required],
        tunnels: new Set(),
        revision: 0,
        close: () =>
          (ended ??= (async () => {
            closing = true;
            for (const tunnel of relay.tunnels) {
              tunnel.cancel?.();
              for (const socket of tunnel.sockets) socket.destroy();
            }
            relay.tunnels.clear();
            for (const socket of [...idle, ...loose]) socket.destroy();
            // 폴더에는 서버들의 소켓 파일이 있다. 모든 서버가 닫혔음을 확인한 뒤에만 지우고, 하나라도 확인하지 못하면 폴더를 남기고
            // 그 원인으로 실패한다(지우면 아직 듣는 서버가 남은 채로 닫힌 것처럼 보인다). 서버마다 듣기 시도가 끝난 것을 본 뒤에 닫는다
            // (`listenAttempt`: 그 전에 닫으면 듣기 시도가 끝나지 않는다). 듣지 못한 서버는 닫을 것이 없다(듣기 오류는 그 서버를 얻은
            // 쪽 — `ready`·`inboundOrigin` — 이 받았다). 들은 서버의 닫기 오류는 무엇이든 실패다.
            const failures = await attemptEach(
              owned.map(({ server, listened }) => async () => {
                if (!(await listened)) return;
                await new Promise<void>((resolve, reject) => {
                  (server as http.Server).closeAllConnections?.();
                  server.close((error) => {
                    if (error)
                      reject(
                        Object.assign(
                          new Error(
                            `a relay server did not close (${failureCode(error)})`,
                            { cause: error }
                          ),
                          { code: failureCode(error) }
                        )
                      );
                    else resolve();
                  });
                });
              })
            );
            relays.delete(relay);
            // 실패가 하나여도 남긴 폴더의 위치가 거절에 남도록 늘 감싼다. 원인은 cause에 그대로 있다. 거절을 받는 쪽은 코드만
            // 기록하므로(process.ts), 남긴 위치는 여기서 경고로도 남긴다(남은 폴더를 거두는 곳은 없다).
            if (failures.length > 0) {
              console.warn(
                `[provider] the isolated run relay's servers did not all close; its folder is kept at ${directory} (${failures.map(failureCode).join(", ")})`
              );
              // 코드만 남기는 쪽(process.ts·실행 시도 폴더의 원인)도 무엇이 실패했는지 알도록 이름 붙은 코드를 둔다.
              throw Object.assign(
                new Error(
                  `the relay could not be closed; its folder ${directory} is kept`,
                  {
                    cause: combinedFailure(
                      failures,
                      "the relay's servers did not close"
                    ),
                  }
                ),
                { code: "relay_folder_kept" }
              );
            }
            rmSync(directory, { recursive: true, force: true });
          })()),
      };
      relays.add(relay);
      /**
       * 이 중계의 서버 하나를 얻는다(중계의 서버는 모두 이 길로). 닫기가 시작됐으면 만들지 않고 `relay_closed`로 거절한다. 만든 서버는
       * 듣기 전에(같은 동기 구간) 소유 목록에 넣어 닫기가 그 듣기 시도의 끝을 보고 닫게 한다. 듣기가 시작되면 이행하되, 그때 닫기가
       * 시작됐으면 `relay_closed`로 거절한다(그 서버는 닫기가 닫는다). 듣기 오류면 그 오류로 거절한다.
       */
      const own = async (
        make: () => net.Server,
        listen: (server: net.Server) => void
      ) => {
        if (closing) throw closed();
        const server = make();
        // 받은 연결은 닫기가 끊는다. 닫기가 시작된 뒤 받은 연결은 바로 끊는다(서버는 차례로 닫히므로 앞 서버를 닫는 동안 뒤 서버가
        // 연결을 받을 수 있고, net 서버의 닫기는 받은 연결이 모두 끝나야 끝난다).
        server.on("connection", (socket: net.Socket) => {
          if (closing) return void socket.destroy();
          loose.add(socket);
          socket.on("close", () => loose.delete(socket));
        });
        // 기록은 듣기를 부르기 전에 넣는다. 듣기를 부르는 동안 닫기가 시작되어도 닫기가 이 서버의 듣기 시도 끝을 기다린다.
        const listened = Promise.withResolvers<boolean>();
        owned.push({ server, listened: listened.promise });
        try {
          await listenAttempt(server, () => listen(server));
        } catch (error) {
          listened.resolve(false);
          throw error;
        }
        listened.resolve(true);
        if (closing) throw closed();
        return server;
      };
      const listen = (make: () => net.Server, name: string) =>
        own(make, (server) => server.listen(path.join(directory, name)));
      const ready = Promise.all([
        listen(() => egressServer(relay), relaySockets.egress),
        listen(() => toolsServer(relay), relaySockets.tools),
        ...(inbound
          ? [
              listen(
                () =>
                  net.createServer((socket) => {
                    closeOnError(socket, "an inbound relay connection");
                    const give = waiting.shift();
                    if (give) return give(socket);
                    idle.push(socket);
                    socket.once("close", () => {
                      const at = idle.indexOf(socket);
                      if (at >= 0) idle.splice(at, 1);
                    });
                  }),
                relaySockets.inbound
              ),
            ]
          : []),
      ]).then(() => {});
      // 준비 실패는 ready를 기다리는 쪽(실행 시도·격리 확인)도 받는다. 그쪽이 붙기 전에 실패해도 중계는 스스로 닫는다.
      // 닫기 실패는 나중에 닫는 쪽(실행 시도·격리 확인의 정리)이 같은 닫기에서 받는다.
      void continueAfterFailure(
        () => ready,
        (error) => {
          console.warn(
            `[provider] the isolated run relay could not open; closing it (${failureCode(error)})`
          );
          void settled(relay.close());
        }
      );
      const take = () =>
        new Promise<net.Socket>((resolve, reject) => {
          const socket = idle.shift();
          if (socket) return resolve(socket);
          const timer = setTimeout(() => {
            const at = waiting.indexOf(give);
            if (at >= 0) waiting.splice(at, 1);
            reject(new Error("container did not offer a connection"));
          }, 15_000);
          const give = (value: net.Socket) => {
            clearTimeout(timer);
            resolve(value);
          };
          waiting.push(give);
        });
      return {
        directory,
        ready,
        inboundOrigin() {
          if (!inbound) return Promise.reject(new Error("no inbound relay"));
          return (local ??= (async () => {
            await ready;
            const server = await own(
              () =>
                net.createServer((client) => {
                  closeOnError(client, "a local connection into the container");
                  client.pause();
                  take().then(
                    (reverse) => {
                      if (client.destroyed) return void reverse.destroy();
                      reverse.on("close", () => client.destroy());
                      client.on("close", () => reverse.destroy());
                      client.pipe(reverse).pipe(client);
                      client.resume();
                    },
                    (error: unknown) => {
                      console.warn(
                        `[provider] no reverse relay connection was free; closing the inbound connection (${failureCode(error)})`
                      );
                      client.destroy();
                    }
                  );
                }),
              (server) => server.listen(0, "127.0.0.1")
            );
            return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
          })());
        },
        close: () => relay.close(),
      };
    },
    async revalidate(organizationId) {
      await Promise.all(
        [...relays]
          .filter(
            (relay) =>
              organizationId === undefined ||
              relay.identity.organizationId === organizationId
          )
          .map(async (relay) => {
            // 정책을 다시 보기 시작했음을 먼저 알린다. 판정 중이던 연결도 이 값을 보고 새 규칙으로 다시 본다.
            relay.revision++;
            const rules = await currentRules(relay);
            for (const tunnel of [...relay.tunnels]) {
              if (
                !allowsConnection(
                  rules,
                  tunnel.host,
                  tunnel.port,
                  tunnel.address
                )
              )
                revoke(relay, tunnel);
            }
          })
      );
    },
    async close() {
      hooks = undefined;
      await attemptAll(
        [...relays].map((relay) => () => relay.close()),
        "the relays could not be closed"
      );
    },
  };
}
