import type * as processModule from "./process.ts";

// 계약 시험(runtime-contract.ts)이 실행 시도가 띄운 프로그램의 끝을 보는 길. 프로바이더 adapter는 프로그램을 모두 공용 실행
// `startProcess`로 띄우고, 그 `done`이 "프로그램이 끝나고 그 출력의 처리도 끝났다"는 신호다. 계약 시험 파일이 이 모듈로
// `./providers/process.ts`를 감싸면(`vi.mock`의 factory에서 `watchPrograms`) 띄운 프로그램을 모두 기록한다. 반환 뒤 활동이 생길 수
// 있는 원천(띄운 프로그램과 그 출력)이 닫혔는지를 시간이 아니라 이 신호로 본다(#294 외부 리뷰 1회차 SPEC-2).

type ProcessModule = typeof processModule;

/** 띄운 프로그램 하나. `ended`는 그 `done`이 끝났는지(이행·거절)이고, `end`는 그 끝을 기다린다(거절하지 않는다). */
export type WatchedProgram = { ended: boolean; end: Promise<void> };

const programs: WatchedProgram[] = [];
let watching = false;

/** `vi.mock("./providers/process.ts", …)`의 factory에서 부른다. 진짜 모듈의 `startProcess`를 기록하며 띄우는 것으로 바꾼다. */
export function watchPrograms(real: ProcessModule): ProcessModule {
  watching = true;
  const startProcess: ProcessModule["startProcess"] = (options) => {
    const started = real.startProcess(options);
    const program: WatchedProgram = {
      ended: false,
      // adapter보다 먼저 `done`에 붙는다. adapter가 `done`을 기다린 뒤 돌아오면, 그 전에 `ended`가 참이 된다.
      end: started.done.then(
        () => {
          program.ended = true;
        },
        () => {
          program.ended = true;
        }
      ),
    };
    programs.push(program);
    return started;
  };
  return { ...real, startProcess };
}

/** 이 파일이 프로그램을 보고 있는지. 계약 시험은 보지 않는 채로 "띄운 프로그램 없음"이라고 판정하지 않는다. */
export function watchingPrograms(): boolean {
  return watching;
}

/** 지금까지 띄운 프로그램 수. 실행 시도가 시작할 때의 값으로 그 실행 시도가 띄운 프로그램을 고른다(`programsFrom`). */
export function programCount(): number {
  return programs.length;
}

/** `from`번째 뒤로 띄운 프로그램. */
export function programsFrom(from: number): readonly WatchedProgram[] {
  return programs.slice(from);
}
