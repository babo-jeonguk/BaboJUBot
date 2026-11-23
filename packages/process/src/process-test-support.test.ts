import { spawn, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { finished } from "node:stream/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitedLater } from "./test-cleanup.ts";
import { within } from "./test-support.ts";
import {
  exited,
  killAndWait,
  readyLine,
  untilExited,
} from "./process-test-support.ts";

// 종료 확인에 조회 실패를 넣는 자리. 넣지 않으면 실제 함수를 그대로 부른다.
const injected = vi.hoisted(() => ({
  read: undefined as Error | undefined,
  ps: undefined as Partial<SpawnSyncReturns<string>> | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (injected.read && String(args[0]).startsWith("/proc/"))
      throw injected.read;
    return fs.readFileSync(...args);
  }) as typeof fs.readFileSync;
  return { ...fs, readFileSync };
});
vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  const spawnSync = ((...args: Parameters<typeof cp.spawnSync>) =>
    injected.ps ?? cp.spawnSync(...args)) as typeof cp.spawnSync;
  return { ...cp, spawnSync };
});

// 준비 줄 없이 끝난 프로그램을 전체 시한(10초)까지 기다리지 않는다(PR #220 외부 리뷰 STD-1). 출력을 물려받은 자손이 남아 출력이
// 끝나지 않으면, 프로그램이 끝난 뒤 출력의 끝을 기다리는 상한(여기서는 500ms)에서 끝을 확인하지 못했다고 실패한다(#286: 준비 전에
// 끝났다고 단정하지 않는다). 자손은 시험이 끌 때까지 끝나지 않는다.
it.skipIf(process.platform === "win32")(
  "fails soon after the program exits without its ready line, even while a descendant holds its output",
  async () => {
    // 자손 번호는 오류 출력으로 받아, 시험이 끝나면 끄고 끝날 때까지 기다린다.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const d = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] }); d.unref(); process.stderr.write(d.pid + "\\n");`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let descendant = "";
    child.stderr!.on("data", (chunk: Buffer) => (descendant += String(chunk)));
    const errorsEnded = finished(child.stderr!);
    // 자손은 오류 출력을 물려받지 않으므로 그 출력은 프로그램이 끝나면 닫힌다. 닫힌 뒤에 읽어야 번호를 다 받았다.
    onTestFinished(async () => {
      child.kill("SIGKILL");
      await errorsEnded;
      const pid = Number(descendant.trim());
      if (pid > 1) await killAndWait([pid]);
    });
    await expect(readyLine(child, "ready", 10_000, 500)).rejects.toThrow(
      "exited without printing ready, and its output did not end within 500 ms"
    );
  }
);

it("still reads a ready line written just before the program exits", async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.stdout.write("noise\\nready\\n", () => process.exit(0))`],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  await expect(readyLine(child)).resolves.toBeUndefined();
});

// #286: 프로그램이 끝난(`exit`) 뒤에도 출력이 끝나기 전까지는 준비 줄이 닿을 수 있다. 출력의 끝을 시간(exit 뒤 잠깐)으로 판정하면
// 늦게 닿은 줄을 놓친다. 출력을 물려받은 자손이 프로그램이 끝난 뒤, 시험이 연결로 시킬 때 준비 줄을 쓰게 해 그 순서를 상태로 만든다
// (자식의 입력은 자식이 끝날 때 Node가 닫으므로 신호 통로로 쓰지 않는다). 자손은 따로 떼어 띄운다: Windows의 libuv는 떼지 않은 자식을
// 부모가 끝나면 함께 끝나는 묶음에 넣는다. 프로그램은 자손이 연결한 뒤 시험이 시킬 때 끝난다. readyLine의 시계는 가짜라 exit 뒤
// 시간이 얼마나 지나도(아래 5초) 출력이 열려 있는 동안은 기다린다.
it("keeps reading after the program exits until its output ends", async () => {
  const server = createServer();
  let control: Socket | undefined;
  const connected = awaitedLater(
    new Promise<Socket>((resolve) =>
      server.once("connection", (socket: Socket) => {
        control = socket;
        resolve(socket);
      })
    )
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  // 시험이 어디서 끝나든 연결을 닫으면 자손이 끝나고, 입력을 닫으면 프로그램이 끝난다.
  onTestFinished(() => {
    server.close();
    control?.destroy();
  });
  const { port } = server.address() as AddressInfo;
  const descendant = `const s = require("node:net").connect(${port}, "127.0.0.1"); s.once("data", () => { console.log("ready"); s.destroy(); }); s.once("error", () => s.destroy());`;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "ignore"], detached: true, windowsHide: true }).unref(); process.stdin.once("data", () => process.exit(0));`,
    ],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
  onTestFinished(() => {
    child.stdin!.destroy();
  });
  const exited = awaitedLater(
    once(child, "exit", { signal: AbortSignal.timeout(10_000) })
  );
  const output = await within(
    connected,
    10_000,
    "the descendant did not connect"
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const ready = awaitedLater(readyLine(child));
  child.stdin!.write("exit\n");
  // 상한은 AbortSignal.timeout이 진다(가짜 시계와 무관).
  await exited;
  vi.advanceTimersByTime(5_000);
  // readyLine의 시한은 가짜 시계에 남긴 채 실제 시계로 돌아와, 준비 줄을 기다리는 상한을 둔다.
  vi.useRealTimers();
  output.write("go");
  await within(ready, 10_000, "readyLine did not take the late ready line");
});

