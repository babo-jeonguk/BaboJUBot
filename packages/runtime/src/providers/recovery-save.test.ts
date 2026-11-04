import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordProcess } from "./recovery.ts";

// Windows에서는 다른 프로그램이 기록을 읽는 동안 덮어쓰기가 EPERM으로 잠깐 실패한다. 그 순간을 그대로 만든다.
const rename = vi.hoisted(() => ({ blocked: 0, tried: 0 }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (rename.blocked > 0) {
        rename.blocked--;
        rename.tried++;
        throw Object.assign(new Error("in use"), { code: "EPERM" });
      }
      return actual.renameSync(...args);
    },
  };
});

const withoutProc = process.platform === "linux" ? "darwin" : process.platform;
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  rename.blocked = 0;
  rename.tried = 0;
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function running() {
  const home = await mkdtemp(path.join(tmpdir(), "babojubot-save-"));
  roots.push(home);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const directory = path.join(home, "processes");
  return {
    home,
    pid: child.pid!,
    directory,
    file: path.join(directory, `${child.pid}.json`),
  };
}

it("saves the start time once the record stops being held", async () => {
  const { home, pid, file, directory } = await running();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  recordProcess(home, pid, "lease", { platform: withoutProc });
  rename.blocked = 3;
  await vi.waitFor(
    async () => expect(await readFile(file, "utf8")).toMatch(/"started"/),
    { timeout: 20_000, interval: 50 }
  );
  expect(rename.tried).toBe(3);
  expect(warn).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([path.basename(file)]);
}, 30_000);

it("does not save the start time after forgetting a held record", async () => {
  const { home, pid, directory } = await running();
  const forget = recordProcess(home, pid, "lease", { platform: withoutProc });
  rename.blocked = 1;
  await vi.waitFor(() => expect(rename.tried).toBe(1), {
    timeout: 20_000,
    interval: 10,
  });
  forget();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

// 끝내 저장하지 못해도 첫 기록은 남는다. 복구는 그 프로세스를 건드리지 않고 경고한다.
it("warns and keeps the first record when the file stays held", async () => {
  const { home, pid, file, directory } = await running();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  recordProcess(home, pid, "lease", { platform: withoutProc });
  rename.blocked = Number.POSITIVE_INFINITY;
  await vi.waitFor(() => expect(warn).toHaveBeenCalled(), {
    timeout: 25_000,
    interval: 50,
  });
  expect(rename.tried).toBeGreaterThan(1);
  expect(await readFile(file, "utf8")).not.toMatch(/"started"/);
  expect(await readdir(directory)).toEqual([path.basename(file)]);
}, 30_000);
