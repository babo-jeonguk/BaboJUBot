import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfProbeFailed,
} from "@babojubot/contracts";
import { runCommand } from "@babojubot/process";
import {
  groupAlive,
  holdsLease,
  identity,
  members,
  cleanThroughSupervisor,
} from "@babojubot/process/recovery";
const boot = () =>
  readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 복구 도우미 명령이 서버를 붙잡을 수 있는 가장 긴 시간. 느린 Windows에서는 PowerShell이 뜨는 데 몇 초 걸린다. */
const helperCommandTimeoutMs = 10_000;
/** Windows에서 시작 시각을 묻는 명령의 제한. 붙잡는 것이 없어 더 기다려도 되고, 실패하면 시작 시각 없는 기록으로 남으며 복구는 이미 그것을 모르는 것으로 다룬다. */
const startRecordTimeoutMs = 30_000;
/** 프로세스 시작 시각을 묻는 명령. 같은 프로세스면 언제 물어도 같은 값이 나온다. */
function startQuery(
  pid: number,
  platform: NodeJS.Platform
): [string, string[]] {
  return platform === "win32"
    ? [
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
      ]
    : ["ps", ["-o", "lstart=", "-p", String(pid)]];
}
const startQueryEnv = () => ({ ...process.env, LC_ALL: "C" });
function parseStart(text: string) {
  const at = Date.parse(text.trim());
  return Number.isFinite(at) ? at : undefined;
}
/** 동기 실행이 실패한 까닭: 끝남 코드(`exit 1`), 신호(`SIGKILL`), 띄우지 못한 이유(`ENOENT`). 오류 출력은 담지 않는다. */
function commandEnding(error: unknown) {
  const { status, signal } = (error ?? {}) as {
    status?: unknown;
    signal?: unknown;
  };
  if (typeof status === "number") return `exit ${status}`;
  if (typeof signal === "string") return signal;
  return failureCode(error);
}
/**
 * 시작 시각을 묻지 못한 원인을 남긴다. 그사이 끝난 프로세스는 물을 것이 없으므로(답이다) 남기지 않는다.
 * `outcome`은 모르는 시작 시각을 어떻게 다루는지다.
 */
const unaskedStart = (pid: number, outcome: string) => (cause: string) => {
  if (processAlive(pid))
    console.warn(
      `[provider] the start time of process ${pid} could not be asked; ${outcome} (${cause})`
    );
};