// 프로그램이 끝나고 출력도 끝났는데 준비 줄이 없으면, 그때 바로 준비 전에 끝난 것으로 실패한다.
it("fails when the program's output ends without its ready line", async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.stdout.write("noise\\n");`],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  await expect(readyLine(child)).rejects.toThrow(
    "exited before printing ready"
  );
});

/** 시험이 끝날 때까지 도는 프로그램. 시험이 끝나면 끄고 끝날 때까지 기다린다. */
function running() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  onTestFinished(() => killAndWait([child.pid!]));
  return child.pid!;
}

/** 이 시험 동안 `process.platform`을 `platform`으로 보이게 한다. */
function pretendPlatform(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, "platform", original);
  });
}

/** `code` 오류. */
const failure = (code: string) =>
  Object.assign(new Error(`injected ${code}`), { code });

/** `run`이 던진 오류. 던지지 않으면 실패한다. */
function thrown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
}

// 종료 확인은 "없음"만 끝난 것으로 본다. 조회가 실패하면 끝났다고 답하지 않고 pid·원인과 함께 실패한다(#243).
describe("exited", () => {
  it("answers false for a running program and true once it has exited", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      }
    );
    const exit = once(child, "exit");
    onTestFinished(() => killAndWait([child.pid!]));
    expect(exited(child.pid!)).toBe(false);
    child.kill("SIGKILL");
    await exit;
    expect(exited(child.pid!)).toBe(true);
  });

  it("fails with the pid and the cause when signal 0 is refused", () => {
    const pid = running();
    const cause = failure("EPERM");
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw cause;
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const error = thrown(() => exited(pid));
    expect(error.message).toBe(`프로세스 ${pid}가 있는지 확인하지 못했다`);
    expect(error.cause).toBe(cause);
  });

  // `/proc`는 Linux에만 있다.
  it.runIf(process.platform === "linux")(
    "fails with the pid, the file and the cause when /proc cannot be read",
    () => {
      const pid = running();
      injected.read = failure("EACCES");
      onTestFinished(() => {
        injected.read = undefined;
      });
      const error = thrown(() => exited(pid));
      expect(error.message).toBe(
        `프로세스 ${pid}의 상태(/proc/${pid}/stat)를 읽지 못했다`
      );
      expect(error.cause).toBe(injected.read);
    }
  );

  // /proc가 없는 시스템(macOS)의 경로를 Linux에서도 돌린다. Windows에는 ps가 없고 그 경로도 쓰지 않는다.
  describe.skipIf(process.platform === "win32")("without /proc", () => {
    it("asks ps whether the program runs", async () => {
      pretendPlatform("darwin");
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" }
      );
      const exit = once(child, "exit");
      onTestFinished(() => killAndWait([child.pid!]));
      expect(exited(child.pid!)).toBe(false);
      child.kill("SIGKILL");
      await exit;
      expect(exited(child.pid!)).toBe(true);
    });

    it("fails with the pid and what ps reported when ps fails", () => {
      const pid = running();
      pretendPlatform("darwin");
      injected.ps = {
        status: 1,
        stdout: "",
        stderr: "ps: injected failure",
        signal: null,
      };
      onTestFinished(() => {
        injected.ps = undefined;
      });
      expect(thrown(() => exited(pid)).message).toBe(
        `ps could not read stat of process ${pid} (exit 1): ps: injected failure`
      );
    });

    it("fails with the pid and the cause when ps cannot start", () => {
      const pid = running();
      pretendPlatform("darwin");
      const cause = failure("ENOENT");
      injected.ps = {
        status: null,
        stdout: undefined,
        stderr: undefined,
        signal: null,
        error: cause,
      };
      onTestFinished(() => {
        injected.ps = undefined;
      });
      const error = thrown(() => exited(pid));
      expect(error.message).toBe(
        `ps could not read stat of process ${pid} (ENOENT)`
      );
      expect(error.cause).toBe(cause);
    });
  });
});

// 한 대상의 조회가 실패해도 나머지 대상이 끝나기를 계속 기다리고, 그 실패를 pid·원인과 함께 알린다(#243). 앞 대상의 조회
// 실패가 뒤 대상의 대기를 끝내면, 아직 살아 있는 프로그램의 폴더를 정리가 지우러 간다.
describe("untilExited", () => {
  it("keeps waiting for the other programs when one lookup fails, and reports that failure", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    const exit = once(child, "exit");
    onTestFinished(() => killAndWait([child.pid!]));
    const refused = running();
    const cause = failure("EPERM");
    // 남은 대상을 두 번째로 확인하면, 조회 실패 뒤에도 기다리고 있다는 도착 신호다.
    let lookups = 0;
    let lookedAgain!: () => void;
    const lookedUpAgain = new Promise<void>(
      (resolve) => (lookedAgain = resolve)
    );
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && pid === refused) throw cause;
      if (signal === 0 && pid === child.pid && ++lookups === 2) lookedAgain();
      return kill(pid, signal);
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const waiting = untilExited([refused, child.pid!], 30_000).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(
      await Promise.race([
        lookedUpAgain.then(() => "still waiting"),
        waiting.then(() => "ended"),
      ])
    ).toBe("still waiting");
    child.kill("SIGKILL");
    await exit;
    expect(await waiting).toMatchObject({
      message: `프로세스 ${refused}가 있는지 확인하지 못했다`,
      cause,
    });
  });
});
