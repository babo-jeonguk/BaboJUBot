import { attemptEach } from "@babojubot/contracts";

/** 시작 결과(서버는 시작 중에 멈추라고 했으면 없다)와 그 자원. */
export type Started = {
  server?: { close(): Promise<void>; progress?(): string };
  handle: { close(): Promise<void>; progress?(): string };
};

/**
 * 시작 결과를 받아 서버를 닫고 DB를 닫는다. 하나가 실패해도 나머지를 닫는다. 실패는 `report`로 알리고 false를 돌려준다.
 * 시작이 실패했으면 열린 자원은 시작 쪽이 이미 닫았으므로 그 실패만 알린다.
 * 닫는 동안 지금 하는 일을 `onStep`으로 알린다(정리 시한의 안내). 예: `the database (stopping Postgres (fast)) for 6.2s, after the start 0.0s, the server 2.1s`.
 */
export async function closeStarted(
  startup: Promise<Started>,
  report: (message: string, error: unknown) => void,
  onStep: (where: () => string) => void = () => {}
): Promise<boolean> {
  /** 끝난 단계와 걸린 시간. */
  const took: string[] = [];
  let current: string | undefined;
  let since = Date.now();
  const step = (name: string, detail: () => string | undefined) => {
    const now = Date.now();
    if (current) took.push(`${current} ${seconds(now - since)}`);
    current = name;
    since = now;
    onStep(() => {
      const shown = detail();
      return `${name}${shown ? ` (${shown})` : ""} for ${seconds(Date.now() - since)}${took.length ? `, after ${took.join(", ")}` : ""}`;
    });
  };
  step("the start", () => undefined);
  // 시작이 실패했으면 열린 자원은 시작 쪽이 이미 닫았다. 실패는 그대로 알린다.
  let started: Started;
  try {
    started = await startup;
  } catch (error) {
    report("[server] start failed", error);
    return false;
  }
  const { server, handle } = started;
  // 실패는 닫기가 끝나는 대로 알린다. 뒤 닫기가 정리 시한을 넘겨 멈춰도 앞 실패는 남는다. 진단에는 원인 코드만 남으므로(main.ts)
  // 어느 자원의 닫기가 실패했는지는 문구로 가른다.
  const close = async (name: string, resource: { close(): Promise<void> }) => {
    try {
      await resource.close();
    } catch (error) {
      report(`[server] closing ${name} failed`, error);
      throw error;
    }
  };
  const failures = await attemptEach([
    async () => {
      if (!server) return;
      step("the server", () => server.progress?.());
      await close("the server", server);
    },
    async () => {
      step("the database", () => handle.progress?.());
      await close("the database", handle);
    },
  ]);
  return failures.length === 0;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
