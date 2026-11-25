import { mkdtempSync, rmSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { setMaxListeners } from "node:events";
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
  type EgressDecision,
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
 * 중계 하나에는 수명 신호가 하나 있고 닫기의 첫 동기 구간에서 끝난다. 그 뒤로는 서버 듣기·받은 연결·목적지 연결을 시작하지 않는다
 * (받은 연결은 바로 끊는다). 진행 중인 목적지 연결은 끝낸다: 정책 조회·이름 풀이는 기다림을 끝내고(그 일의 결과는 버림), 연결 중
 * 소켓은 끊겨 다음 주소로 가지 않는다. 진행 중인 서버 듣기 시도는 끝내지 않고 그 끝(듣기 시작이나 듣기 오류)을 기다린다. 목적지 소켓은
 * 만드는 식에서, 서버는 만드는 동기 구간에서(듣기 전), 받은 연결은 받는 처리기에서 중계가 맡는다. 닫기는 진행 중 획득의 끝과 끊은 연결의 닫힘을 본 뒤 서버를 닫고, 모든 서버가 닫혔음을 확인했을 때만
 * 폴더를 지운다(아니면 폴더를 남기고 실패한다, #286 PR #299 외부 리뷰 1·2회차). 역방향 연결 기다림(`take`)은 이 신호를 받지 않는다:
 * 기다리는 손님 연결은 닫기가 끊지만 그 기다림은 15초 타이머나 다음 역방향 연결로 끝나고, 닫기 뒤 받은 손님 연결도 기다림을
 * 시작한다(닫기 뒤 남을 수 있다).
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

/** 이 중계가 지금 붙은 정책에서 읽은 것. 떼어졌거나 읽지 못한 칸은 "unreadable"(판정은 읽은 쪽이 아니라 쓰는 쪽이 한다). */
type Policy = {
  research: readonly Destination[] | "unreadable";
  protectedPorts: readonly number[] | "unreadable";
};

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
  /** 정책 다시 보기와 답 취소를 위한 열린 연결의 기록. 소켓의 소유는 `hold`가 맡는다. */
  tunnels: Set<Tunnel>;
  /** 정책을 다시 볼 때마다 오른다. 판정 중에 바뀌었는지 연결이 확인한다. */
  revision: number;
  close(): Promise<void>;
  /**
   * 진행 중 획득 하나(서버 듣기 시도, 목적지 연결)를 한다. 닫기가 시작됐으면 시작하지 않고 거절한다. 시작하기 전(같은 동기 구간)에
   * 그 끝을 닫기가 볼 목록에 넣는다. `start`가 이행했을 때 닫기가 시작됐으면 거절한다(얻은 것은 이미 중계가 맡아 닫기가 닫는다).
   * `start`의 거절은 그 원인 그대로 넘긴다.
   */
  acquire<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * 자원을 만들지 않는 기다림(정책 조회, 이름 풀이)을 한다. 닫기가 시작됐으면 시작하지 않고 거절하고, 기다리는 사이 시작되면
   * 기다림을 끝내 거절한다. 그 일은 멈출 수 없어(서버의 조회, `getaddrinfo`) 결과를 버리고, 그 뒤 실패하면 원인을 경고로 남긴다.
   */
  whileOpen<T>(start: () => Promise<T>): Promise<T>;
  /** 소켓을 맡는다(만드는 식·받는 처리기에서). 닫기가 시작됐으면 바로 끊는다. 닫기가 끊고 그 닫힘을 본다. */
  hold(socket: net.Socket): net.Socket;
  /** 이 거절이 이 중계의 닫기 때문인가(`acquire`·`whileOpen`·`dial`이 닫기 뒤 내는 거절은 모두 같은 이유 객체). */
  closedBy(error: unknown): boolean;
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

/** HTTP 답으로 거부한다(`refusalHead`의 답 객체 판). 머리에 이유, 본문은 사용자 안내, 연결은 닫는다. */
function respondRefusal(
  res: http.ServerResponse,
  reason: EgressRefusal,
  status = 403
) {
  res.writeHead(status, {
    "x-babojubot-refusal": reason,
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  res.end(egressRefusalMessages[reason]);
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

/**
 * 확인한 주소에 차례로 붙는다. 이름을 다시 풀지 않는다. 붙은 주소를 함께 돌려준다. 주소마다 붙기 전에(남은 주소를 보기 전에) 중계의
 * 수명 신호를 보고, 닫기가 시작됐으면 붙지 않고 그 이유로 거절한다(재시도도 같다). 소켓은 `open`이 만드는 같은 식에서 중계가 맡는다.
 * 시도의 끝은 `close`로 받는다(닫기가 오류 없이 끊은 연결 중 소켓도 끝난다). 그 시도의 오류는 다음 시도에 원인으로 넘긴다.
 */
function dial(
  addresses: string[],
  port: number,
  signal: AbortSignal,
  open: (address: string) => net.Socket
): Promise<{ socket: net.Socket; address: string; release: () => void }> {
  return new Promise((resolve, reject) => {
    const next = (index: number, last?: Error) => {
      if (signal.aborted) return reject(signal.reason as Error);
      if (index >= addresses.length)
        return reject(last ?? new Error("no address"));
      const address = addresses[index]!;
      const socket = open(address);
      socket.setTimeout(15_000, () => socket.destroy(new Error("timeout")));
      let failure: Error | undefined;
      const onError = (error: Error) => {
        failure = error;
      };
      const onClose = () => next(index + 1, failure ?? last);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("connect", () => {
        socket.setTimeout(0);
        // 이 시도의 두 처리기만 뗀다(중계가 맡은 `close` 처리기는 남긴다).
        socket.off("error", onError);
        socket.off("close", onClose);
        // 돌려주는 소켓에는 늘 오류 리스너가 있다. 부르는 쪽이 기다리는 사이 난 오류는 이 연결만 닫는다.
        // 부르는 쪽은 자기 처리를 따로 붙이고, 소켓의 오류를 모두 맡게 되면 `release`로 이 처리를 뗀다.
        const release = closeOnError(
          socket,
          "a relay connection to an allowed destination"
        );
        resolve({ socket, address, release });
      });
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

  /**
   * 지금 붙은 정책을 읽는다(정책 읽기 한 자리). 정책을 한 번 잡아 보호 포트와 연구 목록을 같은 정책에서 읽는다. 떼어졌거나 읽지 못한
   * 칸은 "unreadable"이고, 그 판정(새 연결은 거부, 다시 보기는 좁힘)은 쓰는 쪽이 한다. 경고는 무엇을 못 읽었는지만 남긴다.
   */
  const policyOf = async (relay: Relay): Promise<Policy> => {
    const current = hooks;
    if (!current) {
      console.warn("[provider] the relay's policy is detached");
      return { research: "unreadable", protectedPorts: "unreadable" };
    }
    const protectedPorts =
      continueAfterFailure(
        () => current.protectedPorts(),
        (error) =>
          console.warn(
            `[provider] the protected ports could not be read (${failureCode(error)})`
          )
      ) ?? "unreadable";
    const research =
      (await continueAfterFailure(
        () => current.research(relay.identity),
        (error) =>
          console.warn(
            `[provider] the research destinations could not be read (${failureCode(error)})`
          )
      )) ?? "unreadable";
    return { research, protectedPorts };
  };

  const rulesFor = (
    relay: Relay,
    research: readonly Destination[],
    protectedPorts: EgressRules["protectedPorts"]
  ): EgressRules => ({
    destinations: [...relay.required, ...research],
    protectedPorts,
    hostAddresses: hostAddresses(),
  });

  /**
   * 다시 볼 때의 지금 규칙. 모름을 허용으로 바꾸지 않는다: 연구 목록을 읽지 못하면 필수 목적지만, 보호 포트를 읽지 못하면 이 컴퓨터의
   * 모든 포트를 보호한다("all").
   */
  const currentRules = async (relay: Relay): Promise<EgressRules> => {
    const policy = await policyOf(relay);
    return rulesFor(
      relay,
      policy.research === "unreadable" ? [] : policy.research,
      policy.protectedPorts === "unreadable" ? "all" : policy.protectedPorts
    );
  };

  /** 열린 연결 하나를 지금 규칙에 맞지 않아 회수한다. 소켓을 닫고 이유를 알린다. */
  const revoke = (relay: Relay, tunnel: Tunnel) => {
    relay.tunnels.delete(tunnel);
    tunnel.cancel?.();
    for (const socket of tunnel.sockets) socket.destroy();
    refuse(relay, tunnel.host, tunnel.port, "policy_changed");
  };

  /**
   * 목적지 연결 획득(CONNECT와 HTTP가 지나는 경계 하나). 중계의 획득(`acquire`)으로 정책 조회 → 판정(이름 풀이) → 주소마다 연결을
   * 한다. 조회와 판정은 따로 `whileOpen`으로 기다려, 닫기 뒤에 끝난 조회는 이름 풀이를 시작하지 않는다. 연결은 붙기 전에 수명 신호를
   * 본다(`dial`). 허용하지 않으면 알리고 그 이유를, 붙지 못하면 원인을 남기고 `dialed: undefined`(부르는 쪽이 502)를, 붙으면 그
   * 연결을 돌려준다. 닫기 때문인 거절은 접지 않고 넘긴다.
   */
  const destination = (relay: Relay, host: string, port: number) =>
    relay.acquire(async (signal) => {
      // 정책의 한 칸이라도 읽지 못하면 열지 않는다(모름을 허용으로 바꾸지 않음).
      const policy = await relay.whileOpen(() => policyOf(relay));
      const { research, protectedPorts } = policy;
      const decision: EgressDecision =
        research === "unreadable" || protectedPorts === "unreadable"
          ? { allowed: false, reason: "policy_unavailable" }
          : await relay.whileOpen(() =>
              decideDestination(
                rulesFor(relay, research, protectedPorts),
                host,
                port,
                resolveAll
              )
            );
      if (!decision.allowed) {
        refuse(relay, host, port, decision.reason);
        return { refused: decision.reason };
      }
      const dialed = await orIfProbeFailed(
        () =>
          dial(decision.addresses, port, signal, (address) =>
            relay.hold(net.connect({ host: address, port }))
          ),
        undefined,
        (error) => {
          if (relay.closedBy(error)) throw error;
          console.warn(
            `[provider] the relay could not connect to an allowed destination; it answered 502 (${failureCode(error)})`
          );
        }
      );
      return { dialed };
    });

  /** 중계의 연결 처리 하나. 닫기가 끊은 연결의 처리(이 중계의 닫기 때문인 거절)는 거기서 끝난다. 그 밖의 거절은 그대로 넘긴다. */
  const ifOpen = (relay: Relay, work: () => Promise<void>) =>
    work().catch((error: unknown) => {
      if (!relay.closedBy(error)) throw error;
    });

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
      void ifOpen(relay, async () => {
        const got = await destination(relay, target.host, target.port);
        if (got.refused !== undefined) {
          client.end(refusalHead(got.refused));
          return;
        }
        if (!got.dialed) {
          client.end(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
          );
          return;
        }
        const { socket: upstream, address } = got.dialed;
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
            await relay.whileOpen(() => currentRules(relay)),
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
        respondRefusal(res, "protocol_not_supported", 400);
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const port = Number(url.port || 80);
      const revision = relay.revision;
      void ifOpen(relay, async () => {
        const got = await destination(relay, host, port);
        if (got.refused !== undefined) {
          respondRefusal(res, got.refused);
          return;
        }
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(req.headers))
          if (!hopByHop.has(name) && value !== undefined) headers[name] = value;
        const badGateway = () => {
          if (!res.headersSent) res.writeHead(502, { connection: "close" });
          res.end();
        };
        const dialed = got.dialed;
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
        // 목적지 소켓이 닫히면 기록에서도 뺀다(CONNECT의 `end`와 같이). 답 흐름의 끝도 같은 지우기를 부른다.
        socket.once("close", done);
        // 판정 뒤 정책이 바뀌었으면 이미 등록한 연결도 새 규칙으로 다시 본다.
        if (relay.revision !== revision) {
          const ok = allowsConnection(
            await relay.whileOpen(() => currentRules(relay)),
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
              respondRefusal(res, "policy_changed");
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
      // 정책이 떼어졌으면(hub 닫기) 도구 경로로 넘기지 않고 거부한다.
      const current = hooks;
      if (!current) {
        respondRefusal(res, "policy_unavailable", 503);
        return;
      }
      current.tools(req, res);
    });

  return {
    attach(value) {
      hooks = value;
    },
    open({ identity, required, inbound }) {
      if (!hooks) throw new Error("isolated run relay is not ready");
      const directory = mkdtempSync(path.join(os.tmpdir(), "babojubot-relay-"));
      /** 이 중계의 수명. 닫기의 첫 동기 구간에서 끝나고, 그 뒤 획득은 시작하지 않으며 진행 중인 기다림은 끝난다. */
      const life = new AbortController();
      // 연결마다 기다림 하나가 이 신호를 듣는다(조회·판정). 동시 연결 수가 EventTarget 경고 기본값(10)을 넘을 수
      // 있어 그 경고를 끈다. 기다림은 끝날 때 늘 듣기를 뗀다.
      setMaxListeners(0, life.signal);
      /** 이 중계가 얻은 서버와 그 듣기가 시작되었는가. 서버는 `own` 하나로만 얻고, 닫기가 시작된 뒤로는 늘지 않는다. */
      const owned: { server: net.Server; listened: boolean }[] = [];
      /** 이 중계가 맡은 소켓(받은 연결, 연결 중·연결된 목적지 연결). 닫히면 빠진다. */
      const held = new Set<net.Socket>();
      /** 진행 중 획득의 끝 표시. 풀리기만 한다(거절하지 않음). */
      const pending = new Set<Promise<void>>();
      const idle: net.Socket[] = [];
      const waiting: ((socket: net.Socket) => void)[] = [];
      let local: Promise<string> | undefined;
      let ended: Promise<void> | undefined;
      const reason = () => life.signal.reason as Error;
      const relay: Relay = {
        identity: { ...identity },
        required: [...required],
        tunnels: new Set(),
        revision: 0,
        hold(socket) {
          if (life.signal.aborted) {
            socket.destroy();
            return socket;
          }
          held.add(socket);
          socket.once("close", () => held.delete(socket));
          return socket;
        },
        async acquire(start) {
          if (life.signal.aborted) throw reason();
          const end = Promise.withResolvers<void>();
          pending.add(end.promise);
          try {
            const value = await start(life.signal);
            if (life.signal.aborted) throw reason();
            return value;
          } finally {
            end.resolve();
            pending.delete(end.promise);
          }
        },
        whileOpen(start) {
          if (life.signal.aborted) return Promise.reject(reason());
          let work: ReturnType<typeof start>;
          try {
            work = start();
          } catch (error) {
            return Promise.reject(error as Error);
          }
          return new Promise((resolve, reject) => {
            const stop = () => reject(reason());
            life.signal.addEventListener("abort", stop, { once: true });
            work.then(
              (value) => {
                life.signal.removeEventListener("abort", stop);
                resolve(value);
              },
              (error: unknown) => {
                life.signal.removeEventListener("abort", stop);
                // 닫기가 끝낸 기다림의 일이 그 뒤 실패하면 원인을 남긴다(거절은 이미 닫기의 것으로 났다).
                if (life.signal.aborted)
                  console.warn(
                    `[provider] a relay lookup failed after its relay closed (${failureCode(error)})`
                  );
                reject(error);
              }
            );
          });
        },
        closedBy: (error) =>
          life.signal.aborted && error === life.signal.reason,
        close: () =>
          (ended ??= (async () => {
            // 첫 동기 구간: 수명을 끝내 뒤의 획득을 막고 진행 중인 조회·판정의 기다림을 끝낸다. 목적지 답 흐름을 소켓보다 먼저 취소로
            // 끝내고, 이 중계가 맡은 소켓(받은 연결, 연결 중·연결된 목적지 연결)을 모두 끊는다.
            life.abort(
              Object.assign(
                new Error("the relay is closing; nothing new is started"),
                { code: "relay_closed" }
              )
            );
            for (const tunnel of relay.tunnels) tunnel.cancel?.();
            relay.tunnels.clear();
            const sockets = [...held];
            for (const socket of sockets) socket.destroy();
            // 진행 중 획득(서버 듣기 시도, 목적지 연결)의 끝과 끊은 소켓의 닫힘을 본다. 목적지 연결은 끊긴 소켓의 `close`로 끝나 다음
            // 주소에 붙지 않는다(`dial`). 듣기 시도는 듣기 시작이나 듣기 오류로 끝난다(`listenAttempt`: 그 전에 닫으면 듣기 시도가
            // 끝나지 않는다). `held`에 있는 소켓은 아직 `close` 전이다(`close`에 빠진다).
            await Promise.all([
              ...pending,
              ...sockets.map(
                (socket) =>
                  new Promise<void>((resolve) =>
                    socket.once("close", () => resolve())
                  )
              ),
            ]);
            // 폴더에는 서버들의 소켓 파일이 있다. 모든 서버가 닫혔음을 확인한 뒤에만 지우고, 하나라도 확인하지 못하면 폴더를 남기고
            // 그 원인으로 실패한다(지우면 아직 듣는 서버가 남은 채로 닫힌 것처럼 보인다). 듣지 못한 서버는 닫을 것이 없다(듣기 오류는
            // 그 서버를 얻은 쪽 — `ready`·`inboundOrigin` — 이 받았다). 들은 서버의 닫기 오류는 무엇이든 실패다.
            const failures = await attemptEach(
              owned
                .filter(({ listened }) => listened)
                .map(({ server }) => async () => {
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
       * 이 중계의 서버 하나를 얻는다(중계의 서버는 모두 이 길로, 획득은 `acquire`). 닫기가 시작됐으면 만들지 않고 `relay_closed`로
       * 거절한다. 만든 서버는 듣기 전에(같은 동기 구간) 소유 목록에 넣어 닫기가 그 듣기 시도의 끝을 보고 닫게 한다. 듣기가 시작되면
       * 이행하되, 그때 닫기가 시작됐으면 `relay_closed`로 거절한다(그 서버는 닫기가 닫는다). 듣기 오류면 그 오류로 거절한다.
       */
      const own = (
        make: () => net.Server,
        listen: (server: net.Server) => void
      ) =>
        relay.acquire(async () => {
          const server = make();
          // 받은 연결은 중계가 맡는다. 닫기가 시작된 뒤 받은 연결은 바로 끊는다(서버는 차례로 닫히므로 앞 서버를 닫는 동안 뒤 서버가
          // 연결을 받을 수 있고, net 서버의 닫기는 받은 연결이 모두 끝나야 끝난다).
          server.on(
            "connection",
            (socket: net.Socket) => void relay.hold(socket)
          );
          const entry = { server, listened: false };
          owned.push(entry);
          await listenAttempt(server, () => listen(server));
          entry.listened = true;
          return server;
        });
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
          // 닫기가 시작되어 거절한 준비는 그 닫기가 맡는다.
          if (relay.closedBy(error)) return;
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
          .map((relay) =>
            // 닫는 중인 중계에는 정책 조회를 시작하지 않는다(그 연결은 닫기가 끊는다).
            ifOpen(relay, async () => {
              // 정책을 다시 보기 시작했음을 먼저 알린다. 판정 중이던 연결도 이 값을 보고 새 규칙으로 다시 본다.
              relay.revision++;
              const rules = await relay.whileOpen(() => currentRules(relay));
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
          )
      );
    },
    async close() {
      // 모든 중계의 닫기를 같은 동기 구간에서 먼저 시작한다(각 닫기의 첫 동기 구간에서 그 중계의 수명이 끝남). 그 뒤에 정책을 떼므로
      // 떼어진 정책을 만나는 중계 일은 시작되지 않는다. 동시에 진행하는 닫기는 만든 즉시 처리기를 달고(앞 닫기를 기다리는 사이 뒤
      // 닫기의 거절이 처리되지 않은 채 남지 않게), 그 결과는 `attemptAll`이 원래 promise에서 받는다.
      const closing = [...relays].map((relay) => relay.close());
      for (const ended of closing) void settled(ended);
      hooks = undefined;
      await attemptAll(
        closing.map((ended) => () => ended),
        "the relays could not be closed"
      );
    },
  };
}
