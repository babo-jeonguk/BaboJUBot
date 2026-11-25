import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { probeEnding, runProbe, startProcess } from "./process.ts";
import { openLifelines } from "@babojubot/process/lifelines";
import { awaitedLater, lifelineHolder } from "@babojubot/process/test-cleanup";
import { manualClock, within } from "@babojubot/process/test-support";
import { testFolders } from "./test-folders.ts";

/**
 * 공용 실행(`runTree`)의 결과를 갈음한다. 비어 있으면 실제로 돈다. 상한에 닿아 끈 명령은 끈 이유(`stopped`)와 그 트리를 끝낸 신호를
 * 함께 가질 수 있다. 두 값을 함께 가진 결과를 주입해 둘 다 남는지 본다(#286 리뷰 1회차 STD-2).
 */
const tree = vi.hoisted(() => ({
  run: undefined as undefined | (() => unknown),
}));
vi.mock("@babojubot/process", async (importOriginal) => {
  const real = await importOriginal<typeof import("@babojubot/process")>();
  return {
    ...real,
    runTree: (...args: Parameters<typeof real.runTree>) =>
      tree.run ? Promise.resolve(tree.run()) : real.runTree(...args),
  };
});
/** 상한에 닿아 끈 트리의 결과: 끈 이유와 끝낸 신호를 함께 가진다. */
const stoppedBySignal = () => ({
  started: true,
  code: null,
  signal: "SIGKILL",
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  stopped: "limit",
});
afterEach(() => {
  tree.run = undefined;
});

const folders = testFolders();

const run = async (
  script: string,
  options: {
    maxLineLength?: number;
    onFrame?: (frame: unknown) => Promise<void>;
  } = {}
) => {
  const frames: unknown[] = [];
  const child = folders.ownRun(
    startProcess({
      command: [process.execPath, "-e", script],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      ...(options.maxLineLength
        ? { maxLineLength: options.maxLineLength }
        : {}),
      onFrame: async (frame) => {
        frames.push(frame);
        await options.onFrame?.(frame);
      },
    })
  );
  const exit = await within(child.done, 20_000, "the run did not finish");
  return { frames, exit };
};

it("skips lines that are not JSON and keeps reading", async () => {
  const { frames, exit } = await run(
    `console.log("update available"); console.log('{"n":1}'); console.log("{broken"); console.log('{"n":2}');`
  );
  expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  expect(exit).toMatchObject({ code: 0, broken: false });
});

it("skips only the line that is over the limit, across chunks", async () => {
  // 넘친 줄의 앞부분을 부모가 읽은 뒤에야 자식이 나머지를 쓴다(부모가 앞 프레임을 받고 입력으로 알린다). 앞 프레임과 앞부분은
  // 한 번에 쓰므로(POSIX는 512바이트 이하 쓰기를 파이프에 한꺼번에 넣는다) 부모가 앞 프레임을 받았을 때 앞부분도 받았다.
  // 나머지의 `{"n":0}`은 한도 안이라, 넘친 줄의 끝으로 버리지 않고 새 줄로 읽으면 프레임으로 잡힌다.
  const frames: unknown[] = [];
  const child = folders.ownRun(
    startProcess({
      command: [
        process.execPath,
        "-e",
        `process.stdout.write('{"n":1}\\n' + 'x'.repeat(40));
       process.stdin.once("data", () => {
         process.stdout.write('{"n":0}\\n{"n":2}\\n');
         process.stdin.destroy();
       });`,
      ],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      maxLineLength: 16,
      onFrame: async (frame) => {
        frames.push(frame);
        if (isDeepStrictEqual(frame, { n: 1 })) child.write({ go: true });
      },
    })
  );
  const exit = await within(child.done, 20_000, "the run did not finish");
  expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  expect(exit.broken).toBe(false);
});

it("reads a last line that has no newline", async () => {
  const { frames, exit } = await run(`process.stdout.write('{"n":1}');`);
  expect(frames).toEqual([{ n: 1 }]);
  expect(exit.broken).toBe(false);
});

