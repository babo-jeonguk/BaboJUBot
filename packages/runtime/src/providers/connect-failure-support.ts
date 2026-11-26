// 이 파일은 `vi.mock("node:net")`·`vi.mock("node:http")`·`vi.mock("node:dns/promises")` 대역의 factory가 불러온다. 그래서 이 파일과 이
// 파일이 불러오는 모듈 전체(@babojubot/process의 `test-cleanup.ts`·`test-support.ts`·`remove-folder.ts`, @babojubot/contracts,
// `os-failure-support.ts`)는 그 builtin들을 형으로만 불러온다. 값으로 불러오면 대역이 만들어지기 전에 자기 자신을 기다려 시험이
// 불러오는 단계에서 멈춘다. 그 builtin을 값으로 쓰는 시험 도움은 이 경로 밖(`@babojubot/process/testing`의 `test-connect.ts` 등)에
// 둔다. (`node:os` 대역의 factory는 이 파일이 아니라 `os-failure-support.ts`만 불러온다: 이 파일이 불러오는 `test-support.ts`가
// `node:os`를 값으로 불러오기 때문이다.)
import type * as dnsModule from "node:dns/promises";
import type * as httpModule from "node:http";
import type * as netModule from "node:net";
import path from "node:path";
import { test, vi } from "vitest";
import { attemptAll, hasErrorCode, parseIp } from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";
import { callArming } from "@babojubot/process/call-arming";
import {
  awaitedLater,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
import { resetOsFaults } from "./os-failure-support.ts";

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
//
// 시험이 붙잡는 순간(닫기, 조회)과 콜백 안 기다림은 그 시험의 소유자에 건다(`holds.gate()`·`holds.until`). 소유자는 시험 문맥으로만
// 받는다(`holdsTest`의 `holds`).
// 대역의 붙잡기(`serverFaults.holdClose`)는 `holds.gate()`가 만든 것만 받는다. 대역의 기록 가운데 설정을 읽은 뒤 비동기 콜백에서
// 남기는 것(실패시킨 닫기)은 그 결함을 정한 시험이 소유한다. 부르는 순간 같은 동기 구간에서 남기는 기록만 모듈 칸(`vi.fn`)에 둔다.

const gateBrand: unique symbol = Symbol("gate");
/** 시험이 붙잡은 일을 놓는 gate. 본문이 `open()`으로 열면 `until`이 `"opened"`로 풀린다. */
export type Gate = {
  readonly until: Promise<"opened" | "reset">;
  open(): void;
  readonly [gateBrand]: true;
};

/** 대역의 reset이 붙잡힌 기다림을 포기시킬 때의 거절. 무엇을 포기했는지(`what`)를 밝힌다. 포기하는 자리는 모두 이 문구를 쓴다. */
export function givenUpAtReset(what: string) {
  return new Error(`${what} was given up at the double's reset`);
}

/** 시험이 대역·콜백에서 붙잡는 것: gate와 콜백 안 기다림. 얻는 자리에서 그 소유자에 등록한다. */
export type Holds = {
  gate(): Gate;
  until<T>(event: Promise<T>, what: string): Promise<T>;
  /**
   * 소유자의 지금 상태(읽기만). 시험이 자기 정리가 소유자의 끝보다 먼저 도는지 확인할 때만 본다. 콜백이 이것으로 등록 여부를 가르지
   * 않는다: reset 뒤의 시도는 등록을 시도해야 늦은 시도로 남아 끝이 알린다.
   */
  readonly state: "open" | "givenUp" | "ended";
};

/**
 * 붙잡는 것의 소유자 하나(#286 PR #300 외부 리뷰 2회차 STD-1). 상태는 `"open"` → `"givenUp"`(대역의 reset) → `"ended"`(시험 수명의
 * 끝)로만 간다. 등록은 `"open"`일 때만 한다. 그 뒤의 시도는 등록하지 않고 곧바로 답하며(기다림은 `givenUpAtReset(what)`으로 거절, gate는 `"reset"`으로 풀림) 늦은 등록 목록에 남는다.
 * - `giveUp()`: 첫 동기 단계에서 등록을 닫고, 등록된 기다림을 `givenUpAtReset(what)`으로 풀고(사건이 오지 않은 채 닿은 것으로 기억),
 *   gate를 `"reset"`으로 연다. 던지지 않고, 여러 번 불러도 된다.
 * - `end()`: 첫 동기 단계에서 `"ended"`로. 아직 등록된 것이 있으면(reset을 거치지 않음) giveUp처럼 푼 뒤, 사건이 오지 않은 기다림과 늦은
 *   등록이 있으면 그 목록으로 던진다. 그 뒤의 시도는 거절만 되고 어디에도 알리지 않는다(알릴 시험이 끝났다).
 */
export function holdsOwner() {
  let state: "open" | "givenUp" | "ended" = "open";
  const gates = new Set<(outcome: "opened" | "reset") => void>();
  const waiting = new Set<{ what: string; giveUp: (reason: Error) => void }>();
  const unended: string[] = [];
  const late: string[] = [];
  const release = () => {
    for (const { what, giveUp } of waiting) {
      unended.push(what);
      giveUp(givenUpAtReset(what));
    }
    waiting.clear();
    for (const open of gates) open("reset");
    gates.clear();
  };
  /** 지금 등록을 받는가. 받지 않으면 그 시도를 늦은 등록으로 남긴다. */
  const admits = (what: string) => {
    switch (state) {
      case "open":
        return true;
      case "givenUp":
      case "ended":
        late.push(what);
        return false;
      default:
        return state satisfies never;
    }
  };
  const holds: Holds = {
    get state() {
      return state;
    },
    /**
     * gate 하나를 만든다. 만드는 순간 그 해제를 소유자에 맡긴다: 본문이 열지 못한 채 시험이 끝나도(본문 실패) afterEach의
     * `resetRefusing()`이 `"reset"`으로 연다. vitest는 afterEach를 그 시험의 모든 onTestFinished보다 먼저 부르므로(5.0.5 러너:
     * `test.afterEach` 다음 `test.onFinished`, 본문이 실패한 시험으로 실행해 확인) gate에 걸린 hub·중계 닫기(onTestFinished)보다 먼저
     * 풀린다. 본문의 `open()`과 reset 가운데 먼저 부른 것 하나만 효과가 있다. 붙잡힌 일의 해제일 뿐 그 일의 끝(닫힘) 확인은 그 일의
     * 정리가 따로 한다. 등록이 닫힌 뒤에 만들면 이미 `"reset"`으로 풀린 gate다.
     */
    gate() {
      const { promise, resolve } = Promise.withResolvers<"opened" | "reset">();
      const settle = (outcome: "opened" | "reset") => {
        gates.delete(settle);
        resolve(outcome);
      };
      if (admits("a gate")) gates.add(settle);
      else settle("reset");
      return {
        until: promise,
        open: () => settle("opened"),
        [gateBrand]: true,
      };
    },
    /**
     * 콜백(정책 hook, 대역 구현) 안에서 사건 `event`를 기다리는 길. 사건의 결과를 그대로 돌려주고(이행·거절 모두), 사건이 오기 전에
     * 소유자의 reset(`resetRefusing()`, afterEach)이 오면 `givenUpAtReset(what)`으로 거절한다. reset은 그 시험의 hub·중계 닫기
     * (onTestFinished)보다 먼저 돌므로 본문이 실패해 사건이 오지 않아도 콜백의 기다림은 시험 뒤에 남지 않는다. reset 뒤에 시작한
     * 기다림은 등록하지 않고 곧바로 거절한다(사건이 이미 왔어도: 거절이 race의 첫 원소다). 사건에는 늘 처리기를 단다(race).
     * 바깥 기다림의 상한은 바깥 기다림만 끝내므로 이 해제를 대신하지 못한다. 콜백은 이것을 시험이 소유한 칸에 `awaitedLater`로 담고 그
     * 칸을 기다린다. 본문은 답을 받은 뒤 답 내용을 단언하기 전에 그 칸을 상한 안에서 받아, 사건으로 풀렸는지(이행) 단언하고 사건의
     * 실패는 그 거절로 받는다. 콜백 안에 상한(`within`)을 두지 않는다: 그 거절이 제품의 정책 읽기 실패(`policy_unavailable`)로 접혀
     * 까닭이 사라진다. 사건이 오지 않은 채 reset에 닿은 기다림과 reset 뒤의 시도는 소유자의 끝(`end`)이 그 이름으로 알린다.
     */
    until<T>(event: Promise<T>, what: string) {
      if (!admits(what))
        return Promise.race([Promise.reject(givenUpAtReset(what)), event]);
      const given = Promise.withResolvers<never>();
      const entry = { what, giveUp: given.reject };
      waiting.add(entry);
      return Promise.race([
        event.finally(() => waiting.delete(entry)),
        given.promise,
      ]);
    },
  };
  return {
    holds,
    giveUp() {
      switch (state) {
        case "open":
          state = "givenUp";
          release();
          return;
        case "givenUp":
        case "ended":
          return;
        default:
          state satisfies never;
      }
    },
    end() {
      switch (state) {
        case "open":
        case "givenUp":
          state = "ended";
          release();
          break;
        case "ended":
          return;
        default:
          state satisfies never;
      }
      const problems = [
        ...(unended.length > 0
          ? [
              `the test ended while hook waits had not ended: ${unended.join(", ")}`,
            ]
          : []),
        ...(late.length > 0
          ? [`holds began after the double's reset: ${late.join(", ")}`]
          : []),
      ];
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
  };
}

/** 지금 시험의 소유자(`holdsTest`가 열고 그 끝이 비운다). 대역의 reset(`resetRefusing`)만 본다. 내보내지 않는다: 콜백이 불릴 때
 * 지금의 소유자를 찾으면 앞 시험의 늦은 콜백이 다음 시험의 소유자에 등록된다(#286 PR #300 외부 리뷰 3회차). */
let thisTest: ReturnType<typeof holdsOwner> | undefined;

/**
 * 대역이 붙잡는 것(gate·콜백 안 기다림)을 쓰는 시험. 소유자는 그 시험의 문맥(`holds`)으로만 받는다:
 * `holdsTest("…", async ({ holds }) => …)`, 표 시험은 `holdsTest.for(표)("…", async (row, { holds }) => …)`.
 * fixture는 본문 전에 소유자를 열고 그 끝을 그 시험의 onTestFinished로 등록한다. vitest는 onTestFinished를 등록 역순으로 부르므로
 * (5.0.5 러너 `callTestHooks(…, "stack")`) 본문이 등록한 hub·중계·listener 닫기 뒤, 맨 나중에 돈다. 그 끝이 사건이 오지 않은 기다림과
 * reset 뒤의 시도를 그 시험의 실패로 알린다. fixture의 `use` 뒤(정리 단계)에는 아무것도 두지 않는다: 그 단계는 onTestFinished보다
 * 먼저 돌아 본문 정리 중의 늦은 시도를 놓친다. 앞 시험의 소유자가 아직 열려 있으면(그 끝이 돌지 않음) 던진다.
 */
export const holdsTest = test.extend<{ holds: Holds }>({
  holds: async ({ onTestFinished }, use) => {
    if (thisTest)
      throw new Error("the previous test's holds did not end before this test");
    const owner = holdsOwner();
    thisTest = owner;
    onTestFinished(() => {
      thisTest = undefined;
      owner.end();
    });
    await use(owner.holds);
  },
});

export const refusing = {
  /**
   * 대역이 붙잡고 있는 연결(`holdConnect`). `resetRefusing()`이 새 묶음으로 바꿔 끼우고 앞 묶음의 연결을 포기시킨다. 대역은 불린 순간
   * 지금의 묶음을 잡고 그 묶음에만 넣고 뺀다.
   */
  held: { sockets: new Set<netModule.Socket>() },
  /** 실패시킬 포트와 오류 코드. 없으면 아무 연결도 대역하지 않는다. */
  refuse: undefined as { port: number; code: string } | undefined,
  /** 대역한 연결마다 `{ host, port }`로 불린다. */
  dialed: vi.fn<(target: { host: unknown; port: number }) => void>(),
  /**
   * 이 포트로 가는 연결을 붙지 않은 채 붙잡는다(연결 중인 소켓). 그 소켓은 부른 쪽이 끊거나 `resetRefusing()`이 ECONNABORTED로
   * 포기시킬 때까지 연결 중으로 남는다. `refuse`보다 먼저 본다.
   */
  holdConnect: undefined as { port: number } | undefined,
  /** 붙잡은 연결마다 그 소켓으로 불린다. */
  heldConnect: vi.fn<(socket: netModule.Socket) => void>(),
};

/** 이름 풀이(`node:dns/promises`의 `lookup`) 대역. 정한 이름만 정한 주소로 답하고, 그 밖의 이름은 진짜로 푼다. */
export const nameFaults = {
  lookup: undefined as { host: string; addresses: string[] } | undefined,
  /** 정한 이름을 물을 때마다 그 이름과 옵션으로 불린다. */
  looked: vi.fn<(host: string, options: unknown) => void>(),
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
   * 그 결함의 `failedAt`(실패를 알린 닫기의 서버가 들은 주소)으로 확인한다. 기록은 닫기를 부를 때 잡은 결함에 남으므로, 닫기가 reset
   * 뒤에 끝나도 그 결함을 정한 시험의 것으로 남고 다음 시험의 기록에 섞이지 않는다(#286 PR #300 외부 리뷰 2회차 STD-1).
   */
  close: undefined as
    | {
        code: string;
        at: (address: string) => boolean;
        failedAt: string[];
        /** 이 결함이 잡은 닫기마다 그 닫기가 끝나면 이행하는 것(닫기를 부른 순간 넣는다). 정리는 이것이 모두 끝난 뒤 `failedAt`을 읽는다. */
        closing: Promise<void>[];
      }
    | undefined,
  /**
   * 대역이 만든 서버가 실패시키지 않은 듣기를 시작한 직후(진짜 `listen`을 부른 같은 동기 구간) 그 첫 인수(주소·포트)와 서버로 부른다.
   * 시험이 듣기 시도가 끝나기 전의 순간을 상태로 잡거나, 제품이 만든 서버를 시험의 정리에 맡길 때 쓴다. 제품의 `listen` 호출 안에서
   * 불리므로 던지지 않는다(던지면 제품의 듣기 오류로 잡힌다).
   */
  listening: undefined as
    ((address: unknown, server: netModule.Server) => void) | undefined,
  /**
   * 파일 소켓 경로가 `at`에 맞는 서버의 닫기를 `held`가 풀릴 때까지 미룬다(그 뒤에는 위 `close` 결함까지 그대로). 시험이 닫기가
   * 시작된 뒤의 순간을 상태로 붙잡을 때 쓴다. 미룬 닫기마다 `heldClose`가 그 주소로 불린다.
   */
  holdClose: undefined as
    { at: (address: string) => boolean; held: Gate } | undefined,
  heldClose: vi.fn<(address: string) => void>(),
};

/**
 * 대역을 시험 시작 전 모양으로 되돌리고 붙잡은 것을 모두 푼다(afterEach). 이 시험의 소유자는 등록을 닫고 붙잡은 것을 푼다(`giveUp`).
 * 던지지 않는다: 사건이 오지 않은 기다림과 reset 뒤의 시도는 그 시험 수명의 끝(`holdsTest`가 등록한 것)이 알린다.
 */
export function resetRefusing() {
  thisTest?.giveUp();
  const { held } = refusing;
  refusing.held = { sockets: new Set() };
  for (const socket of held.sockets)
    socket.destroy(
      Object.assign(givenUpAtReset("a held connect"), { code: "ECONNABORTED" })
    );
  refusing.refuse = undefined;
  refusing.dialed.mockReset();
  refusing.holdConnect = undefined;
  refusing.heldConnect.mockReset();
  nameFaults.lookup = undefined;
  nameFaults.looked.mockReset();
  serverFaults.listen = undefined;
  serverFaults.refusedListen.mockReset();
  serverFaults.close = undefined;
  serverFaults.listening = undefined;
  serverFaults.holdClose = undefined;
  serverFaults.heldClose.mockReset();
  resetOsFaults();
}

function codeError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

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
      // 결함은 닫기를 부른 순간 잡는다. 붙잡힌 닫기는 gate가 풀린 뒤에 닫으므로, 그때 칸을 다시 찾으면 그 사이 reset이 바꾼 칸을 본다.
      const hold = serverFaults.holdClose;
      const fault = serverFaults.close ?? closeCalls.current();
      const held = this.listenedAt;
      // 이 결함이 잡은 닫기는 부른 순간 센다(붙잡힌 닫기도). 정리가 그 끝을 기다린 뒤 기록을 읽는다.
      const caught =
        fault && held !== undefined && fault.at(held)
          ? Promise.withResolvers<void>()
          : undefined;
      if (fault && caught) fault.closing.push(caught.promise);
      if (hold && held !== undefined && hold.at(held)) {
        serverFaults.heldClose(held);
        // gate는 풀리기만 한다(거절하지 않음). 거절이 오면 그 원인을 닫기의 실패로 넘긴다.
        hold.held.until.then(
          () => void this.closeNow(fault, callback, caught?.resolve),
          (error: unknown) => {
            caught?.resolve();
            callback?.(new Error("the held close failed", { cause: error }));
          }
        );
        return this;
      }
      return this.closeNow(fault, callback, caught?.resolve);
    }
    /**
     * 닫기: 부른 순간 잡은 결함(`fault`)이 정한 서버만 실제로 닫은 뒤 그 오류로 실패를 알린다. `ended`는 그 결함이 센 닫기의 끝을
     * 알린다(기록을 남긴 뒤).
     */
    closeNow(
      fault: (typeof serverFaults)["close"],
      callback?: (error?: Error) => void,
      ended?: () => void
    ) {
      const at = this.listenedAt;
      if (!fault || at === undefined || !fault.at(at))
        return super.close(callback);
      return super.close((error?: Error) => {
        if (!error) fault.failedAt.push(at);
        ended?.();
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

/** 연결 옵션이 가리키는 `{ host, port }`. 포트가 없는 연결(파일 소켓 경로)은 없음이다. */
function connectTarget(
  options: unknown
): { host: unknown; port: number } | undefined {
  if (typeof options !== "object" || options === null || !("port" in options))
    return undefined;
  const host =
    "host" in options
      ? options.host
      : "hostname" in options
        ? options.hostname
        : undefined;
  return { host, port: Number(options.port) };
}

/**
 * `options`가 대역이 불린 순간 잡은 `refuse`의 포트로 가는 연결이면 그 대상과 실패를 돌려준다. 실패는 실제 연결에서 나오는 오류와
 * 같은 모양(`code`·`syscall`)이다. 기록(`dialed`)은 부른 대역이 잡아 둔 것으로 남긴다.
 */
function refusal(
  refuse: (typeof refusing)["refuse"],
  options: unknown
): { target: { host: unknown; port: number }; error: Error } | undefined {
  const target = connectTarget(options);
  if (!refuse || target?.port !== refuse.port) return undefined;
  return {
    target,
    error: Object.assign(
      new Error(`connect ${refuse.code} ${String(target.host)}:${refuse.port}`),
      { code: refuse.code, syscall: "connect" }
    ),
  };
}

/** 연결을 시작하지 않고 `failure`로 끝나는 소켓. 실제 연결 실패처럼 다음 차례에 `error`와 `close`를 낸다. */
function failedSocket(real: typeof netModule, failure: Error) {
  const socket = new real.Socket();
  process.nextTick(() => socket.destroy(failure));
  return socket;
}

/**
 * 붙지 않고 연결 중으로 남는 소켓(`refusing.holdConnect`). 끊기면 실제 연결 중 소켓처럼 `close`를 낸다. 대역이 불린 순간 잡은 묶음
 * (`held`)에 넣고 그 묶음에서 빼며, 잡아 둔 기록(`heldConnect`)에 남긴다.
 */
function heldSocket(
  real: typeof netModule,
  held: (typeof refusing)["held"],
  heldConnect: (typeof refusing)["heldConnect"]
) {
  const socket = new real.Socket();
  held.sockets.add(socket);
  socket.once("close", () => held.sockets.delete(socket));
  heldConnect(socket);
  return socket;
}

/** `node:net` 대역: 정한 포트로 가는 `connect`·`createConnection`을 붙잡거나(`holdConnect`) 실패시킨다(`refuse`). */
export function failingNet(real: typeof netModule) {
  const passThrough = real.connect as (...args: unknown[]) => netModule.Socket;
  const connect = ((...args: unknown[]) => {
    // 설정과 기록 칸은 불린 순간 잡는다(tests/hoisted-state-at-call).
    const { holdConnect: hold, refuse, dialed, held, heldConnect } = refusing;
    if (hold && connectTarget(args[0])?.port === hold.port)
      return heldSocket(real, held, heldConnect);
    const refused = refusal(refuse, args[0]);
    if (!refused) return passThrough(...args);
    dialed(refused.target);
    return failedSocket(real, refused.error);
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
    // 설정과 기록 칸은 불린 순간 잡는다(tests/hoisted-state-at-call).
    const { refuse, dialed } = refusing;
    const [options, ...rest] = args;
    const refused = refusal(refuse, options);
    if (!refused) return passThrough(...args);
    dialed(refused.target);
    return passThrough(
      {
        ...(options as httpModule.RequestOptions),
        createConnection: () => failedSocket(net, refused.error),
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
 * `node:dns/promises` 대역: `nameFaults.lookup`이 정한 이름은 그 주소로 답한다. 답의 모양은 진짜 `lookup`과 같다(`all`이면
 * `{ address, family }` 배열, 아니면 첫 것 하나). 그 밖의 이름은 진짜로 푼다.
 */
export function failingDns(real: typeof dnsModule) {
  const passThrough = real.lookup as (...args: unknown[]) => Promise<unknown>;
  const lookup = ((host: string, options?: unknown) => {
    const fault = nameFaults.lookup;
    if (!fault || host !== fault.host) return passThrough(host, options);
    nameFaults.looked(host, options);
    const answers = fault.addresses.map((address) => {
      const parsed = parseIp(address);
      if (!parsed)
        throw new Error(`the double's address is not an IP: ${address}`);
      return { address, family: parsed.family };
    });
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      options.all === true;
    return Promise.resolve(all ? answers : answers[0]);
  }) as typeof real.lookup;
  return { ...real, lookup, default: { ...real, lookup } };
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

type CloseFault = NonNullable<(typeof serverFaults)["close"]>;
/**
 * 그 시험만의 경로로 고를 수 없는 닫기 결함(공유 임시 폴더에 무작위 이름으로 생기는 중계 폴더)은 그 시험이 부른 제품 호출에 묶는다
 * (`failingRelayClosesDuring`). 닫기 대역은 불린 순간 `serverFaults.close`(경로로 고른 결함)가 없으면 이 문맥의 결함을 잡는다.
 */
const closeCalls = callArming<CloseFault>();

/**
 * 결함 `fault`가 실패시킨 닫기로 중계가 남긴 폴더를 정리(`own`)에 맡긴다. `closing`은 그 중계들의 닫기 전부가 끝나는 promise를 돌려준다.
 * 정리는 그 닫기가 끝나기를 상한 안에서 기다린다. 상한을 넘기면 서버가 남았을 수 있으므로 지우지 않고 그 이유로 실패한다. 닫기가
 * 대역이 실패시킨 닫기만으로 거절했을 때만(`keptByDouble`) 대역이 실패를 알린 주소의 폴더를 지운다. 대역과 무관한 거절은 던지고
 * 지우지 않는다. 대역이 실패를 알렸는데 닫기가 이행했다면 맞지 않으므로 던진다.
 */
function ownKeptRelays(
  own: (step: () => Promise<void>) => void,
  fault: CloseFault,
  closing: () => Promise<unknown>
) {
  own(async () => {
    const ended = await within(
      closing().then(
        () => ({ failure: undefined }),
        (failure: unknown) => ({ failure })
      ),
      10_000,
      "the relays did not close"
    );
    // 결함이 잡은 닫기가 모두 끝난 뒤 기록을 읽는다(호출이 기다리지 않은 닫기도 기록 밖에 남지 않게). 기다리는 사이 새로 잡힌 것도 본다.
    for (let waited = 0; waited < fault.closing.length;) {
      const pending = fault.closing.slice(waited);
      waited = fault.closing.length;
      await within(
        Promise.all(pending),
        10_000,
        "a relay close the double failed did not end"
      );
    }
    if (ended.failure === undefined) {
      if (fault.failedAt.length > 0)
        throw new Error(
          `the relay close succeeded although the double failed ${fault.failedAt.join(", ")}`
        );
      return;
    }
    if (fault.failedAt.length === 0 || !keptByDouble(ended.failure, fault.code))
      throw ended.failure;
    await attemptAll(
      fault.failedAt.map(
        (address) => () => removeFolderWithin(path.dirname(address))
      )
    );
  });
}

/**
 * `at`에 맞는 중계 서버의 닫기가 실패를 알리게 하고(`serverFaults.close`, 서버는 실제로 닫힌다), 그 실패로 중계가 남긴 폴더를
 * 정리(`own`, `ownKeptRelays`)에 맡긴다. `at`은 그 시험만의 경로(그 시험이 연 중계의 소켓)를 골라야 한다. `closing`은 그 중계들의
 * 닫기 전부가 끝나는 promise를 돌려준다(시험이 이미 시작한 닫기면 그 promise를 그대로: 중계의 `close`는 한 번이라 다시 불러도 같은
 * 결과지만, hub의 `close`는 남은 중계만 닫으므로 시험이 부른 것을 넘긴다). 대역이 실패를 알린 주소(`failedAt`, 이 결함이 소유한
 * 기록)를 돌려준다.
 */
export function failingRelayCloses(
  own: (step: () => Promise<void>) => void,
  at: (address: string) => boolean,
  closing: () => Promise<unknown>,
  code = "EBUSY"
) {
  const fault: CloseFault = { code, at, failedAt: [], closing: [] };
  serverFaults.close = fault;
  ownKeptRelays(own, fault, closing);
  return { failedAt: fault.failedAt as readonly string[] };
}

/**
 * 제품 호출 `call`(그 시험이 부른 것)이 연 중계 가운데 `at`에 맞는 서버의 닫기만 실패를 알리게 한다(`closeCalls`의 문맥). 중계 폴더가
 * 공유 임시 폴더에 무작위 이름으로 생겨 그 시험만의 경로로 고를 수 없을 때 쓴다: 앞 시험의 늦은 닫기는 이 호출의 문맥이 아니라 걸리지
 * 않는다. 그 호출의 결과(`result`, 정리가 끝을 기다림)와 대역이 실패를 알린 주소(`failedAt`)를 돌려준다. 시험은 `failedAt`이 비지
 * 않았음을 단언해 문맥이 끊긴 채 통과하지 않게 한다.
 */
export function failingRelayClosesDuring<T>(
  own: (step: () => Promise<void>) => void,
  at: (address: string) => boolean,
  call: () => Promise<T>,
  code = "EBUSY"
) {
  const fault: CloseFault = { code, at, failedAt: [], closing: [] };
  // 정리는 제품 호출 전에 등록한다(획득 즉시 등록). 남긴 폴더 정리를 먼저, 무장의 끝(`run`이 호출 전에 `own`에 맡김)을 그 뒤에
  // 등록해 무장이 먼저 끝난다(시험의 정리는 등록의 거꾸로 돈다). 그 뒤에 시작한 닫기는 결함에 걸리지 않고, 끝 전에 시작한 닫기는
  // 정리가 그 끝을 기다린 뒤 기록을 읽는다(`closing`). 정리는 시험이 끝난 뒤에 돌아 그때는 호출의 결과가 있다.
  ownKeptRelays(own, fault, () => result);
  const result = awaitedLater(closeCalls.run(fault, call, own));
  return { failedAt: fault.failedAt as readonly string[], result };
}
