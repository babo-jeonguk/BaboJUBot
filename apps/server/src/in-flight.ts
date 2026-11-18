import type express from "express";
import { settled } from "@babojubot/contracts";

/**
 * 서버가 받은 요청의 처리기와 서버가 기다리지 않고 시작한 DB 작업이 끝났는지 센다. 서버를 끌 때 DB를 닫기 전에 모두 기다리는 데 쓴다.
 * 연결이 아니라 처리기를 센다. 실행 시도가 멈춰 요청을 보낸 쪽이 먼저 떠나도 서버 쪽 처리기는 계속 돌며 DB를 쓰기 때문이다.
 */
export class InFlight {
  /** 끝나지 않은 일과 그 이름. */
  private running = new Map<symbol, string>();
  private waiters: (() => void)[] = [];

  /** 일 하나를 `label`로 센다. promise면 끝날 때까지, 아니면 바로 끝난 것으로 본다. 돌려준 값은 그대로다. */
  track<T>(work: () => T, label: string): T {
    const id = Symbol(label);
    this.running.set(id, label);
    let value: T;
    try {
      value = work();
    } catch (error) {
      this.leave(id);
      throw error;
    }
    if (value instanceof Promise)
      void settled(value).then(() => this.leave(id));
    else this.leave(id);
    return value;
  }

  /** 세고 있는 일이 모두 끝나면 풀린다. 그 사이 새로 시작한 일도 기다린다. */
  idle(): Promise<void> {
    if (this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 끝나지 않은 일의 이름. 같은 이름은 한 번만, 시작한 순서로. */
  pending(): string[] {
    return [...new Set(this.running.values())];
  }

  private leave(id: symbol) {
    this.running.delete(id);
    if (this.running.size > 0) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

type Layer = {
  handle: ((...args: unknown[]) => unknown) & { stack?: Layer[] };
  route?: { stack: Layer[] };
};

/** 이미 세는 stack. 앱 둘이 같은 router를 달아도 한 번만 센다. 한 stack은 한 InFlight만 센다. */
const watched = new WeakSet<Layer[]>();

/**
 * 앱에 건 처리기를 모두 `inFlight`로 센다. 지금 걸린 것과 이 뒤에 앱·하위 router·경로에 거는 것 모두다
 * (채널은 서버가 시작한 뒤 경로를 건다). 앱을 만든 직후 한 번 부른다. 오류 처리기는 인자 4개를 유지해야 Express가 알아본다.
 * Express 5(router 2)가 층을 각 stack 배열에 `push`로 더하는 것에 기댄다. 판을 올리면 `in-flight.test.ts`가 이것을 확인한다.
 * `express()` 앱을 하위 앱으로 달면 그 안의 처리기는 세지 못하므로 하위에는 `express.Router()`를 단다.
 */
export function trackHandlers(app: express.Express, inFlight: InFlight) {
  const adopt = (layer: Layer) => {
    if (layer.route) watch(layer.route.stack);
    else if (layer.handle.stack) watch(layer.handle.stack);
    else layer.handle = wrap(layer.handle, inFlight);
  };
  const watch = (stack: Layer[]) => {
    if (watched.has(stack)) return;
    watched.add(stack);
    stack.forEach(adopt);
    const push = stack.push.bind(stack);
    stack.push = (...layers: Layer[]) => {
      layers.forEach(adopt);
      return push(...layers);
    };
  };
  watch((app.router as unknown as { stack: Layer[] }).stack);
}

function wrap(handle: Layer["handle"], inFlight: InFlight): Layer["handle"] {
  return handle.length === 4
    ? function (this: unknown, error, req, res, next) {
        return inFlight.track(
          () => handle.call(this, error, req, res, next),
          requestLabel(req)
        );
      }
    : function (this: unknown, req, res, next) {
        return inFlight.track(
          () => handle.call(this, req, res, next),
          requestLabel(req)
        );
      };
}

/** 요청의 이름: 방법과 경로(query 제외). 예: `GET /api/inbox`. */
function requestLabel(req: unknown) {
  const { method, originalUrl } = req as {
    method: string;
    originalUrl: string;
  };
  return `${method} ${originalUrl.split("?")[0]}`;
}