// 프로그램이 남긴 자식이 출력을 쥐면 출력이 닫히지 않아 종료 뒤 잠깐만 읽고 정리한다. 그때도 프로그램이 줄바꿈 없이 끝낸 마지막 줄은
// 그 프로그램의 출력이다(Windows에서는 실행기가 끝날 때까지 출력의 닫힘이 늦게 올 수 있다). 남긴 자식은 실행 시도의 끄기가 끈다.
it("reads a last line that has no newline when a child keeps the output open", async () => {
  const keep = `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true }).unref();`;
  const { frames, exit } = await run(
    `${keep} process.stdout.write('{"n":1}');`
  );
  expect(frames).toEqual([{ n: 1 }]);
  expect(exit.broken).toBe(false);
});

// 프로그램이 끝나면 남긴 자식이 출력을 쥐고 있어도 출력이 닫히기를 시간으로 기다리지 않는다. 바로 트리를 끄고, 끈 뒤 닫힌 출력의
// 끝(줄바꿈 없는 마지막 줄 포함)까지 읽는다(#268). 시계를 돌리지 않아도 끝나므로, 정리가 시계의 기다림에 매이지 않는다.
it("finishes a run when its program ends without waiting on the clock for a child that holds the output", async () => {
  const lifelines = await openLifelines();
  onTestFinished(() => lifelines.close());
  // 남긴 자식이 연결을 쥐었다고 알린 뒤에(넷째 핸들) 프로그램이 마지막 줄을 쓰고 끝난다. 그 전에 끝나면 자식이 연결을 쥐기 전에 꺼진다.
  const holder = `${lifelines.hold("holder", 'require("node:fs").writeSync(3, "ready\\n");')} setInterval(() => {}, 1000);`;
  const frames: unknown[] = [];
  const clock = manualClock();
  const child = folders.ownRun(
    startProcess({
      command: [
        process.execPath,
        "-e",
        `const h = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { stdio: ["ignore", "inherit", "ignore", "pipe"] }); h.stdio[3].once("data", () => { h.stdio[3].destroy(); h.unref(); process.stdout.write('{"n":1}'); });`,
      ],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      clock,
      onFrame: async (frame) => {
        frames.push(frame);
      },
    }),
    // 입력을 닫은 뒤 트리를 끄기까지의 유예는 가짜 시계 위라, 정리는 그 타이머까지 시계를 옮긴다.
    clock
  );
  const exit = await within(child.done, 20_000, "the run did not finish");
  expect(frames).toEqual([{ n: 1 }]);
  expect(exit).toMatchObject({ code: 0, broken: false });
  await lifelines.closed("holder");
}, 30_000);

it("keeps reading after a frame handler fails", async () => {
  const { frames, exit } = await run(
    `console.log('{"n":1}'); console.log('{"n":2}');`,
    {
      onFrame: async () => {
        throw new Error("handler failed");
      },
    }
  );
  expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  expect(exit.broken).toBe(false);
});

it("keeps the end of the error output for the caller", async () => {
  const { exit } = await run(
    `process.stderr.write("x".repeat(20000) + "the real reason");`
  );
  expect(exit.stderr.endsWith("the real reason")).toBe(true);
  expect(exit.stderr.length).toBeLessThanOrEqual(8192);
});

