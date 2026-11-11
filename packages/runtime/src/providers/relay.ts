import { mkdtempSync, rmSync } from "node:fs";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  egressRefusalMessages,
  type Destination,
  type EgressRefusal,
} from "@babojubot/contracts";
import { decideDestination, isListed } from "./egress-policy.ts";

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
  /** 소켓을 모두 연 때. 실패하면 거부된다. */
  ready: Promise<void>;
  /** 컨테이너 안 서버로 가는 이 컴퓨터 loopback 주소(origin). `inbound`로 연 중계만. */
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
  /** 열린 연결을 지금 정책으로 다시 보고 허용되지 않는 것을 닫는다(사용자가 목록을 줄였을 때). */
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

type Tunnel = { host: string; port: number; sockets: net.Socket[] };

type Relay = {
  identity: RelayIdentity;
  required: readonly Destination[];
  tunnels: Set<Tunnel>;
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

/** 확인한 주소에 차례로 붙는다. 이름을 다시 풀지 않는다. */
function dial(addresses: string[], port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const next = (index: number, last?: Error) => {
      if (index >= addresses.length)
        return reject(last ?? new Error("no address"));
      const socket = net.connect({ host: addresses[index]!, port });
      socket.setTimeout(15_000, () => socket.destroy(new Error("timeout")));
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", (error) => next(index + 1, error));
    };
    next(0);
  });
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
    try {
      hooks?.refused?.(relay.identity, { host, port, reason });
    } catch {
      /* 알리기 실패는 거부를 바꾸지 않는다. */
    }
  };

  const decide = async (relay: Relay, host: string, port: number) => {
    let research: readonly Destination[];
    try {
      research = await hooks!.research(relay.identity);
    } catch {
      return { allowed: false as const, reason: "policy_unavailable" as const };
    }
    return decideDestination(
      {
        destinations: [...relay.required, ...research],
        protectedPorts: hooks!.protectedPorts(),
        hostAddresses: hostAddresses(),
      },
      host,
      port,
      resolveAll
    );
  };

  const egressServer = (relay: Relay) => {
    const server = http.createServer();
    server.on("connect", (req, client: net.Socket, head: Buffer) => {
      client.on("error", () => client.destroy());
      const target = splitAuthority(req.url ?? "");
      if (!target) {
        client.end(refusalHead("protocol_not_supported", 400));
        return;
      }
      void decide(relay, target.host, target.port).then(async (decision) => {
        if (!decision.allowed) {
          refuse(relay, target.host, target.port, decision.reason);
          client.end(refusalHead(decision.reason));
          return;
        }
        let upstream: net.Socket;
        try {
          upstream = await dial(decision.addresses, target.port);
        } catch {
          client.end(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
          );
          return;
        }
        if (client.destroyed) return void upstream.destroy();
        const tunnel: Tunnel = { ...target, sockets: [client, upstream] };
        relay.tunnels.add(tunnel);
        const end = () => {
          relay.tunnels.delete(tunnel);
          client.destroy();
          upstream.destroy();
        };
        upstream.on("error", end).on("close", end);
        client.on("close", end);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    });
    server.on("request", (req, res) => {
      let url: URL | undefined;
      try {
        url = new URL(req.url ?? "");
      } catch {
        url = undefined;
      }
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
      void decide(relay, host, port).then((decision) => {
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
        const tunnel: Tunnel = { host, port, sockets: [req.socket] };
        relay.tunnels.add(tunnel);
        const done = () => relay.tunnels.delete(tunnel);
        const failed = () => {
          done();
          if (!res.headersSent) res.writeHead(502, { connection: "close" });
          res.end();
        };
        // CONNECT와 같이 확인한 주소에 차례로 붙는다(이름을 다시 풀지 않는다).
        dial(decision.addresses, port).then((socket) => {
          tunnel.sockets.push(socket);
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
              response.pipe(res);
              response.on("end", done);
            }
          );
          outgoing.on("error", failed);
          req.pipe(outgoing);
        }, failed);
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
      const servers: net.Server[] = [];
      const idle: net.Socket[] = [];
      const waiting: ((socket: net.Socket) => void)[] = [];
      const loose = new Set<net.Socket>();
      let local: Promise<string> | undefined;
      let ended: Promise<void> | undefined;
      const relay: Relay = {
        identity: { ...identity },
        required: [...required],
        tunnels: new Set(),
        close: () =>
          (ended ??= (async () => {
            relays.delete(relay);
            for (const tunnel of relay.tunnels)
              for (const socket of tunnel.sockets) socket.destroy();
            relay.tunnels.clear();
            for (const socket of [...idle, ...loose]) socket.destroy();
            await Promise.all(
              servers.map(
                (server) =>
                  new Promise<void>((resolve) => {
                    (server as http.Server).closeAllConnections?.();
                    server.close(() => resolve());
                  })
              )
            );
            rmSync(directory, { recursive: true, force: true });
          })()),
      };
      relays.add(relay);
      const listen = (server: net.Server, name: string) => {
        servers.push(server);
        server.on("connection", (socket: net.Socket) => {
          loose.add(socket);
          socket.on("close", () => loose.delete(socket));
        });
        return new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path.join(directory, name), () => {
            server.off("error", reject);
            resolve();
          });
        });
      };
      const ready = Promise.all([
        listen(egressServer(relay), relaySockets.egress),
        listen(toolsServer(relay), relaySockets.tools),
        ...(inbound
          ? [
              listen(
                net.createServer((socket) => {
                  socket.on("error", () => socket.destroy());
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
      ready.catch(() => void relay.close());
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
            const server = net.createServer((client) => {
              client.on("error", () => client.destroy());
              client.pause();
              take().then(
                (reverse) => {
                  if (client.destroyed) return void reverse.destroy();
                  reverse.on("close", () => client.destroy());
                  client.on("close", () => reverse.destroy());
                  client.pipe(reverse).pipe(client);
                  client.resume();
                },
                () => client.destroy()
              );
            });
            servers.push(server);
            server.on("connection", (socket) => {
              loose.add(socket);
              socket.on("close", () => loose.delete(socket));
            });
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve());
            });
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
            let research: readonly Destination[] | undefined;
            try {
              research = await hooks?.research(relay.identity);
            } catch {
              research = undefined;
            }
            const allowed = [...relay.required, ...(research ?? [])];
            for (const tunnel of [...relay.tunnels]) {
              if (isListed(allowed, tunnel.host, tunnel.port)) continue;
              relay.tunnels.delete(tunnel);
              for (const socket of tunnel.sockets) socket.destroy();
              refuse(relay, tunnel.host, tunnel.port, "policy_changed");
            }
          })
      );
    },
    async close() {
      hooks = undefined;
      await Promise.all([...relays].map((relay) => relay.close()));
    },
  };
}
