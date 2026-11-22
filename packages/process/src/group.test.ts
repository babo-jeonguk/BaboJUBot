import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { stopProcessGroup } from "./group.ts";
import { exited, killAndWait, readyLine } from "./process-test-support.ts";

const fault = vi.hoisted(() => ({
  /** 이만큼의 `/proc` 목록 읽기가 먼저 실패한다(일시적인 조회 실패). */
  failedLooks: 0,
}));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    readdirSync: ((...args: Parameters<typeof real.readdirSync>) => {
      if (args[0] === "/proc" && fault.failedLooks > 0) {
        fault.failedLooks--;
        throw Object.assign(new Error("readdir EIO"), { code: "EIO" });
      }
      return real.readdirSync(...args);
    }) as typeof real.readdirSync,
  };
});

const pids: number[] = [];
afterEach(async () => {
  fault.failedLooks = 0;
  vi.restoreAllMocks();
  await killAndWait(pids.splice(0));
});

// 재시작 복구의 그룹 끄기도 한 신호가 실패했다고 다음 신호와 끝 확인을 건너뛰지 않는다(#274 외부 리뷰 3회차 STD-4).
it.skipIf(process.platform === "win32")(
  "still kills a group and confirms its end when its SIGTERM is refused",
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const group = child.pid!;
    pids.push(group);
    await readyLine(child, "ready");
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -group && signal === "SIGTERM")
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return kill(pid, signal);
    });
    await stopProcessGroup(group, { graceMs: 100 });
    expect(exited(group)).toBe(true);
  }
);

// 조회 실패는 그룹이 끝났다는 뜻이 아니고 일시적일 수 있다. 감독 실행기처럼 끝 확인의 시한까지 다시 본다(#274 외부 리뷰 3회차 뒤).
// 그룹을 `/proc`로 세는 것은 Linux뿐이다(macOS는 신호 0으로 본다).
it.runIf(process.platform === "linux")(
  "keeps looking at a group whose listing fails for a while, and stops it",
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const group = child.pid!;
    pids.push(group);
    await readyLine(child, "ready");
    fault.failedLooks = 3;
    await stopProcessGroup(group, { graceMs: 100 });
    expect(exited(group)).toBe(true);
  }
);
