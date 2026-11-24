import type { Readable } from "node:stream";

// 계약 시험(runtime-contract.ts)이 실행 시도가 띄운 프로그램의 끝을 신호로 보는 길과, 반환 뒤 판정. 판정과 관찰을 계약 시험 밖의
// 작은 단위로 떼어 program-watch-support.test.ts가 결함 사례로 시험한다(#294 외부 리뷰 1회차 SPEC-2).
//
// 실행 시도 중 runtime이 프로그램을 띄우는 길은 `@babojubot/process`의 공용 실행 `launchTree`·`runTree` 둘뿐이다(lint
// `product/no-direct-launch`가 child_process·cross-spawn을 정해진 파일로 제한한다). 그 위에 `startProcess`(실행 시도, `done`이
// "프로그램이 끝나고 출력 처리도 끝났다"), `runProbe`·`runDocker`(짧은 확인 명령), Antigravity 설정 정리가 선다. 직접 띄우는
// `login.ts`의 대화형 로그인(`runLogin`)은 adapter와 서버가 부르지 않고, `@babojubot/process/recovery`는 서버 재시작 복구에서만
// 프로그램을 띄운다. 계약 시험 파일은 `./providers/process.ts`(`watchPrograms`)와 `@babojubot/process`(`watchProcessPackage`)를
// `vi.mock`으로 감싸 두 층을 모두 본다.

/**
 * 띄운 프로그램 하나. `running`은 아직 끝을 보지 못함, `ended`는 끝 신호를 봄, `unconfirmed`는 끝 신호가 실패로 끝남(끝을 확인하지
 * 못함, 끝난 것으로 치지 않는다). `end`는 그 상태가 정해지기를 기다린다(거절하지 않는다).
 */
export type WatchedProgram = {
  state: "running" | "ended" | "unconfirmed";
  end: Promise<void>;
};

const programs: WatchedProgram[] = [];
const watched = { processModule: false, processPackage: false };

/** 끝 신호 하나를 기록한다. 이행하면 `ended`, 거절하면 `unconfirmed`. */
function watch(signal: Promise<unknown>): WatchedProgram {
  const program: WatchedProgram = {
    state: "running",
    end: signal.then(
      () => {
        program.state = "ended";
      },
      () => {
        program.state = "unconfirmed";
      }
    ),
  };
  programs.push(program);
  return program;
}

/** 흐름이 닫히면 이행한다. 없거나 이미 닫혔으면 바로 이행한다. */
function closed(stream: Readable | null): Promise<void> {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise<void>((resolve) => stream.once("close", () => resolve()));
}

/**
 * `vi.mock("./providers/process.ts", …)`의 factory에서 부른다. `startProcess`가 띄운 실행 시도 프로그램을 기록하고 그 `done`을 끝
 * 신호로 본다. adapter보다 먼저 `done`에 붙으므로, adapter가 `done`을 기다린 뒤 돌아오면 그 전에 상태가 정해진다.
 */
export function watchPrograms<
  M extends { startProcess: (...args: never[]) => { done: Promise<unknown> } },
>(real: M): M {
  watched.processModule = true;
  const startProcess = ((...args: Parameters<M["startProcess"]>) => {
    const started = real.startProcess(...args);
    watch(started.done);
    return started;
  }) as M["startProcess"];
  return { ...real, startProcess };
}

type Tree = {
  stop(...args: never[]): Promise<unknown>;
  stdout: Readable | null;
  stderr: Readable | null;
};

/**
 * `vi.mock("@babojubot/process", …)`의 factory에서 부른다. 공용 실행으로 띄운 것을 모두 기록한다. `launchTree`의 트리는 그 `stop()`이
 * 이행하고(트리 전체가 끝난 것을 확인) 출력이 닫혔을 때 끝난 것이다. `stop()`을 부르지 않은 트리는 끝나지 않은 것이다. `runTree`는
 * 그 결과가 정해졌을 때(끈 것까지 확인하고 돌아온다) 끝난 것이다.
 */
