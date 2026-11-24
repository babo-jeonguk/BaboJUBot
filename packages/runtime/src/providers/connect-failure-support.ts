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

export const refusing = {
  /** 실패시킬 포트와 오류 코드. 없으면 아무 연결도 대역하지 않는다. */
  refuse: undefined as { port: number; code: string } | undefined,
  /** 대역한 연결마다 `{ host, port }`로 불린다. */
  dialed: vi.fn<(target: { host: unknown; port: number }) => void>(),
};

export function resetRefusing() {
  refusing.refuse = undefined;
  refusing.dialed.mockReset();
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
  return {
    ...real,
    connect,
    createConnection: connect,
    default: { ...real, connect, createConnection: connect },
  };
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
  return { ...real, request, default: { ...real, request } };
}
