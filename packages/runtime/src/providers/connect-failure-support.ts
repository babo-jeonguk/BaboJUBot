import type * as httpModule from "node:http";
import type * as netModule from "node:net";
import { vi } from "vitest";

// 시험이 정한 포트로 가는 연결 하나를 정한 오류로 실패시킨다. 닫은 포트에 다시 붙는 실제 연결은 그 사이 다른 프로그램이 그
// 번호를 잡으면 제품 결함 없이 실패한다(#294 외부 리뷰 2회차 STD-2). 저장소가 OS 호출 실패를 넣는 방식(`vi.mock`의 모듈 대역)으로
// 연결 경계(`net.connect`, `http.request`)를 감싼다. 정한 포트(`refusing.port`)로 오는 연결만 대역하고, 불린 주소·포트를
// `refusing.dialed`에 남긴다. 그 밖의 연결(시험이 띄운 listener, 파일 소켓)은 진짜로 간다.
//
// 시험 파일에서: `vi.mock("node:net", async (importOriginal) => (await import("./connect-failure-support.ts")).failingNet(await importOriginal()))`
// (`http.request`로 붙는 코드면 `node:http`와 `failingHttp`). 시험마다 `refusing.refuse`를 정하고 끝나면 `resetRefusing()`으로 푼다.
//
// 같은 대역은 서버 경계(`net.createServer`·`http.createServer`)도 감싼다. 시험이 `serverFaults`를 정하면, 대역이 만든 서버의 다음 듣기
// 하나나 정한 파일 소켓 경로에서 듣는 서버의 닫기가 그 오류로 실패한다(객체·prototype의 메서드를 바꾸지 않고, 대역이 만든 서버만 다르게 답한다).
// 정한 것이 없으면 진짜 서버와 같다. 시험이 끝나면 `resetRefusing()`이 함께 푼다.

export const refusing = {
  /** 실패시킬 포트와 오류 코드. 없으면 아무 연결도 대역하지 않는다. */
  refuse: undefined as { port: number; code: string } | undefined,
  /** 대역한 연결마다 `{ host, port }`로 불린다. */
  dialed: vi.fn<(target: { host: unknown; port: number }) => void>(),
};

/** 서버 경계의 결함. 정한 것이 없으면 대역이 만든 서버도 진짜와 같다. */
export const serverFaults = {
  /** 대역이 만든 서버의 다음 듣기 하나를 이 코드의 오류(`error` 이벤트)로 끝낸다. 그 서버는 듣지 않는다. */
  listen: undefined as { code: string } | undefined,
  /** 실패시킨 듣기가 받은 주소. */
  refusedListen: vi.fn<(address: unknown) => void>(),
  /**
   * 파일 소켓 경로로 들은 서버 가운데 그 경로가 `at`에 맞는 서버의 닫기가 실제로 닫은 뒤 이 코드로 실패를 알린다(닫기 콜백의 오류).
   * 포트로 들은 서버는 대상이 아니다. 닫을 것이 없던 서버의 원래 오류(ERR_SERVER_NOT_RUNNING)는 그대로 넘긴다. 결함이 실제로 걸렸는지는
   * `failedClose`로 확인한다.
   */
  close: undefined as
    | {
        code: string;
        at: (address: string) => boolean;
        /** 실패를 알린 직후(서버는 이미 닫힘) 그 주소로 부른다. 시험마다 비우는 `failedClose`보다 오래 남길 기록에 쓴다. */
        failed?: (address: string) => void;
      }
    | undefined,
  /** 실패를 알린 닫기의 서버가 들은 주소. */
  failedClose: vi.fn<(address: string) => void>(),
};

export function resetRefusing() {
  refusing.refuse = undefined;
  refusing.dialed.mockReset();
  serverFaults.listen = undefined;
  serverFaults.refusedListen.mockReset();
  serverFaults.close = undefined;
  serverFaults.failedClose.mockReset();
}

const codeError = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

