import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordProcess } from "./recovery.ts";
import { testFolders } from "./test-folders.ts";

// 기록의 시작 시각은 감독 실행기가 첫 메시지로 알린 값이다(#283 외부 리뷰 2회차 SPEC-3). Windows에서는 다른 프로그램이 기록을 읽는
// 동안 덮어쓰기가 EPERM으로 잠깐 실패한다. 그 순간을 그대로 만든다.
const rename = vi.hoisted(() => ({
  blocked: 0,
  tried: 0,
  /** 임시 기록 지우기가 이 오류로 실패한다. */
  removal: undefined as Error | undefined,
}));
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
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (rename.removal) throw rename.removal;
      return actual.rmSync(...args);
    },
  };
});

/** 감독 실행기가 첫 메시지로 시작 시각을 알리는 때를 시험이 정한다. `tell()`이 돌려주는 약속은 기록 쪽이 그 값을 받은 뒤에 이행한다. */
function startLater() {
  let report!: (start: string | undefined) => void;
  const supervisorStart = new Promise<string | undefined>((resolve) => {
    report = resolve;
  });
  return {
    supervisorStart,
    tell: (start: string | undefined) => {
      report(start);
      return supervisorStart.then(() => undefined);
    },
  };
}

const withoutProc = process.platform === "linux" ? "darwin" : process.platform;
const folders = testFolders();
afterEach(async () => {
  vi.useRealTimers();
  rename.blocked = 0;
  rename.tried = 0;
  rename.removal = undefined;
  vi.restoreAllMocks();
});
async function running() {
  const home = await folders.make("babojubot-save-");
  // 정리가 프로그램을 끝내고 종료와 stdio 닫힘을 확인한 뒤에 폴더를 지운다.
  const child = folders.ownChild(
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
  );
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");
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
  const start = startLater();
  recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  rename.blocked = 3;
  await start.tell("1700000000123456");
  await vi.waitFor(
    async () =>
      expect(await readFile(file, "utf8")).toMatch(
        /"start":"1700000000123456"/
      ),
    { timeout: 20_000, interval: 50 }
  );
  expect(rename.tried).toBe(3);
  expect(warn).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([path.basename(file)]);
}, 30_000);

it("does not save the start time after forgetting a held record", async () => {
  const { home, pid, directory } = await running();
  // 시작 시각 알림과 다시 쓰기 타이머를 시험이 돌린다. 둘 다 그 자리에서 끝나므로 돌린 직후에 본다.
  const start = startLater();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const forget = recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  rename.blocked = 1;
  await start.tell("1700000000123456");
  expect(rename.tried).toBe(1);
  forget();
  vi.runOnlyPendingTimers();
  expect(rename.tried).toBe(1);
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

it("does not save the start time when the supervisor reports it after the record was forgotten", async () => {
  const { home, pid, directory } = await running();
  const start = startLater();
  const forget = recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  expect(await readdir(directory)).toHaveLength(1);
  forget();
  await start.tell("1700000000123456");
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

// 끝내 저장하지 못해도 첫 기록은 남는다. 복구는 그 프로세스를 건드리지 않고 경고한다.
it("warns and keeps the first record when the file stays held", async () => {
  const { home, pid, file, directory } = await running();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const start = startLater();
  recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  rename.blocked = Number.POSITIVE_INFINITY;
  await start.tell("1700000000123456");
  await vi.waitFor(() => expect(warn).toHaveBeenCalled(), {
    timeout: 25_000,
    interval: 50,
  });
  expect(rename.tried).toBeGreaterThan(1);
  expect(await readFile(file, "utf8")).not.toMatch(/"start"/);
  expect(await readdir(directory)).toEqual([path.basename(file)]);
}, 30_000);

// 기록을 제자리에 두지 못하고 임시 기록도 지우지 못하면, 지우기 실패가 원래 실패를 덮지 않는다(#280 리뷰 2회차 STD-2와 같은 모양).
it("throws the failure to place the record, not the failure to remove its temporary file", async () => {
  const { home, pid } = await running();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  rename.blocked = Number.POSITIVE_INFINITY;
  rename.removal = Object.assign(new Error("io"), { code: "EIO" });
  expect(() =>
    recordProcess(
      home,
      { pid, lease: "lease", supervisorStart: startLater().supervisorStart },
      { platform: withoutProc }
    )
  ).toThrow(expect.objectContaining({ code: "EPERM" }));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("EIO"));
}, 30_000);
