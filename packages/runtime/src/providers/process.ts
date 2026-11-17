import {
  recordProcess,
  signalProcessTree,
  stopProcessGroup,
} from "./recovery.ts";
import spawn from "cross-spawn";
import {
  spawn as spawnChild,
  type ChildProcessByStdio,
} from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ContainerLaunch } from "./container.ts";
import { jobObjectLaunch, readLauncherStatus } from "./job-object.ts";
import {
  dockerClientEnv,
  dockerRunArgs,
  removeContainer,
} from "./container.ts";

/** 프로그램이 있는지 보는 짧은 확인의 제한. 바쁜 컴퓨터에서도 넘지 않을 만큼 넉넉하게 둔다. */
export const probeTimeoutMs = 15_000;
/** 프로그램이 첫 응답을 낼 때까지의 제한. 큰 세션을 불러오면 오래 걸린다. 사용자는 그 전에도 취소할 수 있다. */
export const startupLimitMs = 5 * 60 * 1000;
/** 이보다 긴 출력 한 줄은 메모리를 지키려고 그 줄만 버린다. */
const defaultMaxLineLength = 64 * 1024 * 1024;
/** 프로그램이 끝난 뒤 남은 출력을 읽을 시간. 남긴 자식이 출력을 쥐고 있어 출력이 닫히지 않을 때만 쓰인다. */
const exitDrainMs = 1000;

/** 프로그램 출력이 로그인 문제를 말하는가. 공개 기록에 옮기지 않고 판단에만 쓴다. */
export const saysLoginProblem = (text: unknown) =>
  typeof text === "string" &&
  /\b401\b|unauthori[sz]ed|authenticat|not logged in|log ?in required|sign ?in/i.test(
    text
  );

