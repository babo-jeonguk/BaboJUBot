import { expect, test } from "@playwright/test";
import { startIsolatedServer } from "./isolated-server.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("stopping a server that is still running succeeds", async () => {
  const server = await startIsolatedServer();
  await expect(server.stop()).resolves.toBeUndefined();
  expect(alive(server.pid)).toBe(false);
});

test("a server that ended on its own during the test fails the teardown, even with exit code 0", async () => {
  const server = await startIsolatedServer();
  // fixture가 멈추라고 하기 전에 서버가 정상 정리 경로(SIGTERM → 종료 코드 0)로 스스로 끝난다.
  process.kill(server.pid, "SIGTERM");
  await expect.poll(() => alive(server.pid), { timeout: 20_000 }).toBe(false);
  await expect(server.stop()).rejects.toThrow(/테스트 중에 끝났다/);
});