export function watchProcessPackage<
  M extends {
    launchTree: (...args: never[]) => Tree;
    runTree: (...args: never[]) => Promise<unknown>;
  },
>(real: M): M {
  watched.processPackage = true;
  const launchTree = ((...args: Parameters<M["launchTree"]>) => {
    const tree = real.launchTree(...args);
    let markStopped!: () => void;
    let markStopFailed!: (error: unknown) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      markStopped = resolve;
      markStopFailed = reject;
    });
    watch(Promise.all([stopped, closed(tree.stdout), closed(tree.stderr)]));
    const stop = tree.stop.bind(tree);
    tree.stop = ((...stopArgs: never[]) => {
      const stopping = stop(...stopArgs);
      stopping.then(markStopped, markStopFailed);
      return stopping;
    }) as Tree["stop"];
    return tree;
  }) as M["launchTree"];
  const runTree = ((...args: Parameters<M["runTree"]>) => {
    const run = real.runTree(...args);
    watch(run);
    return run;
  }) as M["runTree"];
  return { ...real, launchTree, runTree };
}

/** 이 파일이 두 층(`./providers/process.ts`, `@babojubot/process`)을 모두 보고 있는지. 보지 않는 채로 "프로그램 없음"이라고 판정하지 않는다. */
export function watchingPrograms(): boolean {
  return watched.processModule && watched.processPackage;
}

/** 지금까지 띄운 프로그램 수. 실행 시도가 시작할 때의 값으로 그 실행 시도가 띄운 프로그램을 고른다(`programsFrom`). */
export function programCount(): number {
  return programs.length;
}

/** `from`번째 뒤로 띄운 프로그램. */
export function programsFrom(from: number): readonly WatchedProgram[] {
  return programs.slice(from);
}

/** 반환 뒤 판정에 쓰는 사실: 선언, 그 실행 시도가 띄운 수, 돌아올 때 끝나지 않은 수, 돌아온 뒤 띄운 수. */
export type SettleFacts = {
  launches: "programs" | "nothing";
  started: number;
  notEnded: number;
  startedAfterReturn: number;
};

/** 반환 뒤 활동의 원천(띄운 프로그램과 그 출력)이 닫혔는지 판정한다. 문제를 하나씩 문장으로 돌려준다. 없으면 빈 목록이다. */
export function settleProblems(facts: SettleFacts): string[] {
  const problems: string[] = [];
  if (facts.launches === "programs" && facts.started === 0)
    problems.push(
      "declares that its runs start programs, but this run started none"
    );
  if (facts.launches === "nothing" && facts.started > 0)
    problems.push(
      `declares that it starts nothing, but this run started ${facts.started}`
    );
  if (facts.notEnded > 0)
    problems.push(
      `${facts.notEnded} of the ${facts.started} programs the run started had not ended (or their end was not confirmed) when it returned`
    );
  if (facts.startedAfterReturn > 0)
    problems.push(
      `${facts.startedAfterReturn} programs started after the run returned`
    );
  return problems;
}

/**
 * 실행 시도 하나의 활동 기록. 돌아오기 전의 활동은 `activities`에, 돌아온 뒤의 활동은 `late`에 남기고 그 기록을 거절한다(던짐).
 * adapter가 그 거절을 처리해 버려도 `late`에 남아 시험이 끝날 때 드러난다.
 */
export function activityLog(name: string) {
  const activities: unknown[] = [];
  const late: unknown[] = [];
  let returned = false;
  return {
    activities,
    late,
    get returned() {
      return returned;
    },
    markReturned() {
      returned = true;
    },
    record(activity: unknown) {
      if (!returned) {
        activities.push(activity);
        return;
      }
      late.push(activity);
      throw new Error(
        `${name} emitted an activity after the run returned: ${JSON.stringify(activity)}`
      );
    },
  };
}
