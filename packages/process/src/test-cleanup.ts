// 시험의 정리. 정리 실패가 시험의 원래 실패를 가리지 않고, 한 정리가 실패해도 나머지 정리를 한다(CODING_STANDARDS.md#정리).
// Vitest 시험은 자원을 잡은 직후 `onTestFinished`에 정리를 등록한다. 러너가 등록 역순으로 모두 하고 실패를 따로 알린다.
// 이 파일은 러너의 정리가 맞지 않는 곳에 쓴다: 시험 중간에 끝내야 하는 정리, node:test(본문이 실패하면 `t.after`의 실패를
// 버린다), Playwright 본문과 fixture, 여러 단계를 정리하는 시험 지원 함수.
// 실패는 `AggregateError`로 묶는다. Vitest·Playwright는 목록을 펼쳐 하나씩 보이고, 목록을 펼치지 않는 출력(node:test의 TAP)을
// 위해 메시지에도 모든 실패를 이어 적는다.

import { readFile } from "node:fs/promises";
import type net from "node:net";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  hasErrorCode,
} from "@babojubot/contracts";
import type { Lifelines } from "./lifeline-support.ts";
import { removeFolder } from "./remove-folder.ts";
import { reportedPid, within } from "./test-support.ts";

/** 정리 단계. 동기로 던지든 거절하든 실패로 모은다. 모두 시도하기는 `attemptAll`(`@babojubot/contracts`)이 한다. */
export type CleanupStep = () => unknown;

/** `removeFolderWithin`이 폴더 지우기를 기다리는 기본 상한. 지우기는 Windows의 일시적인 잠김만 몇 번 다시 시도한다(`removeFolder`). */
const folderRemoveMs = 10_000;

/**
 * 시험 정리가 폴더 하나를 상한 안에서 지운다(`removeFolder`, 다시 시도 포함). 넘기면 어느 폴더를 지우다 멈췄는지 알리고 실패한다.
 * 기본 상한 10초는 기본 다시 시도(3회, 대기 합 0.6초)를 담는다. 다시 시도를 늘리면 그 대기의 합보다 긴 `removeTimeoutMs`를 함께 준다.
 * 나머지 선택(`retries`·`retryDelayMs`·`rm`·`wait`)은 `removeFolder`에 그대로 넘긴다.
 * 한계: 상한은 기다림만 끝낸다. 진행 중인 지우기(`fs.rm`)는 멈출 수단이 없어 그 뒤에도 돌 수 있다. 그래도 정리는 이름 없이 hook
 * 시한까지 매달리지 않고 무엇을 기다렸는지 알린다.
 */
export function removeFolderWithin(
  folder: string,
  {
    removeTimeoutMs = folderRemoveMs,
    ...options
  }: NonNullable<Parameters<typeof removeFolder>[1]> & {
    removeTimeoutMs?: number;
  } = {}
) {
  return within(
    removeFolder(folder, options),
    removeTimeoutMs,
    `removing ${folder} did not finish`
  );
}

/**
 * 폴더와 그 안에서 도는 프로그램의 정리. 폴더를 만든 직후 `cleanUp`을 러너나 `withCleanup`에 등록하고, 프로그램을 띄우면 그
 * 멈춤을 `own`으로 맡긴다. `cleanUp`은 맡긴 멈춤을 역순으로 모두 시도하고, 모두 끝났을 때만 폴더를 지운다. 끝나지 않은 것이
 * 있으면 폴더를 남기고 그 실패를 알린다(살아 있는 프로그램의 폴더는 지우지 못하거나, 지워도 그 프로그램이 남는다).
 * 멈춤과 지우기는 한 번만 한다. 다시 부르거나 동시에 불러도 그 한 실행의 결과를 받으므로, 멈추지 못한 폴더는 다시 불러도 남는다.
 * 실패한 멈춤을 다시 시도하지 않는다. 정리는 러너가 한 번 부르고, 같은 프로그램을 다시 멈추는 일은 그 멈춤 함수가 맡는다.
 * 이 정리는 순서만 맡고 상한을 두지 않는다. 멈춤과 마지막 단계(`remove`)가 각자 상한을 가진다: 폴더를 지우면 `removeFolderWithin`을
 * 넘기고, DB·서버를 닫는 단계는 그 닫기의 상한을 쓴다.
 */