/** 대역이 만드는 서버: `serverFaults`가 정한 듣기·닫기만 실패로 답하고, 그 밖에는 진짜 서버(`Base`)와 같다. */
function faultyServer(Base: typeof netModule.Server) {
  return class extends Base {
    /** 이 서버가 들은 파일 소켓 경로. 닫기 결함의 대상을 고를 때 본다. 포트로 들은 서버는 없음이라 닫기 결함의 대상이 되지 않는다. */
    listenedAt: string | undefined;
    override listen(...args: unknown[]) {
      const fault = serverFaults.listen;
      const [address] = args;
      if (fault) {
        serverFaults.listen = undefined;
        serverFaults.refusedListen(address);
        process.nextTick(() =>
          this.emit("error", codeError("listen failed", fault.code))
        );
        return this;
      }
      this.listenedAt = typeof address === "string" ? address : undefined;
      return (super.listen as (...args: unknown[]) => this)(...args);
    }
    override close(callback?: (error?: Error) => void) {
      const fault = serverFaults.close;
      const at = this.listenedAt;
      if (!fault || at === undefined || !fault.at(at))
        return super.close(callback);
      return super.close((error?: Error) => {
        if (!error) {
          serverFaults.failedClose(at);
          fault.failed?.(at);
        }
        callback?.(error ?? codeError("close failed", fault.code));
      });
    }
  };
}

/** 대역 서버를 만드는 `createServer`. 인수는 진짜 `createServer`와 같이 받는다(선택 사항, 처리기). */
function creating(Server: typeof netModule.Server) {
  return (...args: ConstructorParameters<typeof netModule.Server>) =>
    new Server(...args);
}

/** `options`가 정한 포트로 가는 연결이면 그 실패를 돌려준다. 실제 연결에서 나오는 오류와 같은 모양(`code`·`syscall`)이다. */
function refusal(options: unknown): Error | undefined {
  const refuse = refusing.refuse;
  if (
    !refuse ||
    typeof options !== "object" ||
    options === null ||
    !("port" in options) ||
    Number(options.port) !== refuse.port
  )
    return undefined;
  const host =
    "host" in options
      ? options.host
      : "hostname" in options
        ? options.hostname
        : undefined;
  refusing.dialed({ host, port: Number(options.port) });
  return Object.assign(
    new Error(`connect ${refuse.code} ${String(host)}:${refuse.port}`),
    { code: refuse.code, syscall: "connect" }
  );
}

/** 연결을 시작하지 않고 `failure`로 끝나는 소켓. 실제 연결 실패처럼 다음 차례에 `error`와 `close`를 낸다. */
function failedSocket(real: typeof netModule, failure: Error) {
  const socket = new real.Socket();
  process.nextTick(() => socket.destroy(failure));
  return socket;
}

/** `node:net` 대역: 정한 포트로 가는 `connect`·`createConnection`을 실패시킨다. */
export function failingNet(real: typeof netModule) {
  const passThrough = real.connect as (...args: unknown[]) => netModule.Socket;
  const connect = ((...args: unknown[]) => {
    const failure = refusal(args[0]);
    return failure ? failedSocket(real, failure) : passThrough(...args);
  }) as typeof real.connect;
  const Server = faultyServer(real.Server);
  const createServer = creating(Server) as typeof real.createServer;
  const replaced = {
    connect,
    createConnection: connect,
    Server,
    createServer,
  };
  return { ...real, ...replaced, default: { ...real, ...replaced } };
}

/** `node:http` 대역: 정한 포트로 가는 `request`를 그 연결의 실패로 끝낸다(요청은 진짜 ClientRequest가 소켓 오류를 알린다). */
export function failingHttp(real: typeof httpModule, net: typeof netModule) {
  const passThrough = real.request as (
    ...args: unknown[]
  ) => httpModule.ClientRequest;
  const request = ((...args: unknown[]) => {
    const [options, ...rest] = args;
    const failure = refusal(options);
    if (!failure) return passThrough(...args);
    return passThrough(
      {
        ...(options as httpModule.RequestOptions),
        createConnection: () => failedSocket(net, failure),
      },
      ...rest
    );
  }) as typeof real.request;
  const Server = faultyServer(real.Server);
  const createServer = creating(Server) as typeof real.createServer;
  const replaced = { request, Server, createServer };
  return { ...real, ...replaced, default: { ...real, ...replaced } };
}
