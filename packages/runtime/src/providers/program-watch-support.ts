import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable } from "node:stream";

// 계약 시험(runtime-contract.ts)이 실행 시도가 띄운 것을 그 실행 시도에 귀속해 보고, 돌아온 뒤를 판정한다. 판정·활동 기록·수집과
// 귀속을 계약 시험 밖의 작은 단위로 떼어 program-watch-support.test.ts가 결함 사례로 시험한다(#294 외부 리뷰 1회차 SPEC-2,
// 2회차 SPEC-2-R1·REC-SPEC-1).
//
// 실행 시도 중 runtime이 프로그램을 띄우는 길은 `@babojubot/process`의 공용 실행 `launchTree`·`runTree` 둘뿐이다(lint
// `product/no-direct-launch`가 child_process·cross-spawn을 정해진 파일로 제한한다). 그 위에 `startProcess`(실행 시도, `done`이
// "프로그램이 끝나고 출력 처리도 끝났다"), `runProbe`·`runDocker`(짧은 확인 명령), Antigravity 설정 정리가 선다. 직접 띄우는
// `login.ts`의 대화형 로그인(`runLogin`)은 adapter와 서버가 부르지 않고, `@babojubot/process/recovery`는 서버 재시작 복구에서만
// 프로그램을 띄운다. 계약 시험 파일은 `./providers/process.ts`(`watchPrograms`)와 `@babojubot/process`(`watchProcessPackage`)를
// `vi.mock`으로 감싸 두 층을 모두 본다.
//
// 띄운 것은 세 가지로 센다. `tree`(공용 실행 `launchTree`)와 `command`(`runTree`)는 프로그램이고, 실제로 시작했는지(`started`)와
// 끝(`state`)을 따로 본다. `run`(`startProcess`)은 프로그램이 아니라 그 아래 `tree` 하나의 출력 처리 경계라 프로그램 수에 넣지 않고
// 끝만 본다. 띄우는 순간 지금의 실행 시도 문맥(`AsyncLocalStorage`)에 귀속한다. 타이머·promise 이어짐·입출력 콜백은 그것을
// 일으킨 실행 시도의 문맥에서 돈다.

/** 띄운 것 하나. */
export type Launch = {
  kind: "run" | "tree" | "command";
  /** 실제로 시작했는지. `run`은 그 아래 `tree`가 센다(`yes`로 둔다). */
  started: "pending" | "yes" | "no";
  /** `running`은 아직 끝을 보지 못함, `ended`는 끝 신호를 봄, `unconfirmed`는 끝 신호가 실패로 끝남(끝난 것으로 치지 않는다). */
  state: "running" | "ended" | "unconfirmed";
  /** 상태가 정해지기를 기다린다(거절하지 않는다). */
  end: Promise<void>;
};

/** 실행 시도(또는 준비 확인) 하나: 그것이 띄운 것과 낸 활동. 돌아온 뒤의 것은 따로 둔다. */
export type Owner = {
  name: string;
  readonly returned: boolean;
  /** 돌아오기 전에 띄운 것. */
  launches: Launch[];
  /** 돌아온 뒤에 띄운 것. */
  lateLaunches: Launch[];
  activities: unknown[];
  late: unknown[];
  /** 돌아올 때 끝나지 않았던 것의 수. 돌아오기 전에는 없다. */
  readonly notEndedAtReturn: number | undefined;
  /** 활동 하나를 기록한다. 돌아온 뒤면 `late`에 남기고 거절한다(던짐). */
  record(activity: unknown): void;
  /** 돌아왔다. 그 순간 끝나지 않은 것을 센다. */
  markReturned(): void;
};

export function newOwner(name: string): Owner {
  let returned = false;
  let notEndedAtReturn: number | undefined;
  const owner: Owner = {
    name,
    get returned() {
      return returned;
    },
    launches: [],
    lateLaunches: [],
    activities: [],
    late: [],
    get notEndedAtReturn() {
      return notEndedAtReturn;
    },
    record(activity) {
      if (!returned) {
        owner.activities.push(activity);
        return;
      }
      owner.late.push(activity);
      throw new Error(
        `${name} emitted an activity after the run returned: ${JSON.stringify(activity)}`
      );
    },
    markReturned() {
      returned = true;
      notEndedAtReturn = owner.launches.filter(
        (launch) => launch.state !== "ended"
      ).length;
    },
  };
  return owner;
}

const owners = new AsyncLocalStorage<Owner>();
/** 어느 실행 시도에도 귀속되지 않고 띄운 것. 계약 시험은 시험마다 이것이 비어 있는지 본다. */
let unowned: Launch[] = [];
const watched = { processModule: false, processPackage: false };

/** `work`와 그것이 일으킨 비동기 일을 `owner`의 문맥에서 돌린다. 그 안에서 띄운 것은 `owner`에 귀속된다. */
export function runAs<T>(owner: Owner, work: () => T): T {
  return owners.run(owner, work);
}

/** 귀속되지 않은 것을 꺼내고 비운다. */
export function takeUnowned(): Launch[] {
  const taken = unowned;
  unowned = [];
  return taken;
}

/** 띄운 것 하나를 지금의 문맥에 귀속한다. 돌아온 실행 시도면 그 실행 시도의 늦은 것으로, 문맥이 없으면 귀속 없음으로 둔다. */
function attribute(launch: Launch) {
  const owner = owners.getStore();
  if (!owner) unowned.push(launch);
  else if (owner.returned) owner.lateLaunches.push(launch);
  else owner.launches.push(launch);
}

