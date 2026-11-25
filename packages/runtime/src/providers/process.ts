import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  attemptEach,
  failureCode,
  isDisconnect,
  orIfUnreadable,
  settled,
} from "@babojubot/contracts";
import {
  launchTree,
  realClock,
  requireSupervisor,
  runTree,
  TreeLaunchRefused,
  type Clock,
} from "@babojubot/process";
import type { ContainerLaunch } from "./container.ts";
import {
  dockerClientEnv,
  dockerRunArgs,
  removeContainer,
} from "./container.ts";
import { recordProcess } from "./recovery.ts";

/** 프로그램이 있는지 보는 짧은 확인의 제한. 바쁜 컴퓨터에서도 넘지 않을 만큼 넉넉하게 둔다. */
export const probeTimeoutMs = 15_000;
/** 프로그램이 첫 응답을 낼 때까지의 제한. 큰 세션을 불러오면 오래 걸린다. 사용자는 그 전에도 취소할 수 있다. */
export const startupLimitMs = 5 * 60 * 1000;
/** 이보다 긴 출력 한 줄은 메모리를 지키려고 그 줄만 버린다. */
const defaultMaxLineLength = 64 * 1024 * 1024;
/** JSON으로 읽지 못한 줄. 들어온 `unknown`과 겹치지 않는 값이다. */
const unreadable = Symbol("unreadable");
/** 트리를 끈 뒤 출력이 닫히기를 기다리는 상한. 트리가 끝났으면 출력을 쥔 프로그램이 없어 곧 닫힌다. 넘기면 트리 밖의 누군가가 출력을 쥔 것이다. */
const outputCloseLimitMs = 10_000;

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
  // 이름은 사용자 설정에서 온다. process.env도 물려받은 이름(constructor)에 함수를 돌려주므로 가진 변수인지 본다.
  const picked = [...sharedVariables, ...named].flatMap(
    (name): [string, string][] => {
      const value = Object.hasOwn(process.env, name)
        ? process.env[name]
        : undefined;
      return value === undefined ? [] : [[name, value]];
    }
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

/**
 * 짧은 확인용 실행. Windows의 .cmd 프로그램도 찾는다. 공용 실행(`runTree`)으로 돌려 상한·취소에 닿거나 프로그램이 끝나면 그 트리
 * 전체를 끄고 끝난 것을 확인한다. 실패하면 `code`(종료 코드, 시작 오류 코드)·`stopped`(끈 이유)·`signal`(끝낸 신호)·`stdout`·`stderr`를 담아 던진다.
 */
export async function runProbe(
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
  const failed = (error: Error, fields: object) =>
    Object.assign(error, { stdout: "", stderr: "" }, fields);
  let run: Awaited<ReturnType<typeof runTree>>;
  try {
    run = await runTree({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      limitMs: options.timeout,
      signal: options.signal,
      maxOutputBytes: options.maxBuffer,
      overflow: "truncate",
    });
  } catch (error) {
    // 감독 실행기를 쓸 수 없어 띄우지 않았다. 그 이유를 그대로 알린다.
    if (error instanceof TreeLaunchRefused) throw failed(error, {});
    // 끝났음을 확인하지 못했다. 그 트리는 남았을 수 있다.
    throw failed(new Error("Program did not stop", { cause: error }), {
      code: "killed",
    });
  }
  if (!run.started)
    throw failed(
      run.error instanceof Error ? run.error : new Error(run.reason),
      {}
    );
  const stdout = run.stdout.toString(),
    stderr = run.stderr.toString();
  if (run.stopped)
    throw failed(new Error(`Program was stopped (${run.stopped})`), {
      stopped: run.stopped,
      ...(run.signal ? { signal: run.signal } : {}),
      stdout,
      stderr,
    });
  if (run.code !== 0)
    throw run.code === null
      ? failed(new Error("Program ended by a signal"), {
          signal: run.signal,
          stdout,
          stderr,
        })
      : failed(new Error("Program failed"), {
          code: run.code,
          stdout,
          stderr,
        });
  return { stdout, stderr };
}

/** `runProbe` 실패의 짧은 이름: 끈 이유(`stopped: limit`), 끝남 코드(`exit 2`), 끝낸 신호(`SIGTERM`), 띄우지 못한 이유(`ENOENT`). 오류 출력은 담지 않는다(로그인 내용이 섞일 수 있음). */
export function probeEnding(error: unknown): string {
  const failure = error as
    { code?: unknown; stopped?: unknown; signal?: unknown } | null | undefined;
  if (typeof failure?.stopped === "string")
    return `stopped: ${failure.stopped}${typeof failure.signal === "string" ? `, signal ${failure.signal}` : ""}`;
  if (typeof failure?.code === "number") return `exit ${failure.code}`;
  if (typeof failure?.signal === "string") return failure.signal;
  return failureCode(error);
}

/**
 * 실행 시도 하나. 프로그램은 공용 실행(@babojubot/process의 `launchTree`)으로 띄워 그 `stop()`으로 트리 전체를 끝내고 확인한다. 원래 오류 출력은 버리지
 * 않고 판단에만 쓰며 공개 기록에 옮기지 않는다. 컨테이너 실행은 docker 클라이언트를 같은 공용 실행으로 띄우고, 중계와 컨테이너 지우기를
 * 여기서 맡는다.
 */
export function startProcess(options: {
  command: readonly [string, ...string[]];
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  maxLineLength?: number;
  onFrame: (frame: unknown) => Promise<void>;
  container?: ContainerLaunch;
  /** 정지 타이머와 종료 뒤 출력 대기의 시계. 기본은 실제 시계다. */
  clock?: Clock;
}) {
  const clock = options.clock ?? realClock;
  const maxLineLength = options.maxLineLength ?? defaultMaxLineLength;
  const name = options.container
    ? `babojubot-${crypto.randomUUID()}`
    : undefined;
  // 감독 실행기를 쓸 수 없으면 아무것도 열기 전에 그 이유로 거절한다(TreeLaunchRefused, 실행 시도의 실패 원인으로 보인다).
  requireSupervisor();
  // 컨테이너는 네트워크가 없다. 이 실행 시도의 중계를 먼저 열고(못 열면 띄우지 않고 던진다) 그 폴더를 넣는다. 끝나면 닫는다.
  const relay = options.container?.settings.relay.open({
    identity: options.container.relay.identity,
    required: options.container.relay.required,
    inbound: options.container.relay.inbound !== undefined,
  });
  const tree = launchTree({
    ...(options.container
      ? {
          command: options.container.settings.docker,
          args: dockerRunArgs(options.container, {
            name: name!,
            cwd: options.cwd,
            env: { ...options.env, ...options.container.env },
            args: options.args,
            relay: relay!.directory,
          }),
          env: dockerClientEnv({ ...options.env, ...options.container.env }),
        }
      : { command: options.command, args: options.args, env: options.env }),
    cwd: options.cwd,
    stdio: "pipe",
  });
  /** 끄기가 끝났는데 대표가 끝나지 않았을 때(끄기 실패) 정리를 시작한다. 실행 시도의 정리가 정해지면 바뀐다. */
  let finishWithoutLeader = () => {};
  /**
   * 트리를 끈다. 결과는 정리(finish)가 같은 끄기를 기다려 받는다. 끄기를 시작한 뒤의 끝은 끄기의 결과가 정한다: 대표가 SIGKILL 뒤에도
   * 끝나지 않아 끄기가 실패하면 대표의 끝을 기다리지 않고 그 실패로 정리한다(#263 외부 리뷰 SP1).
   */
  const stopTree = () =>
    void settled(tree.stop()).then(() => {
      if (!leaderExited) finishWithoutLeader();
    });
  let broken = false,
    leaderExited = false;
  /** `broken`이 된 까닭(실패 코드). 실행 시도 폴더를 남길 때 그 원인으로 알린다. */
  const causes: string[] = [];
  void tree.started.then((start) => {
    if (start.kind === "failed") {
      broken = true;
      causes.push(
        start.error === undefined ? "start_failed" : failureCode(start.error)
      );
      // 띄우지 못한 이유를 남긴다. 시작 오류(ENOENT 등)는 문구 대신 짧은 이름만(경로·로그인 내용이 섞일 수 있음).
      console.error(
        start.error === undefined
          ? `[provider] the program could not start: ${start.reason}`
          : `[provider] the program could not start (${failureCode(start.error)})`
      );
    }
  });
  relay?.ready.catch((error: unknown) => {
    console.error(
      `[provider] the isolated run relay could not open (${failureCode(error)})`
    );
    stopTree();
  });
  let forget = () => {};
  if (options.stateDir && tree.pid)
    try {
      forget = recordProcess(options.stateDir, {
        pid: tree.pid,
        lease: tree.lease,
        supervisorStart: tree.supervisorStart,
      });
    } catch (error) {
      console.error(
        `[provider] the process record could not be saved; stopping the program (${failureCode(error)})`
      );
      stopTree();
    }
  let closed = false,
    finished = false,
    skipping = false,
    buffer = "",
    queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  // 모르는 출력(안내문 등)은 건너뛴다. 프레임 처리 실패도 실행 시도를 끝내지 않는다.
  const deliver = (line: string) => {
    if (finished || !line.trim()) return;
    const frame = orIfUnreadable((): unknown => JSON.parse(line), unreadable);
    if (frame === unreadable) return;
    queue = queue
      .then(() => options.onFrame(frame))
      .catch((error: unknown) => {
        console.warn(
          `[provider] a protocol frame could not be handled (${failureCode(error)})`
        );
      });
  };
  let term: unknown;
  // 입력을 닫아 스스로 끝날 기회를 준 뒤에도 돌면 트리를 끈다. 대표가 그 전에 끝나면 남은 트리는 finish가 중계를 먼저 닫고 끈다.
  const end = () => {
    if (closed || term) return;
    tree.stdin.end();
    if (leaderExited) return;
    term = clock.setTimeout(stopTree, 2000);
  };
  const write = (frame: unknown) => {
    if (closed || tree.stdin.destroyed || tree.stdin.writableEnded)
      return false;
    tree.stdin.write(JSON.stringify(frame) + "\n");
    return true;
  };
  let reportInputFailure!: () => void;
  const inputFailed = new Promise<void>((resolve) => {
    reportInputFailure = resolve;
  });
  // 프로그램이 끝나 입력이 끊긴 것(EPIPE)은 답이다. 그 밖의 쓰기 실패는 원인을 남긴다. 어느 쪽이든 입력은 실패로 본다.
  tree.stdin.on("error", (error) => {
    if (!isDisconnect(error))
      console.warn(
        `[provider] writing to the program's input failed (${failureCode(error)})`
      );
    broken = true;
    causes.push(failureCode(error));
    reportInputFailure();
    end();
  });
  // 끝부분만 남긴다. 판단과 서버 진단에만 쓰고 공개 기록에 옮기지 않는다.
  let stderr = "";
  tree.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  tree.stdout.on("data", (chunk: Buffer) => {
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
  /** 줄바꿈 없이 남은 마지막 줄을 넘긴다. 한 번만 한다. */
  const deliverRest = () => {
    const rest = buffer + decoder.end();
    buffer = "";
    if (!skipping && rest.length <= maxLineLength) deliver(rest);
  };
  const outputEnd = (stream: NodeJS.ReadableStream) =>
    new Promise<void>((resolve) => stream.once("close", () => resolve()));
  let reportExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    reportExit = resolve;
  });
  const outputsClosed = Promise.all([
    outputEnd(tree.stdout),
    outputEnd(tree.stderr),
  ]);
  const done = new Promise<{
    code: number | null;
    broken: boolean;
    /** `broken`의 까닭(실패 코드). `broken`이 아니면 비어 있다. */
    causes: readonly string[];
    stderr: string;
  }>((resolve) => {
    /**
     * 프로그램이 끝났거나(`code`) 끄기가 대표의 끝 없이 실패했다(`null`). 남긴 자식이 출력을 쥐고 있어도 출력이 닫히기를 시간으로
     * 기다리지 않는다: 중계를 닫고 트리를 끈 뒤, 트리가 끝나 닫힌 출력을 끝까지 읽는다(#268).
     */
    const finish = (code: number | null) => {
      if (closed) return;
      closed = true;
      clock.clearTimeout(term);
      void (async () => {
        /** 정리 단계 하나. 실패하면 그 자리에서 진단을 남기고 실패로 돌려준다(뒤 단계는 attemptEach가 이어 한다). */
        const reported =
          (what: (error: unknown) => string, work: () => unknown) =>
          async () => {
            try {
              await work();
            } catch (error) {
              console.error(`[provider] ${what(error)}`);
              throw error;
            }
          };
        /** 트리 전체가 끝난 것을 확인했는가. 확인하기 전에는 기록을 지우지 않는다(#219). */
        let stopped = false;
        const failures = await attemptEach([
          // 중계 권한과 열린 연결을 먼저 회수한다. Docker가 컨테이너를 늦게 지우거나 못 지워도 그 사이 바깥·조직 도구에 닿지 못한다.
          reported(
            (error) =>
              `the isolated run relay could not be closed (${failureCode(error)})`,
            () => relay?.close()
          ),
          // 대표는 셸·MCP 자식보다 먼저 끝날 수 있다. 새 세션으로 나간 명령까지 트리 전체가 끝난 것을 확인해야 기록을 지운다.
          reported(
            (error) =>
              `programs this run started could not all be stopped; releasing the run and keeping its recovery record (${failureCode(error)})`,
            async () => {
              await tree.stop();
              stopped = true;
            }
          ),
          // 트리가 끝났으면 출력을 쥔 프로그램이 없어 출력이 닫힌다. 닫힐 때까지 읽는다. 닫히지 않으면(트리를 끄지 못함, 트리 밖의
          // 누군가가 쥠) 상한 뒤 이쪽 끝을 닫고 실패로 남긴다. 그 뒤로 온 출력은 읽지 않는다.
          reported(
            (error) =>
              `the program's output did not close after its tree was stopped (${failureCode(error)})`,
            async () => {
              let limit: unknown;
              try {
                await Promise.race([
                  outputsClosed,
                  new Promise<never>((_, reject) => {
                    limit = clock.setTimeout(
                      () =>
                        reject(
                          new Error(
                            `the output did not close within ${outputCloseLimitMs} ms`
                          )
                        ),
                      outputCloseLimitMs
                    );
                  }),
                ]);
              } catch (error) {
                tree.stdout.destroy();
                tree.stderr.destroy();
                throw error;
              } finally {
                clock.clearTimeout(limit);
              }
            }
          ),
          // 프로그램은 끝났으므로 지금까지 읽은 마지막 줄(줄바꿈 없이 끝난 줄)도 그 출력이다. 끝나기 전에 낸 출력을 다 처리한 순간을
          // 알린다. 실제 정리(컨테이너·기록)는 아래가 하고 done이 기다린다.
          () => {
            deliverRest();
            finished = true;
            void queue.then(reportExit);
          },
          // 취소 공통 순서의 마지막: docker 프로그램이 끝나도 컨테이너는 남을 수 있으므로 지우고 없어졌는지 확인한다.
          reported(
            (error) =>
              `a container could not be removed; it is removed at the next server start (${failureCode(error)})`,
            async () => {
              if (
                options.container &&
                !(await removeContainer(options.container.settings, name!))
              )
                throw Object.assign(
                  new Error("it was still there after removing it"),
                  { code: "container_left" }
                );
            }
          ),
          reported(
            (error) =>
              `process exited but its recovery record could not be removed (${failureCode(error)})`,
            async () => {
              await queue;
              if (stopped) forget();
            }
          ),
        ]);
        if (failures.length > 0) {
          broken = true;
          causes.push(...failures.map(failureCode));
        }
        if (code)
          console.warn(
            `[provider] program exited with code ${code}: ${stderr
              .slice(-500)
              .replace(/\S{32,}/g, "<hidden>")}`
          );
        resolve({ code, broken, causes: [...causes], stderr });
      })();
    };
    finishWithoutLeader = () => finish(null);
    void tree.exited.then(({ code }) => {
      leaderExited = true;
      finish(code);
    });
  });
  return {
    write,
    end,
    /** 프로그램이 끝나고 그 출력의 처리도 끝났다. 남긴 자식이 출력을 쥐었으면 트리를 끈 뒤 닫힌 출력까지 처리한다. 컨테이너·기록 정리는 기다리지 않는다(정리 완료는 done). */
    exited,
    /** 입력 쓰기가 실패했다. 이후 보낸 내용은 프로그램에 닿지 않는다. 프로그램 종료는 end()의 순서대로 따로 진행한다. */
    inputFailed,
    done,
    interrupt: () => tree.interrupt(),
    endInput: () => tree.stdin.end(),
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
