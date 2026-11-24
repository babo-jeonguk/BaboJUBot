import { failureCode } from "@babojubot/contracts";

/**
 * 한 실행 시도에서 이미 남긴 격리 중계 거부를 기억한다. 같은 거부(같은 키)는 실행 시도마다 한 번만 남기고,
 * 서로 다른 거부도 정해진 수(`limit`)까지만 남긴다. 실행 시도가 끝나면 그 실행 시도의 상태를 버리므로
 * 서버 메모리가 실행 이력에 비례해 늘지 않는다.
 * 키는 저장 전에 먼저 차지한다. 저장이 도는 동안 같은 거부가 다시 와도 두 번 쓰지 않고, 저장이 실패하면
 * 그 키를 놓아 나중에 같은 거부를 다시 남길 수 있게 한다.
 */
export class RefusalLog {
  readonly #write: (runId: string, text: string) => Promise<boolean>;
  readonly #running: (runId: string) => boolean;
  readonly #limit: number;
  readonly #runs = new Map<string, Set<string>>();

  constructor(options: {
    /** 거부 하나를 실행 활동에 남긴다. 실행 시도가 이미 끝나 남지 않았으면 false. */
    write: (runId: string, text: string) => Promise<boolean>;
    /** 실행 시도가 아직 도는가. */
    running: (runId: string) => boolean;
    /** 실행 시도마다 남기는 서로 다른 거부의 상한. 기본 50. */
    limit?: number;
  }) {
    this.#write = options.write;
    this.#running = options.running;
    this.#limit = options.limit ?? 50;
  }

  async record(runId: string, key: string, text: string): Promise<void> {
    if (!this.#running(runId)) return;
    let seen = this.#runs.get(runId);
    if (!seen) {
      seen = new Set();
      this.#runs.set(runId, seen);
    }
    if (seen.has(key) || seen.size >= this.#limit) return;
    seen.add(key);
    try {
      if (!(await this.#write(runId, text))) this.#runs.delete(runId);
    } catch (error) {
      this.#runs.get(runId)?.delete(key);
      console.warn(
        `[isolation] could not record a relay refusal (${failureCode(error)})`
      );
    }
  }

  finished(runId: string): void {
    this.#runs.delete(runId);
  }

  get trackedRuns(): number {
    return this.#runs.size;
  }
}
