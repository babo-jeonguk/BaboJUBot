import type { Readable } from "node:stream";

// RED 뼈대(#294 외부 리뷰 1회차 SPEC-2 parent 점검): `startProcess` 관찰만 있고, 판정·활동 기록·공용 실행 관찰은 모양만 있다. 다음 커밋이 채운다.

export type WatchedProgram = {
  state: "running" | "ended" | "unconfirmed";
  end: Promise<void>;
};

const programs: WatchedProgram[] = [];

type Tree = {
  stop(...args: never[]): Promise<unknown>;
  stdout: Readable | null;
  stderr: Readable | null;
};

export function watchPrograms<
  M extends { startProcess: (...args: never[]) => { done: Promise<unknown> } },
>(real: M): M {
  const startProcess = ((...args: Parameters<M["startProcess"]>) => {
    const started = real.startProcess(...args);
    const program: WatchedProgram = {
      state: "running",
      end: started.done.then(
        () => {
          program.state = "ended";
        },
        () => {
          program.state = "unconfirmed";
        }
      ),
    };
    programs.push(program);
    return started;
  }) as M["startProcess"];
  return { ...real, startProcess };
}

export function watchProcessPackage<
  M extends {
    launchTree: (...args: never[]) => Tree;
    runTree: (...args: never[]) => Promise<unknown>;
  },
>(real: M): M {
  return real;
}

export function watchingPrograms(): boolean {
  return true;
}

export function programCount(): number {
  return programs.length;
}

export function programsFrom(from: number): readonly WatchedProgram[] {
  return programs.slice(from);
}

export type SettleFacts = {
  launches: "programs" | "nothing";
  started: number;
  notEnded: number;
  startedAfterReturn: number;
};

export function settleProblems(_facts: SettleFacts): string[] {
  return [];
}

export function activityLog(_name: string) {
  const activities: unknown[] = [];
  const late: unknown[] = [];
  return {
    activities,
    late,
    returned: false,
    markReturned() {},
    record(activity: unknown) {
      activities.push(activity);
    },
  };
}
