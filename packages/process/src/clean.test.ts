import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { leaseVariable } from "./lease.ts";
import { attemptAll } from "@babojubot/contracts";
import { endChild, exited, readyLine } from "./process-test-support.ts";
import { cleanThroughSupervisor } from "./supervisor.ts";

// 재시작 복구의 표식 정리(#268 PR 2): 감독 실행기에 정리만 청하면, 이 표식을 가진 프로그램만 찾아 끈다. 신호는 표식을 확인한 바로 그
// 프로세스에만 간다(Linux 프로세스 핸들, macOS 신호 직전 시작 시각 재확인). 찾은 번호가 다른 프로그램에 다시 주어지는 장면은 실행기의
// Rust 시험(`marked.rs`)이 본다. Windows는 묶음이 트리를 끄고 표식 정리가 없다.
// 띄운 프로그램은 Node 자식 객체로 끝낸다(끝을 본 자식에는 신호하지 않는다, #288 parent 점검: 번호 신원).
const started: ChildProcess[] = [];
afterEach(async () => {
  await attemptAll(started.splice(0).map((child) => () => endChild(child)));
});

/** 새 세션(`detached`)에서 오래 도는 프로그램. TERM을 무시한다. 준비 줄을 낸 뒤에 돌려준다. */
async function program(
  options: { env?: NodeJS.ProcessEnv; args?: string[] } = {}
) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
      ...(options.args ?? []),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, ...options.env },
    }
  );
  started.push(child);
  await readyLine(child);
  return child.pid!;
}

// 표식은 환경 항목 하나가 표식 이름에 정확히 그 값일 때만이다. 실행 인자 속, 다른 변수의 값 속, 다른 실행 시도의 표식은 아니다.
// macOS도 커널이 주는 인자·환경 경계로 읽어 Linux와 같이 가린다(예전의 `ps` 비교는 다른 변수 값 속의 표식을 가리지 못했다).
it.skipIf(process.platform === "win32")(
  "stops only programs whose environment holds this run's marker exactly",
  async () => {
    const lease = randomUUID();
    const entry = `${leaseVariable}=${lease}`;
    const holder = await program({ env: { [leaseVariable]: lease } });
    const nested = await program({ env: { [`${leaseVariable}_2`]: lease } });
    const spared = [
      await program({ args: [entry] }),
      await program({ env: { [leaseVariable]: randomUUID() } }),
      await program({ env: { OTHER: entry } }),
      await program({ env: { OTHER: `x ${entry}` } }),
      await program(),
    ];
    await cleanThroughSupervisor({ lease });
    expect(exited(holder)).toBe(true);
    expect(exited(nested)).toBe(true);
    for (const pid of spared) expect(exited(pid)).toBe(false);
  },
  60_000
);
