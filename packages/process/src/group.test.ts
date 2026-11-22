import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { stopProcessGroup } from "./group.ts";
import { exited, killAndWait, readyLine } from "./process-test-support.ts";

const pids: number[] = [];
afterEach(async () => {
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