export function folderCleanup(remove: CleanupStep) {
  const stops: CleanupStep[] = [];
  let cleaning: Promise<void> | undefined;
  return {
    /** 폴더를 지우기 전에 끝나야 하는 것. `stop`은 그것을 멈추고 끝날 때까지 기다린다. 정리가 시작된 뒤에는 맡지 않고 던진다. */
    own(stop: CleanupStep) {
      if (cleaning)
        throw new Error("폴더 정리가 시작된 뒤에는 멈출 것을 맡길 수 없다");
      stops.push(stop);
    },
    cleanUp: () =>
      (cleaning ??= (async () => {
        await attemptAll([...stops].reverse());
        await remove();
      })()),
  };
}

/**
 * `body`를 하고, `body`가 `defer`로 등록한 정리를 등록 역순으로 모두 한다. 자원을 잡은 직후 그 정리를 등록한다.
 * 본문만 실패하면 그 실패를 그대로, 정리만 실패하면 정리 실패를 알린다. 둘 다 실패하면 원래 실패를 첫 자리에, 정리 실패를
 * 그 뒤에 둔 `AggregateError`로 함께 알린다.
 */
export async function withCleanup<T>(
  body: (defer: (step: CleanupStep) => void) => Promise<T> | T
): Promise<T> {
  const steps: CleanupStep[] = [];
  let outcome: { failed: false; value: T } | { failed: true; error: unknown };
  try {
    outcome = { failed: false, value: await body((step) => steps.push(step)) };
  } catch (error) {
    outcome = { failed: true, error };
  }
  const failures = await attemptEach(steps.reverse());
  if (!outcome.failed) {
    if (failures.length > 0) throw combinedFailure(failures, "정리가 실패했다");
    return outcome.value;
  }
  if (failures.length === 0) throw outcome.error;
  throw combinedFailure(
    [outcome.error, ...failures],
    "시험이 실패했고 정리도 실패했다",
    { cause: outcome.error }
  );
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * 프로세스가 아직 있는가(신호 0). "프로세스 없음"(ESRCH)만 없는 것으로 보고, 그 밖의 실패는 pid와 원인을 담아 던진다.
 * 권한 거부(EPERM)는 그 번호의 프로세스가 있다는 뜻이지만 시험이 띄운 프로세스인지 알 수 없다(다른 사용자가 번호를 다시 씀).
 * 끝났다고 보면 아직 쓰는 폴더를 지우고, 있다고 보면 대기 상한까지 원인 없이 기다리므로 원인과 함께 바로 실패한다.
 * Windows도 같은 코드를 낸다: 없는 번호와 이미 끝난 프로세스는 ESRCH, 열 권한이 없으면 EPERM이다(libuv `uv_kill`).
 * 거두어지기 전의 좀비는 있는 것으로 답한다(POSIX `kill`). 좀비를 끝난 것으로 볼 곳은 상태를 따로 읽는다(`exited`).
 */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw new Error(`프로세스 ${pid}가 있는지 확인하지 못했다`, {
      cause: error,
    });
  }
}

/**
 * 시험 정리: 신호(기본 SIGKILL)를 보내고 보냈으면 true. 이미 끝난 대상(ESRCH)은 넘어가 false, 그 밖의 실패는 pid·신호·원인을
 * 담아 던진다. 프로세스 그룹은 음수 번호로 준다. Windows는 SIGKILL·SIGTERM·SIGINT를 강제 종료로 보내고, 이미 끝난 대상은
 * ESRCH로 답한다(libuv `uv_kill`).
 */
export function killUnlessGone(
  pid: number,
  signal: NodeJS.Signals = "SIGKILL"
) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw new Error(`프로세스 ${pid}에 ${signal}을 보내지 못했다`, {
      cause: error,
    });
  }
}

