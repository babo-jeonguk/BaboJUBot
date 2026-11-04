import { describe, expect, it } from "vitest";
import { runProbe, startProcess } from "./process.ts";

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
  const { frames, exit } = await run(
    `const w = (s) => new Promise((r) => process.stdout.write(s, r));
     (async () => {
       await w('{"n":1}\\n');
       await w('x'.repeat(2000));
       await new Promise((r) => setTimeout(r, 50));
       await w('y'.repeat(2000) + '\\n');
       await w('{"n":2}\\n');
     })();`,
    { maxLineLength: 1000 }
  );
  expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  expect(exit.broken).toBe(false);
});

it("reads a last line that has no newline", async () => {
  const { frames, exit } = await run(`process.stdout.write('{"n":1}');`);
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

  it("stops a program that outlives its limit", async () => {
    await expect(probe(`setInterval(() => {}, 1000)`, 100)).rejects.toThrow();
  });
});
