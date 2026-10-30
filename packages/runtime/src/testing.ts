import type { OrgToolName } from "@babojubot/contracts";
import type { Script, ScriptStep } from "./scripted.ts";

/**
 * 가짜 프로바이더 시나리오를 멈춰 두는 문. `wait`는 시나리오의 `hold` 단계에 넘기고,
 * 테스트는 `reached`로 실행 시도가 그 단계에 닿았음을 확인한 뒤 `open`으로 보낸다. 취소되면 `wait`가 reject한다.
 */
export type Gate = {
  wait: (signal: AbortSignal) => Promise<void>;
  reached: Promise<void>;
  open: () => void;
};

export function createGate(): Gate {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (markReached = r));
  const opened = new Promise<void>((r) => (release = r));
  return {
    reached,
    open: () => release(),
    wait(signal) {
      markReached();
      return new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        void opened.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    },
  };
}

/**
 * 시나리오에서 `stops`에 맞는 단계(`then`이 정하는 단계 포함) 바로 뒤에 `hold`를 넣는다. 그 쓰기가 commit된 직후에
 * 서버가 멈추는 시점을 재현한다. 단계의 `when`이 거짓이어도 멈춘다.
 */
export function holdAfter(
  script: Script,
  stops: (step: ScriptStep) => boolean,
  until: (signal: AbortSignal) => Promise<void>
): Script {
  const insert = (steps: ScriptStep[]): ScriptStep[] =>
    steps.flatMap((step): ScriptStep[] =>
      step.do === "then"
        ? [{ do: "then", steps: (state) => insert(step.steps(state)) }]
        : stops(step)
          ? [step, { do: "hold", until }]
          : [step]
    );
  return { ...script, steps: insert(script.steps) };
}

/** 이 조직 도구 호출(`send_message`는 Lead 대화 답장) 단계인가. */
export const writes =
  (tool: OrgToolName | "send_message") => (step: ScriptStep) =>
    step.do === "send_message"
      ? tool === "send_message"
      : step.do === "call" && step.tool === tool;
