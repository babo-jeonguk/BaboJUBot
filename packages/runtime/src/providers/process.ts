import {
  recordProcess,
  signalProcessTree,
  stopProcessGroup,
} from "./recovery.ts";
import spawn from "cross-spawn";
import type { ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ContainerLaunch } from "./container.ts";
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
  const child = spawn(
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
      env: options.container
        ? {
            ...dockerClientEnv({ ...options.env, ...options.container.env }),
            BABOJUBOT_PROCESS_LEASE: lease,
          }
        : { ...options.env, BABOJUBOT_PROCESS_LEASE: lease },
      stdio: ["pipe", "pipe", "pipe"],
      // Windows에는 프로세스 그룹이 없다. 새 콘솔 창도 띄우지 않는다.
      detached: process.platform !== "win32",
      windowsHide: true,
    }
  ) as ChildProcessByStdio<Writable, Readable, Readable>;
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
    broken = false,
    skipping = false,
    buffer = "",
    queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  // 모르는 출력(안내문 등)은 건너뛴다. 프레임 처리 실패도 실행 시도를 끝내지 않는다.
  const deliver = (line: string) => {
    if (!line.trim()) return;
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
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid) signalProcessTree(child.pid, signal);
  };
  const end = () => {
    if (closed || term) return;
    child.stdin.end();
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
  child.stdin.on("error", () => {
    broken = true;
    end();
  });
  // 끝부분만 남긴다. 판단과 서버 진단에만 쓰고 공개 기록에 옮기지 않는다.
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
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
  const done = new Promise<{
    code: number | null;
    broken: boolean;
    stderr: string;
  }>((resolve) => {
    child.on("error", () => {
      broken = true;
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(term);
      clearTimeout(kill);
      const rest = buffer + decoder.end();
      buffer = "";
      if (!skipping && rest.length <= maxLineLength) deliver(rest);
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
    });
  });
  return {
    write,
    end,
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
