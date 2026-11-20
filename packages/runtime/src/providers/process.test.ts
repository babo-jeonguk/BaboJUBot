import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { probeEnding, runProbe, startProcess } from "./process.ts";
import { openLifelines } from "@babojubot/process/lifelines";
import { killAndWait } from "@babojubot/process/testing";
import { awaitedLater, processAlive } from "@babojubot/process/test-cleanup";
import { testFolders } from "./test-folders.ts";

const folders = testFolders();
const alive = processAlive;
/** 시험 프로그램이 `file`에 남긴 번호의 프로그램을 끝낸다. 번호를 남기기 전이면 할 일이 없다. */
const stopRecorded = async (file: string) => {
  if (existsSync(file)) await killAndWait([Number(readFileSync(file, "utf8"))]);
};

const run = async (
  script: string,
  options: {
    maxLineLength?: number;
    onFrame?: (frame: unknown) => Promise<void>;
  } = {}
) => {
  const frames: unknown[] = [];
  const child = startProcess({
    command: [process.execPath, "-e", script],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    ...(options.maxLineLength ? { maxLineLength: options.maxLineLength } : {}),
    onFrame: async (frame) => {
      frames.push(frame);
      await options.onFrame?.(frame);
    },
  });
  const exit = await child.done;
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
  const child = startProcess({
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
  });
  const exit = await child.done;
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
  const probe = (script: string, timeout = 5_000) =>
    runProbe([process.execPath, "-e", script], [], {
      env: { PATH: process.env.PATH },
      cwd: process.cwd(),
      signal: new AbortController().signal,
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
    const child = startProcess({
      command: ["/missing/program"],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      onFrame: async () => {},
    });
    expect((await child.done).broken).toBe(true);
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
      (error) => probeEnding(error) === "stopped: limit"
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
      const ready = path.join(folder, "ready");
      const controller = new AbortController();
      const probing = awaitedLater(
        runProbe(
          [
            process.execPath,
            "-e",
            `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
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
      // 시험이 먼저 실패해도 그 프로그램을 끝낸 뒤 폴더를 지운다.
      folders.own(() => stopRecorded(ready), "the check program");
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {
        timeout: 20_000,
        interval: 25,
      });
      const pid = Number(readFileSync(ready, "utf8"));
      controller.abort();
      await expect(probing).rejects.toSatisfy(
        (error) => probeEnding(error) === "stopped: aborted"
      );
      expect(alive(pid)).toBe(false);
    },
    30_000
  );

  // 프로그램이 끝났어도 그 출력을 물려받은 다른 프로그램이 남으면 출력이 닫히지 않는다. 시한이 지나면 기다림을 끝내고
  // 실패로 돌려주며, 출력을 쥔 그 프로그램까지 끈다(공용 실행의 트리 끄기, #262). 예전에는 회수하지 못하고 기록만 남겼다.
  // Windows에서는 물려받은 출력이 프로그램 종료 뒤 출력을 붙잡지 않아(CI에서 바로 닫힘을 확인) 이 상황이 이렇게 생기지 않는다.
  it.skipIf(process.platform === "win32")(
    "ends the wait after its limit when the program's output stays open",
    async () => {
      const folder = await folders.make("babojubot-probe-");
      const holderFile = path.join(folder, "holder");
      folders.own(
        () => stopRecorded(holderFile),
        "the program holding the output"
      );
      const lifelines = await openLifelines();
      onTestFinished(() => lifelines.close());
      const holder = `${lifelines.hold("holder")} setInterval(() => {}, 1000);`;
      await expect(
        probe(
          `const holder = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { stdio: ["ignore", "inherit", "inherit"] }); require("node:fs").writeFileSync(${JSON.stringify(holderFile)}, String(holder.pid)); holder.unref();`,
          500
        )
      ).rejects.toThrow();
      await lifelines.closed("holder");
    },
    30_000
  );
});