/** 끝 신호 하나로 띄운 것을 만든다. 이행하면 `ended`, 거절하면 `unconfirmed`. */
function launched(
  kind: Launch["kind"],
  ending: Promise<unknown>,
  started: Launch["started"]
): Launch {
  const launch: Launch = {
    kind,
    started,
    state: "running",
    end: ending.then(
      () => {
        launch.state = "ended";
      },
      () => {
        launch.state = "unconfirmed";
      }
    ),
  };
  attribute(launch);
  return launch;
}

/** 흐름이 닫히면 이행한다. 없거나 이미 닫혔으면 바로 이행한다. */
function closed(stream: Readable | null): Promise<void> {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise<void>((resolve) => stream.once("close", () => resolve()));
}

/**
 * `vi.mock("./providers/process.ts", …)`의 factory에서 부른다. `startProcess`의 `done`(프로그램이 끝나고 출력 처리도 끝났다)을
 * `run`으로 본다. adapter보다 먼저 `done`에 붙으므로, adapter가 `done`을 기다린 뒤 돌아오면 그 전에 상태가 정해진다.
 */
export function watchPrograms<
  M extends { startProcess: (...args: never[]) => { done: Promise<unknown> } },
>(real: M): M {
  watched.processModule = true;
  const startProcess = ((...args: Parameters<M["startProcess"]>) => {
    const started = real.startProcess(...args);
    launched("run", started.done, "yes");
    return started;
  }) as M["startProcess"];
  return { ...real, startProcess };
}

type Tree = {
  started: Promise<{ kind: string }>;
  stop(...args: never[]): Promise<unknown>;
  stdout: Readable | null;
  stderr: Readable | null;
};

/**
 * `vi.mock("@babojubot/process", …)`의 factory에서 부른다. 공용 실행으로 띄운 것을 모두 본다. `launchTree`의 트리는 `started`가
 * `running`이면 시작한 것이고, `stop()`이 이행하고(트리 전체가 끝난 것을 확인) 출력이 닫혔을 때 끝난 것이다. `stop()`을 부르지 않은
 * 트리는 끝나지 않은 것이다. `runTree`는 결과의 `started`가 참이면 시작한 것이고, 결과가 이행했을 때 끝난 것이다.
 */
export function watchProcessPackage<
  M extends {
    launchTree: (...args: never[]) => Tree;
    runTree: (...args: never[]) => Promise<{ started: boolean }>;
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
    const launch = launched(
      "tree",
      Promise.all([stopped, closed(tree.stdout), closed(tree.stderr)]),
      "pending"
    );
    tree.started.then(
      (start) => {
        launch.started = start.kind === "running" ? "yes" : "no";
      },
      () => {
        launch.started = "no";
      }
    );
    // 받은 트리는 고치지 않는다. 같은 트리에 끄기의 결과만 기록하는 `stop`을 붙인 사본을 돌려준다(원래 `stop`을 그대로 부른다).
    return {
      ...tree,
      stop: ((...stopArgs: never[]) => {
        const stopping = tree.stop(...stopArgs);
        stopping.then(markStopped, markStopFailed);
        return stopping;
      }) as Tree["stop"],
    };
  }) as M["launchTree"];
  const runTree = ((...args: Parameters<M["runTree"]>) => {
    const run = real.runTree(...args);
    const launch = launched("command", run, "pending");
    run.then(
      (result) => {
        launch.started = result.started ? "yes" : "no";
      },
      () => {
        launch.started = "no";
      }
    );
    return run;
  }) as M["runTree"];
  return { ...real, launchTree, runTree };
}

/** 이 파일이 두 층(`./providers/process.ts`, `@babojubot/process`)을 모두 보고 있는지. 보지 않는 채로 "프로그램 없음"이라고 판정하지 않는다. */
export function watchingPrograms(): boolean {
  return watched.processModule && watched.processPackage;
}

const programs = (n: number) => `${n} program${n === 1 ? "" : "s"}`;

/**
 * 돌아온 실행 시도를 판정한다: 선언(`launches`, 주면)과 실제로 시작한 프로그램 수가 맞는지, 돌아올 때 끝나지 않은 것이 있었는지.
 * 문제를 하나씩 문장으로 돌려준다. 없으면 빈 목록이다. 돌아오기 전에 부르면 던진다.
 */
export function settleProblems(
  owner: Owner,
  launches?: "programs" | "nothing"
): string[] {
  const notEnded = owner.notEndedAtReturn;
  if (notEnded === undefined)
    throw new Error(`${owner.name}: the run has not returned yet`);
  const started = owner.launches.filter(
    (launch) => launch.kind !== "run" && launch.started === "yes"
  ).length;
  const problems: string[] = [];
  if (launches === "programs" && started === 0)
    problems.push(
      "declares that its runs start programs, but this run started none"
    );
  if (launches === "nothing" && started > 0)
    problems.push(
      `declares that it starts nothing, but this run started ${programs(started)}`
    );
  if (notEnded > 0)
    problems.push(
      `${notEnded} of the ${owner.launches.length} launches the run made had not ended (or their end was not confirmed) when it returned`
    );
  return problems;
}

/** 돌아온 뒤에 생긴 일(활동, 띄운 것)을 문장으로 돌려준다. 시험이 끝날 때 본다. */
export function lateProblems(owner: Owner): string[] {
  return [
    ...owner.late.map(
      (activity) =>
        `${owner.name} emitted an activity after the run returned: ${JSON.stringify(activity)}`
    ),
    ...(owner.lateLaunches.length > 0
      ? [
          `${owner.name} launched ${programs(owner.lateLaunches.length)} after the run returned`,
        ]
      : []),
  ];
}
