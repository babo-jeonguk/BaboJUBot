// 이 파일은 `vi.mock("node:net")`·`vi.mock("node:http")` 대역의 factory가 불러온다. 그래서 이 파일과 이 파일이 불러오는 모듈 전체
// (@babojubot/process의 `test-cleanup.ts`·`test-support.ts`·`remove-folder.ts`, @babojubot/contracts)는 node:net·node:http를 형으로만
// 불러온다. 값으로 불러오면 대역이 만들어지기 전에 자기 자신을 기다려 시험이 불러오는 단계에서 멈춘다. 두 builtin을 값으로 쓰는 시험
// 도움은 이 경로 밖(`@babojubot/process/testing`의 `test-connect.ts` 등)에 둔다.
import type * as httpModule from "node:http";
import type * as netModule from "node:net";
import path from "node:path";
import { vi } from "vitest";
import { attemptAll, hasErrorCode } from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";
import { removeFolderWithin } from "@babojubot/process/test-cleanup";

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
  /**
   * 대역이 만든 서버가 실패시키지 않은 듣기를 시작한 직후(진짜 `listen`을 부른 같은 동기 구간) 그 첫 인수(주소·포트)와 서버로 부른다.
   * 시험이 듣기 시도가 끝나기 전의 순간을 상태로 잡거나, 제품이 만든 서버를 시험의 정리에 맡길 때 쓴다. 제품의 `listen` 호출 안에서
   * 불리므로 던지지 않는다(던지면 제품의 듣기 오류로 잡힌다).
   */
  listening: undefined as
    ((address: unknown, server: netModule.Server) => void) | undefined,
  /**
   * 파일 소켓 경로가 `at`에 맞는 서버의 닫기를 `until`이 이행할 때까지 미룬다(그 뒤에는 위 `close` 결함까지 그대로). 시험이 닫기가
   * 시작된 뒤의 순간을 상태로 붙잡을 때 쓴다.
   */
  holdClose: undefined as
    { at: (address: string) => boolean; until: Promise<void> } | undefined,
};

export function resetRefusing() {
  refusing.refuse = undefined;
  refusing.dialed.mockReset();
  serverFaults.listen = undefined;
  serverFaults.refusedListen.mockReset();
  serverFaults.close = undefined;
  serverFaults.failedClose.mockReset();
  serverFaults.listening = undefined;
  serverFaults.holdClose = undefined;
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
      const listening = (super.listen as (...args: unknown[]) => this)(...args);
      serverFaults.listening?.(address, this);
      return listening;
    }
    override close(callback?: (error?: Error) => void) {
      const hold = serverFaults.holdClose;
      const held = this.listenedAt;
      if (hold && held !== undefined && hold.at(held)) {
        hold.until.then(
          () => this.closeNow(callback),
          (error: unknown) =>
            callback?.(
              new Error("the held close was not released", { cause: error })
            )
        );
        return this;
      }
      return this.closeNow(callback);
    }
    /** 닫기: `serverFaults.close`가 정한 서버만 실제로 닫은 뒤 그 오류로 실패를 알린다. */
    closeNow(callback?: (error?: Error) => void) {
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

/**
 * 대역이 실패시킨 닫기(`code`)만으로 난 중계 닫기의 거절인가: 중계의 "폴더를 남김"(`relay_folder_kept`) 거절이고 그 원인의 서버 실패가
 * 모두 `code`다. 여러 중계를 함께 닫은 거절(AggregateError)은 그 하나하나가 그래야 한다. 그 밖의 모양은 대역과 무관한 실패다.
 */
function keptByDouble(failure: unknown, code: string): boolean {
  if (failure instanceof AggregateError)
    return (
      failure.errors.length > 0 &&
      failure.errors.every((each) => keptByDouble(each, code))
    );
  if (
    !(failure instanceof Error) ||
    !hasErrorCode("relay_folder_kept")(failure)
  )
    return false;
  const servers =
    failure.cause instanceof AggregateError
      ? failure.cause.errors
      : [failure.cause];
  return servers.length > 0 && servers.every(hasErrorCode(code));
}

/**
 * `at`에 맞는 중계 서버의 닫기가 실패를 알리게 하고(`serverFaults.close`, 서버는 실제로 닫힌다), 그 실패로 중계가 남긴 폴더를
 * 정리(`own`)에 맡긴다. `closing`은 그 중계들의 닫기 전부가 끝나는 promise를 돌려준다(시험이 이미 시작한 닫기면 그 promise를 그대로:
 * 중계의 `close`는 한 번이라 다시 불러도 같은 결과지만, hub의 `close`는 남은 중계만 닫으므로 시험이 부른 것을 넘긴다).
 * 정리는 그 닫기가 끝나기를 상한 안에서 기다린다. 상한을 넘기면 서버가 남았을 수 있으므로 지우지 않고 그 이유로 실패한다. 닫기가
 * 대역이 실패시킨 닫기만으로 거절했을 때만(`keptByDouble`) 대역이 실패를 알린 주소의 폴더를 지운다. 대역과 무관한 거절은 던지고
 * 지우지 않는다. 대역이 실패를 알렸는데 닫기가 이행했다면 맞지 않으므로 던진다. 대역이 실패를 알린 주소(`failedAt`)를 돌려준다.
 * 시험마다 비우는 `failedClose`와 달리 정리 때까지 남는다.
 */
export function failingRelayCloses(
  own: (step: () => Promise<void>) => void,
  at: (address: string) => boolean,
  closing: () => Promise<unknown>,
  code = "EBUSY"
) {
  const failedAt: string[] = [];
  serverFaults.close = {
    code,
    at,
    failed: (address) => failedAt.push(address),
  };
  own(async () => {
    const ended = await within(
      closing().then(
        () => ({ failure: undefined }),
        (failure: unknown) => ({ failure })
      ),
      10_000,
      "the relays did not close"
    );
    if (ended.failure === undefined) {
      if (failedAt.length > 0)
        throw new Error(
          `the relay close succeeded although the double failed ${failedAt.join(", ")}`
        );
      return;
    }
    if (failedAt.length === 0 || !keptByDouble(ended.failure, code))
      throw ended.failure;
    await attemptAll(
      failedAt.map((address) => () => removeFolderWithin(path.dirname(address)))
    );
  });
  return { failedAt: failedAt as readonly string[] };
}