/**
 * 시험이 나중에 기다리는 Promise를 표시하고 그대로 돌려준다. 기다리기 전에 거절돼도 러너가 그 거절을 처리되지 않은 거절로
 * 알리지 않는다. 거절은 나중에 기다리는 곳이 받는다(그 전에 시험이 실패해 정리로 끝나면 시험의 실패가 보고된다).
 * 시작하자마자 거절될 수 있는 대기(자식 프로그램의 `exit`·`error`, 붙잡은 요청의 응답)를 먼저 만들고 다른 단계를 거쳐 기다릴 때
 * 쓴다. 결과를 끝내 보지 않는 Promise에는 쓰지 않는다. 그런 작업은 기다려 결과를 단언한다(CODING_STANDARDS.md#단언).
 */
export function awaitedLater<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * 연결 `name`을 쥐고 도는 시험 프로그램의 시작 코드(`code`, 프로그램 안에 넣는 문장)와 정리(`end`). 프로그램은 자기 번호를 `pidFile`에
 * 쓴 뒤 연결하므로, 연결이 보이면 번호가 있다(#286). `then`은 서버가 이름을 받았다고 답한 뒤 프로그램이 실행할 문장이다(`hold`). 시험이 끄지 못한 프로그램은 `end`가 그 번호로 끈다: 연결이 오기를 기다리고(오지
 * 않으면 그 이유로 실패), 번호를 먼저 읽어 확인한 뒤, 연결이 열려 있음을 본 직후(사이에 기다림 없이) 그 번호로 끄고, 끝은 연결의
 * 닫힘으로 본다. 열려 있음은 본 순간에만 그 번호가 아직 그 프로그램이라는 근거라, 그 뒤에 기다림이 끼면 그 사이 프로그램이 끝날 수
 * 있다(#288 외부 리뷰 4회차 STD-6/SPEC-3). 두 기다림(`holderConnectMs`·`holderCloseMs`)의 합은 폴더 정리가 단계마다 두는 상한(10초)보다
 * 짧다. 그래서 `end`를 그 정리에 맡겨도 연결이 오지 않거나 닫히지 않은 이유를 `end`가 먼저 알린다.
 */
/** `lifelineHolder`의 정리가 연결이 오기를 기다리는 시간. */
const holderConnectMs = 4_000;
/** `lifelineHolder`의 정리가 끈 프로그램의 연결 닫힘을 기다리는 시간. */
const holderCloseMs = 5_000;
export function lifelineHolder(
  lifelines: Pick<Lifelines, "hold" | "connected" | "open" | "closed">,
  name: string,
  pidFile: string,
  then = ""
) {
  return {
    code: `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${lifelines.hold(name, then)}`,
    end: async () => {
      await lifelines.connected(name, holderConnectMs);
      const pid = reportedPid(
        await readFile(pidFile, "utf8"),
        `the pid file of ${name}`
      );
      if (lifelines.open(name)) killUnlessGone(pid);
      await lifelines.closed(name, holderCloseMs);
    },
  };
}

/** 끊기(`destroy`)와 닫힘(`close` 이벤트)이 있는 시험 자원: 소켓, HTTP 요청. */
type Closable = {
  destroy(): unknown;
  once(event: "close", listener: () => void): unknown;
};
/** `ownedClosable`의 정리가 끊은 자원의 닫힘을 기다리는 기본 상한. `testFolders`가 멈춤마다 두는 상한(`stopTimeoutMs`, 10초)보다 짧다. `folderCleanup`의 멈춤에는 따로 상한이 없어 이 상한이 그 기다림의 끝이다. */
const closableCloseMs = 5_000;

/**
 * 시험이 만든 소켓·HTTP 요청을 만든 직후 정리(`own`: `onTestFinished`, `withCleanup`의 `defer`, 폴더 정리의 `own`)에 맡기고 그대로
 * 돌려준다. 닫힘은 맡는 순간부터 듣고, 정리는 자원을 끊은 뒤(`destroy`) 실제 닫힘(`close`)을 상한(`closeMs`) 안에서 확인한다. 닫히지
 * 않으면 `what`과 상한으로 실패한다. 시험이 답을 상한으로 기다리다 실패해도 요청·소켓은 이 정리가 끝낸다(상한이 기다림만 끝내고
 * 자원을 남기지 않는다). 자원의 `error`는 듣지 않는다: 그 처리는 자원을 쓰는 시험이 맡고, 아무도 듣지 않으면 러너가 실패로 알린다.
 */
export function ownedClosable<T extends Closable>(
  own: (step: () => Promise<void>) => void,
  resource: T,
  what: string,
  closeMs = closableCloseMs
): T {
  ownClosable(own, resource, what, closeMs);
  return resource;
}

/**
 * `ownedClosable`과 같은 소유(만든 직후 `own`에 맡기고 정리가 끊은 뒤 닫힘을 상한 안에서 확인)를 하고, 맡는 순간부터 들은 닫힘(`closed`,
 * 거절하지 않음)을 돌려준다. 그 닫힘을 시험이 기다려야 하는 도움이 쓴다(`ownedConnect`, `@babojubot/process/testing`).
 */
export function ownClosable(
  own: (step: () => Promise<void>) => void,
  resource: Closable,
  what: string,
  closeMs = closableCloseMs
): { closed: Promise<void> } {
  const closed = new Promise<void>((resolve) =>
    resource.once("close", () => resolve())
  );
  own(() => endClosable(resource, closed, what, closeMs));
  return { closed };
}

/**
 * 자원을 끊고(`destroy`) 그 닫힘(`closed`, 자원을 얻은 순간부터 들은 것)을 상한 안에서 확인한다. 닫히지 않으면 `what`과 상한으로
 * 실패한다. `ownedClosable`의 정리다. CONNECT 터널처럼 나중에 생기는 소켓도 따로 맡지 않는다: 그 요청을 태울 연결을 먼저 만들어
 * 맡기고 요청은 그 위에 태운다(`ownedConnect`, `@babojubot/process/testing`). 터널은 그 연결 그 자체다.
 */
async function endClosable(
  resource: { destroy(): unknown },
  closed: Promise<void>,
  what: string,
  closeMs = closableCloseMs
): Promise<void> {
  resource.destroy();
  await within(closed, closeMs, `${what} did not close`);
}

/** `ownedListener`가 듣기를 기다리는 기본 상한. */
const listenerListenMs = 10_000;

/**
 * 시험이 띄우는 listener(net·http 서버)의 소유. 만든 서버를 받아 곧바로 그 닫기를 `own`(onTestFinished, withCleanup의 defer,
 * folderCleanup의 own 가운데 그 listener를 소유하는 정리)에 맡기고, 그다음 `at`에서 듣기를 상한(`listenMs`) 안에서 기다린다.
 * 닫기는 듣기 시도가 끝나기(듣기 시작 또는 듣기 오류)를 본 뒤, 받은 연결을 먼저 끊고(서버 닫기는 연결이 모두 끝나야 끝난다) 닫힘을
 * 확인한다. 그래서 듣기가 상한을 넘겨 늦게 시작해도 맡긴 닫기가 그 서버를 닫는다. 듣지 못했거나 이미 닫은 서버는 닫을 것이 없다
 * (`ERR_SERVER_NOT_RUNNING`, 듣기 시도가 끝난 뒤에만 그렇게 본다). 그 밖의 닫기 오류와 상한은 실패다. 듣지 못하면 그 오류로 거절된다.
 * 듣기 기다림이 상한으로 먼저 끝난 뒤 듣기가 실패하면 그 오류는 시험이 받지 못했으므로 닫기가 그 오류로 실패한다.
 * 돌려주는 `close`는 맡긴 것과 같은 닫기다. 시험 중간에 닫아야 하면(포트를 비우기 등) 그것을 부르고, 정리는 그 닫기의 결과를 받는다.
 * 닫기 사슬은 한 번만 만든다(다시 불러도 다시 닫지 않는다). 부를 때마다 그 사슬을 `closeMs` 안에서 기다리므로 결과는 그때 사슬의
 * 상태다. 상한이 먼저 끝난 뒤 사슬이 실패하면 그 실패를 원인(`cause`)과 함께 `lateFailure`로 한 번 드러낸다(기본: 러너의 잡히지 않은
 * 오류). 그 뒤 상한 안에서 기다린 다른 호출도 같은 실패로 거절할 수 있다(과잉 보고, 버리지 않음).
 * 닫기 전체(듣기 시도의 끝 기다림 포함)의 상한은 기본값이 `testFolders`가 멈춤마다 두는 상한(`stopTimeoutMs`, 10초)보다 짧아, 거기
 * 맡겨도 닫기가 그 이유를 먼저 알린다. `folderCleanup`의 멈춤에는 따로 상한이 없어 이 상한이 그 기다림의 끝이다.
 */
export async function ownedListener<S extends net.Server>(
  server: S,
  at: net.ListenOptions,
  own: (close: () => Promise<void>) => void,
  what: string,
  {
    listenMs = listenerListenMs,
    closeMs = closableCloseMs,
    lateFailure = (failure) =>
      queueMicrotask(() => {
        throw failure;
      }),
  }: {
    listenMs?: number;
    closeMs?: number;
    /** 닫기 상한이 먼저 끝난 뒤 닫기가 낸 실패를 받는 곳(기본: 러너의 잡히지 않은 오류). */
    lateFailure?: (failure: Error) => void;
  } = {}
): Promise<{ server: S; close: () => Promise<void> }> {
  const connections = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  // 듣기 시도의 끝(듣기 시작이면 이행, 듣기 오류면 그 오류로 거절). 처리기는 듣기 전에 붙이고 끝남을 동기로 세운다. 듣기 자체는
  // 닫기를 맡긴 뒤에 시작한다. 듣기 기다림이 시도가 끝나기 전에 상한으로 끝났는지는 `listenTimedOut`.
  let attemptEnded = false;
  let listenTimedOut = false;
  const attempt = awaitedLater(
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        attemptEnded = true;
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        attemptEnded = true;
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    })
  );
  // 닫기 사슬(한 번만 만듦), 그 끝남(사슬의 finally에서 동기로), 상한 뒤 늦은 실패를 드러내는 처리를 붙였는가(사슬마다 한 번).
  let closing: Promise<void> | undefined;
  let closingEnded = false;
  let lateWatched = false;
  const close = () => {
    closing ??= (async () => {
      const failure = await attempt.then(
        () => undefined,
        (error: unknown) => error
      );
      // 듣기 기다림이 상한으로 먼저 끝나 아무도 받지 못한 늦은 듣기 오류. 기다림이 받은 오류는 시험이 이미 받았다.
      if (failure !== undefined && listenTimedOut) throw failure;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error && !hasErrorCode("ERR_SERVER_NOT_RUNNING")(error)
            ? reject(error)
            : resolve()
        )
      );
    })().finally(() => {
      closingEnded = true;
    });
    const ending = closing;
    return within(ending, closeMs, `${what} did not close`).catch(
      (error: unknown) => {
        // 상한이 먼저 끝났으면 사슬은 아직 돈다. 그 뒤의 실패를 버리지 않고 원인과 함께 드러낸다.
        if (!closingEnded && !lateWatched) {
          lateWatched = true;
          ending.catch((late: unknown) =>
            lateFailure(
              new Error(`${what} failed after its close timed out`, {
                cause: late,
              })
            )
          );
        }
        throw error;
      }
    );
  };
  own(close);
  server.listen(at);
  try {
    await within(attempt, listenMs, `${what} did not start listening`);
  } catch (error) {
    if (!attemptEnded) listenTimedOut = true;
    throw error;
  }
  return { server, close };
}