/** /proc가 없는 시스템에서 프로세스 시작 시각. 물어볼 수 없으면 원인을 남기고 `undefined`다(우리 것으로 보지 않는다). */
export function processStartedAt(pid: number, platform: NodeJS.Platform) {
  return orIfProbeFailed(
    () => {
      const [command, args] = startQuery(pid, platform);
      return parseStart(
        execFileSync(command, args, {
          encoding: "utf8",
          env: startQueryEnv(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: helperCommandTimeoutMs,
          killSignal: "SIGKILL",
        })
      );
    },
    undefined,
    (error) =>
      unaskedStart(pid, "it is not taken as ours")(commandEnding(error))
  );
}
// Windows는 다른 프로그램이 파일을 열어 둔 동안 덮어쓰기를 거절한다. 잠깐이므로 약 5초 동안 다시 시도한다.
const startSaveTries = 20;
const startSaveRetryMs = 250;
/** 복구 기록. 프로세스 번호는 재사용되므로 시작 시각으로 같은 프로세스인지 판단한다. Linux는 부팅 식별자도 남긴다. */
export function recordProcess(
  home: string,
  pid: number,
  lease: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {}
) {
  const directory = path.join(home, "processes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${pid}.json`);
  const temp = `${file}.tmp`;
  // recordProcess는 실행 직후에 돌아 동기여야 하므로 publishFile 대신 자기 임시 이름·이름 바꾸기를 둔다.
  const write = (record: object) => {
    try {
      writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      renameSync(temp, file);
    } catch (e) {
      continueAfterFailure(
        () => rmSync(temp, { force: true }),
        (cleanup) =>
          console.warn(
            `[provider] a temporary process record could not be removed (${failureCode(cleanup)})`
          )
      );
      throw e;
    }
  };
  if (platform === "linux") {
    write({ ...identity(pid), boot: boot(), lease });
    return () => rmSync(file, { force: true });
  }
  write({ pid, lease });
  // PowerShell은 답이 느려 실행을 붙잡지 않는다. 그 전에 서버가 죽으면 시작 시각이 없는 기록으로 남아 건드리지 않는다.
  let forgotten = false;
  const saveStarted = (started: number, tries: number) => {
    if (forgotten) return;
    try {
      write({ pid, lease, started });
    } catch (error) {
      if (tries <= 1) {
        console.warn(
          `[provider] could not save a process start time (${failureCode(error)})`
        );
        return;
      }
      setTimeout(
        () => saveStarted(started, tries - 1),
        startSaveRetryMs
      ).unref();
    }
  };
  const [command, args] = startQuery(pid, platform);
  // 시한(30초)에 끝을 보장한다. 답이 없거나 끝내지 못하면 시작 시각 없는 기록으로 남고, 복구는 그것을 모르는 것으로 다룬다.
  void runCommand(command, args, {
    env: startQueryEnv(),
    limitMs: startRecordTimeoutMs,
    maxOutputBytes: 4096,
  }).then(
    (result) => {
      if (result.code !== 0) {
        unaskedStart(
          pid,
          "its record stays without one"
        )(
          result.killed
            ? "ended at its limit"
            : `exit ${result.code ?? result.signal}`
        );
        return;
      }
      const started = parseStart(result.stdout);
      if (started !== undefined) saveStarted(started, startSaveTries);
    },
    (error: unknown) =>
      console.warn(
        `[provider] a process start time query did not end; the record keeps no start time (${failureCode(error)})`
      )
  );
  return () => {
    forgotten = true;
    rmSync(file, { force: true });
  };
}
/** 번호로 프로세스가 있는지 본다. 권한이 없어 거절돼도 있는 것이다. Windows에서도 동작한다. */
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/**
 * 기록한 프로세스(실행기, 감독 실행기 전의 기록은 프로그램 대표)를 보는 법. 서버는 번호에 신호를 보내지 않는다(#268 PR 2): 기록과
 * 시작 시각이 같은 프로세스는 `ours`로 실행기의 정리 요청에 넣어 실행기가 그 프로세스에만 신호하고(Linux·macOS는 표식을 가진
 * 프로그램도), 정리 뒤 `settle`이 그것(과 그 그룹)이 끝났는지 상한 안에서 본다. Windows는 그 프로세스가 쥔 묶음이 닫히며 트리가 끝난다.
 */
type Recorded = {
  ours?: { pid: number; start: number };
  settle: () => Promise<void>;
};
const nothingLeft: Recorded = { settle: async () => {} };
/** 기록한 프로세스가 끝나기를 기다리는 상한. 살아 있는 실행기의 끄기(유예 2초, 마지막 확인 10초, 확인하지 못한 것 2초)보다 길다. */
const recordedEndLimitMs = 20_000;
/** `running`이 거짓이 될 때까지 상한 안에서 기다린다. 그래도 돌면 사람이 정리해야 한다고 던진다. */
const untilEnded = (
  running: () => boolean,
  what: string,
  ours?: Recorded["ours"]
): Recorded => ({
  ours,
  settle: async () => {
    const deadline = Date.now() + recordedEndLimitMs;
    while (running()) {
      if (Date.now() >= deadline)
        throw new Error(`${what}; manual cleanup required`);
      await delay(250);
    }
  },
});
/** 남은 것이 우리 것인지 확인하지 못했다. 표식 정리 뒤에도 남았으면 기록을 남긴다. */
const unidentified = (remains: () => boolean, reason: string): Recorded => ({
  settle: async () => {
    if (remains()) throw new Error(`${reason}; manual cleanup required`);
  },
});
/** /proc가 없는 시스템의 기록. 기록한 시작 시각과 같은 프로세스만 우리 것으로 보고 끝나기를 기다린다. */
function recordedWithoutProc(
  saved: { pid: number; started?: number },
  platform: NodeJS.Platform
): Recorded {
  if (!processAlive(saved.pid))
    // 대표는 끝났는데 자식이 남았으면 번호만으로 우리 것인지 알 수 없다. 표식으로 확인되는 것만 끈다.
    return platform !== "win32" && groupAlive(saved.pid)
      ? unidentified(
          () => groupAlive(saved.pid),
          "Cannot identify the remaining process group"
        )
      : nothingLeft;
  // 살아 있는데 시작 시각을 모르거나 기록에 없으면 번호만으로 우리 것인지 알 수 없다. 끝난 것으로 치지 않고 표식으로 확인되는 것만 끈다.
  const started = processStartedAt(saved.pid, platform);
  if (started === undefined || saved.started === undefined)
    return unidentified(
      () => processAlive(saved.pid),
      "Cannot identify a remaining process"
    );
  if (started !== saved.started) return nothingLeft;
  // 산 프로세스의 번호는 그 프로세스가 끝나기 전에는 바뀌지 않는다. 번호가 남아 있으면 시작 시각으로 같은 프로세스인지 보고,
  // 시작 시각을 읽지 못하면 끝났다고 치지 않는다. macOS는 그 그룹도 끝나야 한다(감독 실행기 전의 기록은 프로그램 대표의 그룹이다).
  const sameProcess = () => {
    if (!processAlive(saved.pid)) return false;
    const now = processStartedAt(saved.pid, platform);
    return now === undefined || now === saved.started;
  };
  // 실행기는 기록의 시작 시각을 자기 시스템의 단위로 받는다. Windows는 밀리초 그대로, macOS 기록은 `ps`의 초 단위를 밀리초로 둔
  // 것이라 마이크로초로 바꾸고 실행기가 초까지 견준다.
  return untilEnded(
    () => sameProcess() || (platform !== "win32" && groupAlive(saved.pid)),
    "Recorded process did not stop",
    {
      pid: saved.pid,
      start: platform === "win32" ? saved.started : saved.started * 1000,
    }
  );
}
export async function recoverProviderProcesses(
  dataDir: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {}
) {
  const connections =
    continueAfterFailure(
      () =>
        orIfMissing(
          () => readdirSync(path.join(dataDir, "providers")),
          hasErrorCode("ENOENT"),
          []
        ),
      (error) =>
        console.warn(
          `[provider] the provider process records could not be listed; leftover processes are not recovered at this start (${failureCode(error)})`
        )
    ) ?? [];
  for (const provider of connections) {
    const directory = path.join(dataDir, "providers", provider, "processes");
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          `[provider] could not read ${provider} process records; they are not recovered at this start (${failureCode(e)})`
        );
      continue;
    }
    for (const name of files) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      // 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 끝났음을 확인하지 못한 기록은 남겨 다음 시작 때 다시 본다.
      try {
        const saved = readRecord(file);
        if (saved) await recoverRecord(saved, platform);
        rmSync(file, { force: true });
      } catch (error) {
        console.warn(
          `[provider] could not recover ${provider} process record ${name}; it stays for the next start (${failureCode(error)})`
        );
      }
    }
  }
}
/** 복구 기록에서 쓰는 필드. 번호 말고는 없어도 된다: /proc가 없는 시스템의 기록에는 시작 시각·부팅 식별자가 없고 시작 시각(`started`)은 나중에 채워진다. */
// 1번은 신호를 보내면 모든 프로세스에 간다. 이 번호는 명령에도 쓰이니 숫자인지 꼭 본다.
const processRecordSchema = z.object({
  pid: z.number().int().gt(1),
  start: z.string().optional(),
  boot: z.string().optional(),
  lease: z.string().optional(),
  started: z.number().optional(),
});
type ProcessRecord = z.infer<typeof processRecordSchema>;
/** 쓸 수 없는 기록(깨졌거나, 이름과 번호가 다름)은 어떤 프로세스도 가리키지 않는다. 파일을 읽지 못한 오류는 그대로 던져 기록을 남긴다. */
function readRecord(file: string) {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
  const record = processRecordSchema.safeParse(saved);
  return record.success &&
    record.data.pid === Number(path.basename(file, ".json"))
    ? record.data
    : undefined;
}
async function recoverRecord(saved: ProcessRecord, platform: NodeJS.Platform) {
  // 다른 부팅의 기록이 가리키는 프로세스는 이미 없다.
  if (platform === "linux" && saved.boot !== boot()) return;
  // 우리 것인지는 정리 전에 본다(표식 정리가 표식을 가진 구성원을 끈 뒤에는 그것으로 확인할 수 없다).
  const recorded =
    platform === "linux"
      ? await recordedLinuxGroup(saved)
      : recordedWithoutProc(saved, platform);
  // 그룹 밖(새 세션)으로 나간 자손도 이 실행 시도의 표식을 가진다. 감독 실행기에 정리만 청해 표식으로 찾아 끄고, 기록과 시작 시각이
  // 같은 기록한 프로세스도 함께 끈다(#219, #268 PR 2): 신호는 확인한 바로 그 프로세스에만 간다. Windows는 표식 정리가 없다(묶음이
  // 트리를 끈다).
  const lease = platform === "win32" ? undefined : saved.lease;
  if (lease || recorded.ours)
    // 기록한 실행기의 시작 시각 뒤에 생긴, 환경을 읽을 수 없는 이 사용자의 프로그램은 우리 것일 수 있어 확인하지 못한 것으로 남는다.
    await cleanThroughSupervisor({
      lease,
      since: runStart(saved, platform),
      recorded: recorded.ours,
    });
  await recorded.settle();
}
/**
 * 기록한 실행기의 시작 시각을 실행기가 견주는 단위로. Linux는 부팅 뒤 clock tick(기록의 `start`), macOS는 epoch 뒤 마이크로초(기록의
 * `started`는 `ps`의 초 단위 시각을 밀리초로 둔 것). 모르면 `undefined`이고, 그때는 확인하지 못한 것을 찾지 않는다.
 */
