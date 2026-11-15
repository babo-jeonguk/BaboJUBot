/** 시작 결과(서버는 시작 중에 멈추라고 했으면 없다)와 그 자원. */
export type Started = {
  server?: { close(): Promise<void>; progress?(): string };
  handle: { close(): Promise<void> };
};

/**
 * 시작 결과를 받아 서버를 닫고 DB를 닫는다. 하나가 실패해도 나머지를 닫는다. 실패는 `report`로 알리고 false를 돌려준다.
 * 시작이 실패했으면 열린 자원은 시작 쪽이 이미 닫았으므로 그 실패만 알린다.
 * 닫는 동안 지금 닫는 것을 `onStep`으로 알린다(정리 시한의 안내).
 */
export async function closeStarted(
  startup: Promise<Started>,
  report: (message: string, error: unknown) => void,
  onStep: (where: () => string) => void = () => {}
): Promise<boolean> {
  let failed = false;
  onStep(() => "the start");
  // 시작이 실패했으면 열린 자원은 시작 쪽이 이미 닫았다. 실패는 그대로 알린다.
  const started = await startup.catch((error: unknown) => {
    failed = true;
    report("[server] start failed", error);
  });
  if (!started) return false;
  const close = async (resource: { close(): Promise<void> }) => {
    await resource.close().catch((error: unknown) => {
      failed = true;
      report("[server] shutdown failed", error);
    });
  };
  const server = started.server;
  if (server) {
    onStep(() => {
      const progress = server.progress?.();
      return progress ? `the server (${progress})` : "the server";
    });
    await close(server);
  }
  onStep(() => "the database");
  await close(started.handle);
  return !failed;
}
