import type { Readable } from "node:stream";

// RED 뼈대(#294 외부 리뷰 2회차 SPEC-2-R1·REC-SPEC-1): 실행 시도 귀속·실제 시작 구분의 모양만 있고 아무것도 보지 않는다.
// 다음 커밋이 채운다.

export type Launch = {
  kind: "run" | "tree" | "command";
  started: "pending" | "yes" | "no";
  state: "running" | "ended" | "unconfirmed";
  end: Promise<void>;
};

export type Owner = {
  name: string;
  readonly returned: boolean;
  launches: Launch[];
  lateLaunches: Launch[];
  activities: unknown[];
  late: unknown[];
  readonly notEndedAtReturn: number | undefined;
  record(activity: unknown): void;
  markReturned(): void;
};

export function newOwner(name: string): Owner {
  let returned = false;
  const owner: Owner = {
    name,
    get returned() {
      return returned;
    },
    launches: [],
    lateLaunches: [],
    activities: [],
    late: [],
    notEndedAtReturn: 0,
    record(activity) {
      owner.activities.push(activity);
    },
    markReturned() {
      returned = true;
    },
  };
  return owner;
}

export function runAs<T>(_owner: Owner, work: () => T): T {
  return work();
}

export function takeUnowned(): Launch[] {
  return [];
}

type Tree = {
  started: Promise<{ kind: string }>;
  stop(...args: never[]): Promise<unknown>;
  stdout: Readable | null;
  stderr: Readable | null;
};

export function watchPrograms<
  M extends { startProcess: (...args: never[]) => { done: Promise<unknown> } },
>(real: M): M {
  return real;
}

export function watchProcessPackage<
  M extends {
    launchTree: (...args: never[]) => Tree;
    runTree: (...args: never[]) => Promise<{ started: boolean }>;
  },
>(real: M): M {
  return real;
}

export function watchingPrograms(): boolean {
  return true;
}

export function settleProblems(
  _owner: Owner,
  _launches?: "programs" | "nothing"
): string[] {
  return [];
}

export function lateProblems(_owner: Owner): string[] {
  return [];
}