describe("runProbe", () => {
  const probe = (
    script: string,
    timeout = 5_000,
    signal = new AbortController().signal
  ) =>
    runProbe([process.execPath, "-e", script], [], {
      env: { PATH: process.env.PATH },
      cwd: process.cwd(),
      signal,
      timeout,
      maxBuffer: 1024 * 1024,
    });

  it("returns what the program printed", async () => {
    expect((await probe(`console.log("hello")`)).stdout).toBe("hello\n");
  });

  it("reports the exit code and the output of a failed program", async () => {
    await expect(
      probe(`console.error("not signed in"); process.exit(1)`)
    ).rejects.toMatchObject({ code: 1, stderr: "not signed in\n" });
  });

  it("leaves why a run's program could not be started", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    // 띄우지 못하는 실행 시도라 끝낼 프로그램이 없고, 그 끝은 `broken`이다. 그래서 `ownRun`(끝을 확인하지 못한 실행 시도를 정리
    // 실패로 드러낸다)에 맡기지 않는다. 시험은 그 끝을 상한 안에서 기다린다.
    const child = startProcess({
      command: ["/missing/program"],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      onFrame: async () => {},
    });
    expect(
      (await within(child.done, 20_000, "the run did not finish")).broken
    ).toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("(ENOENT)"));
  });

  it("reports a missing program", async () => {
    await expect(
      runProbe(["/missing/program"], [], {
        env: { PATH: process.env.PATH },
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeout: 5_000,
        maxBuffer: 1024,
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // 끈 이유(시한·취소)와 끝낸 신호는 원인이다. 일반 문구("killed")로 접지 않는다(#264 외부 리뷰 4회차 STD-3).
  it("stops a program that outlives its limit and names the limit as the cause", async () => {
    await expect(probe(`setInterval(() => {}, 1000)`, 100)).rejects.toSatisfy(
      // 끄기 순서는 SIGTERM → 유예 → SIGKILL이다(packages/process/supervisor/src/unix.rs `end_tree`). 이 프로그램은 SIGTERM을
      // 다루지 않아 그 기본 동작으로 SIGTERM이 닿는 순간 끝난다. 그래서 POSIX에서는 SIGTERM으로 정해져 있다. Windows는 신호 없이
      // 끝난다. 예전 기대는 신호를 버린 문구를 고정했다(#286 리뷰 1회차 STD-2).
      (error) =>
        probeEnding(error) ===
        (process.platform === "win32"
          ? "stopped: limit"
          : "stopped: limit, signal SIGTERM")
    );
  });

  it("names both why a program was stopped and the signal that ended it", async () => {
    tree.run = stoppedBySignal;
    await expect(probe(`setInterval(() => {}, 1000)`, 100)).rejects.toSatisfy(
      (error) => probeEnding(error) === "stopped: limit, signal SIGKILL"
    );
  });

  // Windows에는 신호로 끝나는 프로세스가 없다.
  it.skipIf(process.platform === "win32")(
    "names the signal that ended a program",
    async () => {
      await expect(
        probe(
          `process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);`
        )
      ).rejects.toSatisfy((error) => probeEnding(error) === "SIGTERM");
    }
  );

  // 취소해 종료 신호를 보내도 끝나지 않는 프로그램은 유예 뒤 강제로 끝낸다. 호출자의 기다림이 그 프로그램에 매이지 않는다.
  // Windows의 종료는 프로그램이 거부할 수 없어 이 상황을 만들 수 없다.
  it.skipIf(process.platform === "win32")(
    "forces a cancelled program that ignores the stop signal to end",
    async () => {
      const folder = await folders.make("babojubot-probe-");
      // 프로그램은 연결을 쥐고 돈다. 시험이 먼저 실패해도 정리가 연결이 열려 있음을 본 직후 그 번호로 끝낸 뒤 폴더를 지운다.
      const lifelines = await openLifelines();
      onTestFinished(() => lifelines.close());
      const held = lifelineHolder(
        lifelines,
        "check program",
        path.join(folder, "pid")
      );
      folders.own(held.end, "the check program");
      const controller = new AbortController();
      const probing = awaitedLater(
        runProbe(
          [
            process.execPath,
            "-e",
            `process.on("SIGTERM", () => {}); ${held.code} setInterval(() => {}, 1000);`,
          ],
          [],
          {
            env: { PATH: process.env.PATH },
            cwd: process.cwd(),
            signal: controller.signal,
            timeout: 60_000,
            maxBuffer: 1024,
          }
        )
      );
      // 연결이 보이면 SIGTERM을 무시하도록 정한 뒤다.
      await lifelines.connected("check program", 20_000);
      controller.abort();
      await expect(probing).rejects.toSatisfy(
        // 이 프로그램은 SIGTERM을 무시하므로 유예 뒤의 SIGKILL로만 끝난다(packages/process/supervisor/src/unix.rs `end_tree`).
        // 예전 기대는 신호를 버린 문구를 고정했다(#286 리뷰 1회차 STD-2).
        (error) => probeEnding(error) === "stopped: aborted, signal SIGKILL"
      );
      // 끝은 번호가 아니라 그 프로그램이 쥔 연결의 닫힘으로 본다. 끝난 번호는 다른 프로그램에 다시 쓰일 수 있다.
      await lifelines.closed("check program");
    },
    30_000
  );

  // 프로그램이 끝났는데 그 출력을 물려받은 다른 프로그램이 남으면, 출력이 닫히기를 기다리지 않고 바로 트리를 끈다(공용 실행의 트리
  // 끄기). 출력을 쥔 그 프로그램까지 끝나 출력이 닫히고, 결과는 프로그램의 결과다. 예전에는 출력 닫힘을 1초 기다린 뒤 트리를 껐다
  // (#268, 시간 기다림 제거). 그 기다림이 돌아오는지를 시간이 아니라 시계로 가린다: probe가 도는 동안 이 시험 프로세스의
  // `setTimeout`을 가짜 시계로 두고 옮기지 않는다(#288 `lateReadyLine`과 같은 방식). 출력 닫힘을 시간으로 기다리는 어떤 대기도 지나지
  // 않으므로, 그런 회귀는 끝나지 않고 가짜 시계와 무관한 실제 시간 상한(공용 `within`)에서 그 이유로 실패한다. 공용 실행의
  // 끄기 길에 있는 타이머(`runTree`의 `limitMs`, `within`, 실행기 끝 확인)는 모두 넘기면 실패하는 상한이라, 올바른 실행은 시계가
  // 흐르지 않아도 끝난다. 실행 상한(`limitMs`)도 가짜 시계 위라 결과에 끼어들지 않는다. probe가 끝나면 바로 실제 시계로 돌리고 그 뒤의
  // 대기(출력을 쥔 프로그램의 끝)는 자기 상한으로 기다린다. 예전의 500ms 실제 시한은 결함 없이도 부하가 큰 실행에서 프로그램 둘을
  // 띄우는 준비만으로 닿았다(#213, #286 이월분). `node:timers/promises`의 기다림은 가짜 시계가 덮지 않는다(한계).
  it("stops what the program left holding its output as soon as the program ends, and returns the program's result", async () => {
    const folder = await folders.make("babojubot-probe-");
    const holderFile = path.join(folder, "holder");
    // 정리는 등록 역순이다. 출력을 쥔 프로그램을 먼저 끄고, probe를 취소한 뒤 그 결과를 받고서 폴더를 지운다. probe의 성공(트리
    // 전체가 끝난 것을 확인하고 종료 코드 0)만 정리 성공이다. 끝을 확인하지 못한 거절(`Program did not stop`)을 포함해 그 밖의
    // 결과는 정리 실패로 넘겨 폴더를 남긴다.
    // probe는 아래에서 띄운다. 정리는 그 전에 등록하므로 띄운 것을 이 자리에 둔다.
    const started: { probe?: Promise<unknown> } = {};
    const cancel = new AbortController();
    folders.own(() => {
      cancel.abort();
      return started.probe ?? Promise.resolve();
    }, "the probe");
    const lifelines = await openLifelines();
    onTestFinished(() => lifelines.close());
    // 출력을 쥔 프로그램이 연결을 쥐었다고 알린 뒤에(넷째 핸들) 프로그램이 끝난다. 시험이 먼저 실패하면 정리가 연결이 열려 있음을
    // 본 직후 그 번호로 끝낸다.
    const held = lifelineHolder(
      lifelines,
      "holder",
      holderFile,
      'require("node:fs").writeSync(3, "ready\\n");'
    );
    folders.own(held.end, "the program holding the output");
    const holder = `${held.code} setInterval(() => {}, 1000);`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = probe(
      `const holder = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { stdio: ["ignore", "inherit", "inherit", "pipe"] }); holder.stdio[3].once("data", () => { holder.stdio[3].destroy(); holder.unref(); console.log("done"); });`,
      // 가짜 시계 위의 실행 상한이라 지나지 않는다.
      5_000,
      cancel.signal
    );
    started.probe = running;
    const result = await within(
      running,
      20_000,
      "the probe did not end with the clock still; it may wait for the held output by time"
    ).finally(() => {
      vi.useRealTimers();
    });
    expect(result.stdout).toBe("done\n");
    await lifelines.closed("holder");
  }, 30_000);
});