/** 프로그램에 그대로 넘기는 환경 변수. 네트워크·인증서·언어와 Windows 실행에 필요한 것만이다. 개인 설정과 자격 증명은 넘기지 않는다. */
export const sharedVariables = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "windir",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
];
export const settingName = (id: string, suffix: string) =>
  `BABOJUBOT_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;

/** 연결의 프로그램 위치. `BABOJUBOT_<연결>_COMMAND`로 정하며 없으면 기본 이름이다. */
export function commandFor(
  id: string,
  fallback: string
): readonly [string, ...string[]] {
  return [process.env[settingName(id, "COMMAND")] || fallback];
}

/**
 * 연결의 프로그램 환경. 제품 전용 값 위에 공통 변수와 `BABOJUBOT_<연결>_PASS_ENV`(쉼표로 구분)에 적은 변수만 더한다.
 * API 키 같은 값은 사용자가 그 연결에 적은 때만 넘긴다. 쓰는 줄 모르고 다른 계정으로 과금되지 않게 한다.
 * 격리 실행(컨테이너)에는 이름 적은 변수를 넘기지 않는다. 컨테이너 전체가 장악돼도 사용자의 다른 로그인이 나가지 않게 한다(#148).
 */
export function providerEnvironment(
  id: string,
  home: string,
  own: NodeJS.ProcessEnv,
  options: { isolated?: boolean } = {}
): NodeJS.ProcessEnv {
  const named = options.isolated
    ? []
    : (process.env[settingName(id, "PASS_ENV")] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
  const picked = [...sharedVariables, ...named].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  );
  return {
    ...Object.fromEntries(picked),
    PATH: process.env.PATH,
    HOME: home,
    ...(process.platform === "win32"
      ? {
          USERPROFILE: home,
          APPDATA: path.join(home, "AppData/Roaming"),
          LOCALAPPDATA: path.join(home, "AppData/Local"),
        }
      : {}),
    ...own,
  };
}

/** 짧은 확인용 실행. Windows의 .cmd 프로그램도 찾는다. 실패하면 `code`·`stdout`·`stderr`를 담아 던진다. */
export function runProbe(
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    signal: AbortSignal;
    timeout: number;
    maxBuffer: number;
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    const limit = (text: string) => text.slice(0, options.maxBuffer);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = limit(stdout + chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = limit(stderr + chunk.toString());
    });
    const stop = () => child.kill();
    const timer = setTimeout(stop, options.timeout);
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    const finish = (error?: Error & { code?: unknown }) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else
        finish(
          Object.assign(new Error("Program failed"), { code: code ?? "killed" })
        );
    });
  });
}

/** One process group per attempt. Raw stderr is drained, never propagated to public logs. */
export function startProcess(options: {
  command: readonly [string, ...string[]];
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  maxLineLength?: number;
  onFrame: (frame: unknown) => Promise<void>;
  container?: ContainerLaunch;
}) {
  const maxLineLength = options.maxLineLength ?? defaultMaxLineLength;
  const lease = crypto.randomUUID();
  const name = options.container ? "babojubot-" + lease : undefined;
  // 컨테이너는 네트워크가 없다. 이 실행 시도의 중계를 먼저 열고(못 열면 띄우지 않고 던진다) 그 폴더를 넣는다. 끝나면 닫는다.
  const relay = options.container?.settings.relay.open({
    identity: options.container.relay.identity,
    required: options.container.relay.required,
    inbound: options.container.relay.inbound !== undefined,
  });
  const env = options.container
    ? {
        ...dockerClientEnv({ ...options.env, ...options.container.env }),
        BABOJUBOT_PROCESS_LEASE: lease,
      }
    : { ...options.env, BABOJUBOT_PROCESS_LEASE: lease };
  // Windows에는 프로세스 그룹이 없다. 묶음 실행기가 프로그램을 묶음(Job Object)에 넣어 띄워, 먼저 끝난 프로그램이 남긴 것도 끈다(#205).
  const job = options.container
    ? undefined
    : jobObjectLaunch(options.command, options.args, {
        env: options.env,
        cwd: options.cwd,
      });
  const withoutJob = (reason: string) =>
    console.warn(
      `[provider] this run has no Windows job object, so programs it leaves behind may keep running: ${reason}`
    );
  if (job && "unavailable" in job) withoutJob(job.unavailable);
  let launcher: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  if (job && "launch" in job) {
    launcher = spawnChild(job.launch.file, job.launch.args, {
      ...job.launch.options,
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // 실행기를 띄우지 못했다(백신이 지웠거나 막음). 프로그램은 아직 시작하지 않았으므로 지금처럼 띄운다.
    if (launcher.pid === undefined) {
      launcher.on("error", () => {});
      withoutJob("the job object launcher could not start");
      launcher = undefined;
    }
  }
  const runsInJob = launcher !== undefined;
  const child =
    launcher ??
    (spawn(
      options.container
        ? options.container.settings.docker[0]
        : options.command[0],
      options.container
        ? [
            ...options.container.settings.docker.slice(1),
            ...dockerRunArgs(options.container, {
              name: name!,
              cwd: options.cwd,
              env: { ...options.env, ...options.container.env },
              args: options.args,
              relay: relay!.directory,
            }),
          ]
        : [...options.command.slice(1), ...options.args],
      {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Windows에는 프로세스 그룹이 없다. 새 콘솔 창도 띄우지 않는다.
        detached: process.platform !== "win32",
        windowsHide: true,
      }
    ) as ChildProcessByStdio<Writable, Readable, Readable>);
  relay?.ready.catch(() => {
    console.error("[provider] the isolated run relay could not open");
    child.kill("SIGKILL");
  });
  let forget = () => {};
  if (options.stateDir && child.pid)
    try {
      forget = recordProcess(options.stateDir, child.pid, lease);
    } catch {
      child.kill("SIGKILL");
    }
  let closed = false,
    finished = false,
    leaderExited = false,
    broken = false,
    skipping = false,
    buffer = "",
    queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  // 모르는 출력(안내문 등)은 건너뛴다. 프레임 처리 실패도 실행 시도를 끝내지 않는다.
  const deliver = (line: string) => {
    if (finished || !line.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    queue = queue
      .then(() => options.onFrame(frame))
      .catch(() => {
        console.warn("[provider] a protocol frame could not be handled");
      });
  };
  let term: ReturnType<typeof setTimeout> | undefined,
    kill: ReturnType<typeof setTimeout> | undefined;
  // 대표 프로세스를 끝내려는 신호다. 끝난 뒤 남은 그룹은 finish가 중계를 먼저 닫고 정리한다.
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid && !leaderExited) signalProcessTree(child.pid, signal);
  };
  const end = () => {
    if (closed || term) return;
    child.stdin.end();
    if (leaderExited) return;
    term = setTimeout(() => {
      signalGroup("SIGTERM");
      kill = setTimeout(() => signalGroup("SIGKILL"), 2000);
    }, 2000);
  };
  const write = (frame: unknown) => {
    if (closed || child.stdin.destroyed || child.stdin.writableEnded)
      return false;
    child.stdin.write(JSON.stringify(frame) + "\n");
    return true;
  };
  let reportInputFailure!: () => void;
  const inputFailed = new Promise<void>((resolve) => {
    reportInputFailure = resolve;
  });
  child.stdin.on("error", () => {
    broken = true;
    reportInputFailure();
    end();
  });
  // 끝부분만 남긴다. 판단과 서버 진단에만 쓰고 공개 기록에 옮기지 않는다.
  let stderr = "";
  // 묶음 실행기는 프로그램이 돌기 전에 상태 줄 하나를 쓴다. 그 줄은 떼어 판단하고 나머지만 프로그램의 오류 출력으로 둔다.
  let pendingStatus: string | undefined = runsInJob ? "" : undefined;
  child.stderr.on("data", (chunk: Buffer) => {
    let text = chunk.toString();
    if (pendingStatus !== undefined) {
      pendingStatus += text;
      const newline = pendingStatus.indexOf("\n");
      if (newline < 0 && pendingStatus.length < 4096) return;
      const status = readLauncherStatus(
        newline < 0 ? pendingStatus : pendingStatus.slice(0, newline)
      );
      text = status ? pendingStatus.slice(newline + 1) : pendingStatus;
      pendingStatus = undefined;
      if (status?.kind === "warning") withoutJob(status.reason);
      if (status?.kind === "failed") {
        broken = true;
        console.error(
          `[provider] the program could not start: ${status.reason}`
        );
      }
    }
    stderr = (stderr + text).slice(-8192);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (skipping) skipping = false;
      else if (line.length <= maxLineLength) deliver(line);
    }
    if (buffer.length > maxLineLength) {
      buffer = "";
      skipping = true;
    }
  });
  let reportExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    reportExit = resolve;
  });
  const done = new Promise<{
    code: number | null;
    broken: boolean;
    stderr: string;
  }>((resolve) => {
    child.on("error", () => {
      broken = true;
    });
    let drain: ReturnType<typeof setTimeout> | undefined;
    let outputClosed = false;
    const finish = (code: number | null) => {
      if (finished) return;
      closed = true;
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(drain);
      finished = true;
      // 끝나기 전에 낸 출력을 다 처리한 순간을 알린다. 출력이 닫히지 않은 채 시작했으면 그때까지 읽은 출력까지다. 실제 정리(중계·자식·컨테이너)는 아래가 하고 done이 기다린다.
      void queue.then(reportExit);
      void (async () => {
        // 중계 권한과 열린 연결을 먼저 회수한다. Docker가 컨테이너를 늦게 지우거나 못 지워도 그 사이 바깥·조직 도구에 닿지 못한다.
        try {
          await relay?.close();
        } catch {
          broken = true;
          console.error(
            "[provider] the isolated run relay could not be closed"
          );
        }
        // 출력이 아직 열려 있으면(남긴 자식이 쥐고 있음) 이쪽 끝을 닫는다. 그 뒤로 온 출력은 읽지 않는다.
        if (!outputClosed) {
          child.stdout.destroy();
          child.stderr.destroy();
        }
        // The leader may exit before its shell/MCP children. Do not release the attempt while they live.
        let stopped = true;
        if (child.pid)
          try {
            await stopProcessGroup(child.pid);
          } catch {
            stopped = false;
            broken = true;
            console.error(
              "[provider] a process group could not be stopped; releasing the run and keeping its recovery record"
            );
          }
        // 취소 공통 순서의 마지막: docker 프로그램이 끝나도 컨테이너는 남을 수 있으므로 지우고 없어졌는지 확인한다.
        if (
          options.container &&
          !(await removeContainer(options.container.settings, name!))
        ) {
          broken = true;
          console.error(
            "[provider] a container could not be removed; it is removed at the next server start"
          );
        }
        await queue;
        if (stopped)
          try {
            forget();
          } catch {
            broken = true;
            console.error(
              "[provider] process exited but its recovery record could not be removed"
            );
          }
        if (code)
          console.warn(
            `[provider] program exited with code ${code}: ${stderr
              .slice(-500)
              .replace(/\S{32,}/g, "<hidden>")}`
          );
        resolve({ code, broken, stderr });
      })();
    };
    child.on("exit", (code) => {
      leaderExited = true;
      clearTimeout(term);
      clearTimeout(kill);
      // 프로그램이 끝났다. 보통은 곧 출력이 닫히고(close) 거기서 정리한다. 남긴 자식이 출력을 쥐고 있으면 close가 오지 않으므로, 남은 출력을 읽을 시간만 두고 같은 정리를 시작한다. 취소 중이던 종료 타이머도 여기서 멈춘다(남은 그룹은 finish가 중계를 먼저 닫고 정리).
      if (!finished) drain = setTimeout(() => finish(code), exitDrainMs);
    });
    child.on("close", (code) => {
      outputClosed = true;
      if (finished) return;
      const rest = buffer + decoder.end();
      buffer = "";
      if (!skipping && rest.length <= maxLineLength) deliver(rest);
      finish(code);
    });
  });
  return {
    write,
    end,
    /** 프로그램이 끝나고 그 전에 낸 출력의 처리도 끝났다. 남긴 자식이 출력을 쥐어 출력이 닫히지 않으면 종료 뒤 exitDrainMs까지 읽은 출력만 처리한다. 정리 완료는 기다리지 않는다(정리 완료는 done). */
    exited,
    /** 입력 쓰기가 실패했다. 이후 보낸 내용은 프로그램에 닿지 않는다. 프로그램 종료는 end()의 순서대로 따로 진행한다. */
    inputFailed,
    done,
    interrupt: () => signalGroup("SIGINT"),
    endInput: () => child.stdin.end(),
    /** 컨테이너 안 서버(`relay.inbound` 포트)로 가는 이 컴퓨터 loopback 주소. */
    inboundOrigin: () =>
      relay
        ? relay.inboundOrigin()
        : Promise.reject(new Error("not a container")),
    get closed() {
      return closed;
    },
  };
}
