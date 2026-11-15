import type express from "express";

/**
 * 서버가 받은 요청의 처리기가 끝났는지 센다. 서버를 끌 때 DB를 닫기 전에 처리 중인 처리기를 모두 기다리는 데 쓴다.
 * 연결이 아니라 처리기를 센다. 실행 시도가 멈춰 요청을 보낸 쪽이 먼저 떠나도 서버 쪽 처리기는 계속 돌며 DB를 쓰기 때문이다.
 */
export class InFlight {
  private count = 0;
  private waiters: (() => void)[] = [];

  /** 일 하나를 센다. promise면 끝날 때까지, 아니면 바로 끝난 것으로 본다. 돌려준 값은 그대로다. */
  track<T>(work: () => T): T {
    this.count++;
    let value: T;
    try {
      value = work();
    } catch (error) {
      this.leave();
      throw error;
    }
    if (value instanceof Promise)
      value.then(
        () => this.leave(),
        () => this.leave()
      );
    else this.leave();
    return value;
  }

  /** 세고 있는 일이 모두 끝나면 풀린다. 그 사이 새로 시작한 일도 기다린다. */
  idle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private leave() {
    if (--this.count > 0) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

type Layer = {
  handle: ((...args: unknown[]) => unknown) & { stack?: Layer[] };
  route?: { stack: Layer[] };
};

/**
 * 앱에 건 모든 처리기(하위 router와 경로 처리기 포함)를 `inFlight`로 센다. 경로를 모두 건 뒤, 요청을 받기 전에 한 번 부른다.
 * 경로마다 손으로 감싸지 않으므로 새 경로도 빠지지 않는다. 오류 처리기는 인자 4개를 유지해야 Express가 오류 처리기로 알아본다.
 */
export function trackHandlers(app: express.Express, inFlight: InFlight) {
  const seen = new WeakSet<Layer[]>();
  const visit = (stack: Layer[]) => {
    if (seen.has(stack)) return;
    seen.add(stack);
    for (const layer of stack) {
      if (layer.route) visit(layer.route.stack);
      else if (layer.handle.stack) visit(layer.handle.stack);
      else layer.handle = wrap(layer.handle, inFlight);
    }
  };
  visit((app.router as unknown as { stack: Layer[] }).stack);
}

function wrap(handle: Layer["handle"], inFlight: InFlight): Layer["handle"] {
  return handle.length === 4
    ? function (this: unknown, error, req, res, next) {
        return inFlight.track(() => handle.call(this, error, req, res, next));
      }
    : function (this: unknown, req, res, next) {
        return inFlight.track(() => handle.call(this, req, res, next));
      };
}
