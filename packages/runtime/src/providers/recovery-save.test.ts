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
  /** 이 폴더(`in`, 그 시험의 기록 폴더)의 기록 옮기기가 `times`번 막히고, 막은 옮기기의 옮길 것과 자리를 `failedAt`에 남긴다(#286). */
  blocked: undefined as
    | {
        in: string;
        times: number;
        failedAt: { from: string; to: string }[];
      }
    | undefined,
  /** 이 폴더(`in`, 그 시험의 기록 폴더)의 임시 기록 지우기가 이 오류로 실패하고 그 파일을 `failedAt`에 남긴다(#286). */
  removal: undefined as
    { in: string; error: Error; failedAt: string[] } | undefined,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const { blocked } = rename;
      if (
        blocked &&
        blocked.times > 0 &&
        blocked.in === path.dirname(String(args[0]))
      ) {
        blocked.times--;
        blocked.failedAt.push({ from: String(args[0]), to: String(args[1]) });
        throw Object.assign(new Error("in use"), { code: "EPERM" });
      }
      return actual.renameSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const { removal } = rename;
      if (removal?.in === path.dirname(String(args[0]))) {
        removal.failedAt.push(String(args[0]));
        throw removal.error;
      }
      return actual.rmSync(...args);
    },
  };
});

/** 그 시험의 기록 폴더(`directory`)의 기록 옮기기를 `times`번 막기 시작하고 그 결함을 돌려준다. */
function blockRenames(directory: string, times: number) {
  const blocked = {
    in: directory,
    times,
    failedAt: [] as { from: string; to: string }[],
  };
  rename.blocked = blocked;
  return blocked;
}
/** 막힌 옮기기가 옮기려던 자리들. */
const blockedPlaces = (blocked: ReturnType<typeof blockRenames>) =>
  blocked.failedAt.map(({ to }) => to);

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
  rename.blocked = undefined;
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
  // 다시 쓰기 타이머를 시험이 돌린다(실제 시간 간격으로 기록을 다시 읽지 않는다). 막힌 세 번의 다시 시도가 그 자리에서 돌고 네 번째가 쓴다.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const start = startLater();
  recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  const blocked = blockRenames(directory, 3);
  await start.tell("1700000000123456");
  vi.runAllTimers();
  expect(await readFile(file, "utf8")).toMatch(/"start":"1700000000123456"/);
  // 막힌 세 번은 모두 그 프로세스의 기록 자리로 옮기려던 것이다.
  expect(blockedPlaces(blocked)).toEqual([file, file, file]);
  expect(warn).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([path.basename(file)]);
}, 30_000);

it("does not save the start time after forgetting a held record", async () => {
  const { home, pid, file, directory } = await running();
  // 시작 시각 알림과 다시 쓰기 타이머를 시험이 돌린다. 둘 다 그 자리에서 끝나므로 돌린 직후에 본다.
  const start = startLater();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const forget = recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  // 기록은 내내 막혀 있다. 잊은 뒤 다시 쓰기를 시도했다면 그것도 막혀 기록에 남는다.
  const blocked = blockRenames(directory, Number.POSITIVE_INFINITY);
  await start.tell("1700000000123456");
  expect(blockedPlaces(blocked)).toEqual([file]);
  forget();
  vi.runOnlyPendingTimers();
  expect(blockedPlaces(blocked)).toEqual([file]);
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
  // 다시 쓰기 타이머를 시험이 돌린다. 정해진 횟수를 모두 돈 뒤에 경고한다.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const start = startLater();
  recordProcess(
    home,
    { pid, lease: "lease", supervisorStart: start.supervisorStart },
    { platform: withoutProc }
  );
  const blocked = blockRenames(directory, Number.POSITIVE_INFINITY);
  await start.tell("1700000000123456");
  vi.runAllTimers();
  expect(warn).toHaveBeenCalled();
  expect(warn.mock.calls).toEqual([
    ["[provider] could not save a process start time (EPERM)"],
  ]);
  // 여러 번 다시 시도했고, 막힌 옮기기는 모두 그 프로세스의 기록 자리로 옮기려던 것이다.
  expect(blocked.failedAt.length).toBeGreaterThan(1);
  expect(new Set(blockedPlaces(blocked))).toEqual(new Set([file]));
  expect(await readFile(file, "utf8")).not.toMatch(/"start"/);
  expect(await readdir(directory)).toEqual([path.basename(file)]);
}, 30_000);

// 기록을 제자리에 두지 못하고 임시 기록도 지우지 못하면, 지우기 실패가 원래 실패를 덮지 않는다(#280 리뷰 2회차 STD-2와 같은 모양).
it("throws the failure to place the record, not the failure to remove its temporary file", async () => {
  const { home, pid, file, directory } = await running();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const blocked = blockRenames(directory, Number.POSITIVE_INFINITY);
  const removal = {
    in: directory,
    error: Object.assign(new Error("io"), { code: "EIO" }),
    failedAt: [] as string[],
  };
  rename.removal = removal;
  expect(() =>
    recordProcess(
      home,
      { pid, lease: "lease", supervisorStart: startLater().supervisorStart },
      { platform: withoutProc }
    )
  ).toThrow(expect.objectContaining({ code: "EPERM" }));
  // 지우지 못한 것은 그 시험의 기록 자리로 옮기지 못한 바로 그 임시 기록이다.
  expect(removal.failedAt).toHaveLength(1);
  expect(blocked.failedAt).toEqual([{ from: removal.failedAt[0], to: file }]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("EIO"));
}, 30_000);