function runStart(saved: ProcessRecord, platform: NodeJS.Platform) {
  const value =
    platform === "linux"
      ? Number(saved.start)
      : saved.started === undefined
        ? Number.NaN
        : saved.started * 1000;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Linux의 기록: 기록한 프로세스의 그룹. 시작 시각이 같거나 구성원이 이 표식을 가지면 우리 것이고, 그 그룹이 끝나기를 기다린다. */
async function recordedLinuxGroup(saved: ProcessRecord): Promise<Recorded> {
  let leader: ReturnType<typeof identity> | undefined;
  try {
    leader = identity(saved.pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const remaining = members(saved.pid);
  let memberHoldsLease = false;
  for (const member of remaining)
    if (saved.lease && (await holdsLease(member.pid, saved.lease))) {
      memberHoldsLease = true;
      break;
    }
  const ours =
    leader !== undefined &&
    leader.start === saved.start &&
    leader.group === saved.pid;
  if (ours || memberHoldsLease)
    return untilEnded(
      () => members(saved.pid).length > 0,
      "Recorded process group did not stop",
      ours ? { pid: saved.pid, start: Number(saved.start) } : undefined
    );
  if (!leader && remaining.length)
    return unidentified(
      () => members(saved.pid).length > 0,
      "Cannot authenticate an orphaned provider process group"
    );
  return nothingLeft;
}
