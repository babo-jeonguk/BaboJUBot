import { expect, test } from "@playwright/test";
import { startIsolatedServer } from "./isolated-server.ts";
import { goalInput } from "./organization.ts";

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

test("a clock server records and cuts days by the time the test sets, not the wall clock", async ({
  request,
}) => {
  const server = await startIsolatedServer({
    clock: "2026-03-10T14:59:00.000Z",
  });
  try {
    const created = await request.post(`${server.url}/api/organizations`, {
      data: { name: "시계 조직", ...goalInput },
    });
    expect(created.status()).toBe(201);
    const org = (await created.json()) as { id: string };
    // 생성으로 깨어난 Lead의 실행 시도는 서버 시계로 시작·종료 시각을 적는다.
    await expect
      .poll(async () =>
        (
          (await (
            await request.get(`${server.url}/api/organizations/${org.id}/runs`)
          ).json()) as { startedAt: string; finishedAt: string | null }[]
        ).map((r) => [r.startedAt, r.finishedAt])
      )
      .toEqual([["2026-03-10T14:59:00.000Z", "2026-03-10T14:59:00.000Z"]]);
    const dashboard = async () =>
      (await (
        await request.get(
          `${server.url}/api/organizations/${org.id}/dashboard?timeZone=Asia/Seoul`
        )
      ).json()) as { asOf: string; days: { date: string }[] };
    expect((await dashboard()).days.at(-1)!.date).toBe("2026-03-10");
    // 시계는 멈춰 있다가 옮긴 시각부터 그 시각이다.
    await server.setNow("2026-03-10T15:00:01.000Z");
    const after = await dashboard();
    expect(after.asOf).toBe("2026-03-10T15:00:01.000Z");
    expect(after.days.at(-1)!.date).toBe("2026-03-11");
    await expect(server.setNow("어제")).rejects.toThrow(/시각이 아니다/);
  } finally {
    await server.stop();
  }
});

test("only a server started with a clock can move it", async () => {
  const server = await startIsolatedServer();
  try {
    await expect(server.setNow("2026-03-10T15:00:01.000Z")).rejects.toThrow(
      /`clock`/
    );
  } finally {
    await server.stop();
  }
});
