import { startProcess } from "./process.ts";

/**
 * Codex app-server 연결 하나(#145). 모델 목록·실행 시도·로그인 갱신이 함께 쓰는 연결 처리다.
 * 요청 ID·응답 짝짓기·대기 중인 요청·timer·닫힘을 이 연결이 끝까지 맡는다. 대기는 연결마다 따로이며 다른 연결로 넘기지 않는다.
 * 결과를 모르는 요청을 다시 보내거나 새 세션을 고르지 않는다. 그런 판단과 시한은 부르는 쪽이 정한다.
 * 프로세스·자식·컨테이너·중계의 실제 정리는 startProcess가 맡고, 그 완료는 `done`이다.
 */

/** 프로그램이 요청을 명시적으로 거절했다(오류 응답). */
export class ProtocolRejection extends Error {
  constructor() {
    super("Protocol request rejected");
  }
}
/** 정한 시간 안에 응답이 없었다. 거절도 성공도 아니다. 연결은 그대로이며 닫을지는 부르는 쪽이 정한다. */
export class ProtocolTimeout extends Error {
  constructor() {
    super("Protocol response timed out");
  }
}
/** 응답 전에 연결이 닫혔거나(종료 요청·프로세스 종료·쓰기 실패) 이미 닫힌 연결이다. */
export class ProtocolClosed extends Error {
  constructor() {
    super("Protocol closed");
  }
}

export type RequestOptions = {
  /** 이 요청의 응답 제한(ms). 0 이하면 보내지 않고 시간 초과로 끝낸다. 전체 시한을 이어 쓰려면 남은 시간을 넘긴다. */
  timeoutMs: number;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function openCodexConnection(
  options: Omit<Parameters<typeof startProcess>[0], "onFrame"> & {
    /** 서버 알림(ID 없는 method 프레임). 프레임 처리 순서 안에서 부르므로 다음 요청을 기다리지 말고 곧 돌아와야 한다. */
    onNotification?: (frame: Record<string, unknown>) => void;
  }
) {
  const { onNotification, ...launch } = options;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let sequence = 0,
    closed = false;
  /** 요청 하나를 한 번만 끝낸다. 이미 끝났으면 아무것도 하지 않는다. */
  const settle = (
    id: number,
    outcome: { result: Record<string, unknown> } | { error: Error }
  ) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if ("error" in outcome) waiter.reject(outcome.error);
    else waiter.resolve(outcome.result);
  };
  /** 닫힘을 먼저 정해 새 요청을 막고, 남은 대기를 모두 오류로 끝낸다. */
  const markClosed = () => {
    closed = true;
    for (const id of [...pending.keys()])
      settle(id, { error: new ProtocolClosed() });
  };
  const child = startProcess({
    ...launch,
    // 응답은 나눠 주기만 하고 곧 돌아온다. 다음 요청은 이 순서 밖에서 기다린다(교착 방지).
    onFrame: async (raw) => {
      const frame = record(raw);
      if (frame.method === undefined) {
        if (typeof frame.id === "number")
          settle(
            frame.id,
            frame.error
              ? { error: new ProtocolRejection() }
              : { result: record(frame.result) }
          );
        return;
      }
      // ID가 있는 서버 요청은 응답으로 오인하지도, 알림으로 넘기지도 않는다.
      if (frame.id === undefined) onNotification?.(frame);
    },
  });
  // 예고 없이 끝나도 같은 길로 닫는다. 정리 완료(done)를 기다리지 않고 대기를 바로 끝낸다.
  void child.exited.then(markClosed);
  const write = (frame: unknown) => {
    try {
      return child.write(frame);
    } catch {
      return false;
    }
  };
  const request = (
    method: string,
    params: unknown,
    { timeoutMs }: RequestOptions
  ) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (closed) return reject(new ProtocolClosed());
      if (!(timeoutMs > 0)) return reject(new ProtocolTimeout());
      const id = ++sequence;
      // 보내기 전에 등록한다. 응답이 아무리 빨라도 짝을 잃지 않는다.
      pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(
          () => settle(id, { error: new ProtocolTimeout() }),
          timeoutMs
        ),
      });
      if (!write({ id, method, params })) {
        settle(id, { error: new ProtocolClosed() });
        close();
      }
    });
  const notify = (method: string, params?: unknown) =>
    !closed && write(params === undefined ? { method } : { method, params });
  /** 닫기를 요청한다. 대기는 곧바로 끝나고, 프로세스는 입력을 닫은 뒤 정해진 순서로 끝난다. */
  const close = () => {
    markClosed();
    child.end();
  };
  return {
    request,
    notify,
    /** initialize 요청 뒤 initialized 알림까지의 handshake. */
    async initialize(options: RequestOptions) {
      const result = await request(
        "initialize",
        { clientInfo: { name: "babojubot", version: "0.0.0" } },
        options
      );
      if (!notify("initialized")) throw new ProtocolClosed();
      return result;
    },
    close,
    get closed() {
      return closed;
    },
    /** 프로세스·자식·컨테이너·중계 정리까지 끝났다. */
    done: child.done,
  };
}
