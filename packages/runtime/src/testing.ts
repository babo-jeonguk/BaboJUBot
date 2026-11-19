import type { IncomingMessage, ServerResponse } from "node:http";
import type { OrgToolName, RuntimeAdapter } from "@babojubot/contracts";
import {
  createScriptedRuntime,
  type FakeProviderSettings,
  type Script,
  type ScriptStep,
} from "./scripted.ts";

/**
 * 가짜 프로바이더의 선언(지원하는 일·준비 확인·로그인 명령)만. 검사가 `execute`를 직접 쓰는 adapter에 붙인다.
 * 그 adapter는 가짜 프로바이더의 실행을 쓰지 않으므로 끼워 넣기는 늘 거절된다.
 */
export function fakeDeclarations(
  settings?: FakeProviderSettings
): Omit<RuntimeAdapter, "execute"> {
  const { execute: _execute, ...declarations } = createScriptedRuntime({
    settings,
  });
  return declarations;
}

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
    async wait(signal) {
      markReached();
      signal.throwIfAborted();
      let abort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([opened, aborted]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
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

/**
 * 가짜 HTTP 서버(`http.createServer`)에 넘길 요청 처리기. 비동기 처리기가 실패하면 두 곳에 알린다.
 * - 요청한 쪽: 응답을 아직 시작하지 않았으면 500과 오류 문구로, 시작했으면 연결을 끊는다. 요청이 응답 없이 멈추지 않는다.
 * - 러너: 같은 오류를 잡히지 않은 오류로 다시 던진다. Vitest는 그 실행을 실패로 알리므로, 요청한 쪽(시험 대상)이 500을 넘겨
 *   버려도 가짜 서버의 고장이 통과로 묻히지 않는다(CODING_STANDARDS.md#단언).
 */
export function answering(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      // 응답을 다 보낸 뒤에 던진다. 먼저 던지면 실행이 끝나며 응답이 끊길 수 있다.
      const report = () =>
        setImmediate(() => {
          throw new Error(
            `가짜 HTTP 서버가 ${req.method} ${req.url}을 처리하지 못했다`,
            { cause: failure }
          );
        });
      if (res.headersSent) {
        res.destroy(failure);
        report();
      } else
        res
          .writeHead(500, { "content-type": "text/plain" })
          .end(
            `fake server failed: ${failure.stack ?? failure.message}`,
            report
          );
    });
  };
}
