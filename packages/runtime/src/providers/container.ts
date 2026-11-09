import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { RunRequest } from "@babojubot/contracts";

/** 격리 실행의 Docker 설정. 서버가 시작할 때 정한다. */
export type ContainerSettings = {
  /** docker 프로그램(앞부분 인자 포함). */
  docker: readonly [string, ...string[]];
  /** 네 프로바이더·git·Python·Node를 담은 공통 이미지. 받아 오지 않으므로 미리 만들어 둔다. */
  image: string;
  /** 실행 시도 컨테이너가 붙는 전용 네트워크. 호스트 네트워크는 쓰지 않는다. */
  network: string;
  /** 이 제품 폴더가 띄운 컨테이너의 표식(`babojubot.owner` label). 재시작 때 남은 것만 골라 지운다. */
  owner: string;
};

/** 실행 시도 한 번의 컨테이너 배치. */
export type ContainerLaunch = {
  settings: ContainerSettings;
  /** 넣는 폴더·파일. `path`는 컨테이너 안 경로이고 `source`가 없으면 같은 경로의 이 컴퓨터 것이다. 쓰기 가능 여부. */
  mounts: { path: string; writable: boolean; source?: string }[];
  /** `babojubot.owner` 밖에 더 붙일 label(예: run, organization). */
  labels: Record<string, string>;
  /** 컨테이너 안 프로그램 이름. 이 컴퓨터의 프로그램 위치 설정은 쓰지 않는다. */
  program: string;
  /** 컨테이너 안 환경에 더할 값. */
  env: Record<string, string>;
  /** 이 컴퓨터의 loopback에만 공개할 컨테이너 포트. */
  publish?: number;
  /** 컨테이너 안에서 쓸 이름과 주소(`--add-host`). 안전 확인이 이 컴퓨터를 가리키는 별칭까지 시험하게 한다. */
  hosts?: Record<string, string>;
};

/** 컨테이너에 넘기지 않는 환경 변수. 이 컴퓨터의 실행 경로·임시 폴더·Windows 값은 컨테이너에 맞지 않고, GitHub 로그인은 컨테이너에 두지 않는다. */
const excluded = new Set([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "BABOJUBOT_PROCESS_LEASE",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "windir",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

/** 프로바이더마다 다른 배치 부분. */
export type AttemptContainer = {
  /** 컨테이너 안 작업 폴더. */
  cwd: string;
  /** 컨테이너 안 프로그램 이름. */
  program: string;
  /** 이 실행 시도만의 파일(조직 도구 토큰이 든 설정 등)이 든 폴더. 읽기만 넣는다. */
  attempt?: string;
  /** 이 실행 시도만의 파일을 컨테이너 안 `target` 위에 읽기로 넣는다. 이 컴퓨터의 `target`은 그대로이고 다른 컨테이너에는 그것이 보인다. */
  files?: { source: string; target: string }[];
  /** 같은 연결의 모든 조직 컨테이너가 함께 읽고 쓰는 폴더(Codex 로그인 원본 폴더). 그 밖의 내용이 없는 전용 폴더만 넣는다. */
  shared?: string[];
};

/** 실행 시도 한 번이 돌 곳. `container`가 있으면 컨테이너에서, 없으면 이 컴퓨터에서 돈다. */
export type AttemptPlacement = {
  /** 프로바이더마다 다른 부분을 받아 이 실행 시도의 컨테이너 배치를 만든다. */
  container?: (options: AttemptContainer) => ContainerLaunch;
};

/**
 * 실행 시도가 돌 곳을 고른다. 격리 실행인데 컨테이너 설정이 없으면 `null`이며, 이때 프로바이더는 이 컴퓨터에서 대신 돌리지 않고 실패로 끝낸다.
 * 제품 폴더·연구 환경 폴더·조직 표식처럼 모든 프로바이더에 같은 배치는 여기서 정한다. `home`은 그 조직의 제품 폴더이며 연결 폴더는 넣지 않는다.
 */
export function placeAttempt(
  settings: ContainerSettings | undefined,
  home: string,
  request: {
    execution?: RunRequest["execution"];
    workspace?: RunRequest["workspace"];
    identity?: { runId: string; organizationId: string };
  }
): AttemptPlacement | null {
  if (request.execution !== "container") return {};
  if (!settings) return null;
  const identity = request.identity && {
    runId: request.identity.runId,
    organizationId: request.identity.organizationId,
  };
  return {
    container: (options) =>
      containerLaunch(settings, {
        ...options,
        home,
        workspace: request.workspace,
        identity,
      }),
  };
}

function containerLaunch(
  settings: ContainerSettings,
  options: AttemptContainer & {
    home: string;
    workspace?: RunRequest["workspace"];
    identity?: { runId: string; organizationId: string };
  }
): ContainerLaunch {
  const mounts: { path: string; writable: boolean; source?: string }[] = [];
  const mount = (mountPath: string, writable: boolean) => {
    if (mounts.some((m) => m.path === mountPath)) return;
    mounts.push({ path: mountPath, writable });
  };
  mount(options.home, true);
  if (options.workspace) {
    mount(options.workspace.organization ?? options.workspace.cwd, true);
    if (options.workspace.personal) mount(options.workspace.personal, true);
    for (const peer of options.workspace.peers ?? []) mount(peer.path, false);
  } else {
    mount(options.cwd, true);
  }
  for (const folder of options.shared ?? []) mount(folder, true);
  // 이 실행 시도만의 파일은 이 컨테이너에만 읽기로 넣는다.
  if (options.attempt) mount(options.attempt, false);
  for (const file of options.files ?? [])
    mounts.push({ source: file.source, path: file.target, writable: false });
  // 프로그램이 실제 경로(realpath)로 작업 폴더를 열면 그 경로도 같은 폴더로 넣는다.
  const contained = (mountPath: string) => {
    const relative = path.relative(mountPath, options.cwd);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  };
  if (!mounts.some((mount) => contained(mount.path))) mount(options.cwd, true);
  // 추가 패키지는 조직 폴더의 가상환경에 두어 다음 실행 시도에서도 쓴다.
  const env = {
    BABOJUBOT_VENV: path.join(
      options.workspace?.organization ?? options.workspace?.cwd ?? options.cwd,
      ".venv"
    ),
  };
  return {
    settings,
    mounts,
    labels: options.identity
      ? {
          run: options.identity.runId,
          organization: options.identity.organizationId,
        }
      : {},
    program: options.program,
    env,
  };
}

export function dockerRunArgs(
  launch: ContainerLaunch,
  options: {
    name: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    args: readonly string[];
  }
): string[] {
  const { settings } = launch;
  for (const mount of launch.mounts)
    if (mount.path.includes(",") || (mount.source ?? mount.path).includes(","))
      throw new Error("container mount path must not contain a comma");
  if (options.cwd.includes(","))
    throw new Error("container mount path must not contain a comma");
  const args = [
    "run",
    "-i",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    options.name,
    "--label",
    `babojubot.owner=${settings.owner}`,
  ];
  for (const [key, value] of Object.entries(launch.labels)) {
    args.push("--label", `babojubot.${key}=${value}`);
  }
  if (process.getuid && process.getgid)
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  args.push(
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    settings.network
  );
  for (const [name, value] of Object.entries(launch.hosts ?? {}))
    args.push("--add-host", `${name}:${value}`);
  for (const mount of launch.mounts)
    args.push(
      "--mount",
      `type=bind,source=${mount.source ?? mount.path},target=${mount.path}` +
        (mount.writable ? "" : ",readonly")
    );
  args.push("--workdir", options.cwd);
  const env = { ...options.env, ...launch.env };
  for (const name of Object.keys(env)) {
    if (env[name] === undefined || excluded.has(name)) continue;
    args.push("-e", name);
  }
  if (launch.publish) args.push("--publish", `127.0.0.1::${launch.publish}`);
  args.push(settings.image, launch.program, ...options.args);
  return args;
}

/** docker CLI 자체의 환경. `-e NAME` 변수의 값은 CLI가 자기 환경에서 읽는다. */
export function dockerClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    PATH: process.env.PATH,
    DOCKER_CONFIG:
      process.env.DOCKER_CONFIG ?? path.join(os.homedir(), ".docker"),
  };
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
  ]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

export function runDocker(
  settings: ContainerSettings,
  args: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      settings.docker[0],
      [...settings.docker.slice(1), ...args],
      {
        env: dockerClientEnv({}),
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        const code = !error
          ? 0
          : typeof error.code === "number"
            ? error.code
            : null;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

export async function removeContainer(
  settings: ContainerSettings,
  name: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await runDocker(settings, ["rm", "-f", name]);
    const inspected = await runDocker(settings, ["container", "inspect", name]);
    if (
      inspected.code !== 0 &&
      /no such (container|object)/i.test(inspected.stderr)
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function publishedAddress(
  settings: ContainerSettings,
  name: string,
  port: number
): Promise<string> {
  const result = await runDocker(settings, ["port", name, `${port}/tcp`]);
  for (const line of result.stdout.split("\n")) {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(line.trim());
    if (match) return `http://127.0.0.1:${match[1]}`;
  }
  throw new Error("container port is not published on loopback");
}

// TCP 연결이 되면 HTTP 응답 코드와 상관없이 닿은 것이다. 연결 실패만으로 안전하다고 보지 않도록 조직 도구 연결(양성 대조)을 함께 본다.
const probeScript = `
const net = require("node:net");
const input = JSON.parse(process.argv[1]);
const attempt = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reached) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reached);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
(async () => {
  const targetChecks = input.blocked.map((target) =>
    attempt(target.host, target.port).then((reached) => ({ target, reached }))
  );
  const url = new URL(input.tools);
  const toolsCheck = attempt(url.hostname, Number(url.port || 80));
  const [results, toolsReached] = await Promise.all([
    Promise.all(targetChecks),
    toolsCheck,
  ]);
  console.log(
    JSON.stringify({
      reached: results
        .filter((result) => result.reached)
        .map((result) => result.target),
      toolsReached,
    })
  );
})();
`;

/** 실행 시도 컨테이너끼리 닿지 않게 하는 bridge 옵션. 네트워크를 만들 때와 이미 있는 네트워크를 받아들일 때 같은 값을 본다. */
const iccOption = "com.docker.network.bridge.enable_icc";

/** 격리하는 네트워크(bridge, icc 끔)인지 보고 그 IPv4 gateway(이 컴퓨터 쪽 주소)를 돌려준다. 아니면 던진다. */
function isolatingGateway(name: string, inspected: string): string {
  let network: unknown;
  try {
    network = JSON.parse(inspected);
  } catch {
    throw new Error(`docker network ${name} could not be inspected`);
  }
  const { Driver, Options, IPAM } = (
    typeof network === "object" && network !== null ? network : {}
  ) as { Driver?: unknown; Options?: unknown; IPAM?: unknown };
  const options =
    typeof Options === "object" && Options !== null
      ? (Options as Record<string, unknown>)
      : {};
  if (Driver !== "bridge" || options[iccOption] !== "false")
    throw new Error(
      `docker network ${name} is not a bridge whose containers cannot reach each other; remove it (docker network rm ${name}) so it is created again`
    );
  const configs =
    typeof IPAM === "object" && IPAM !== null
      ? (IPAM as { Config?: unknown }).Config
      : undefined;
  const gateway = Array.isArray(configs)
    ? configs
        .map((config) =>
          typeof config === "object" && config !== null
            ? (config as { Gateway?: unknown }).Gateway
            : undefined
        )
        .find(
          (value): value is string =>
            typeof value === "string" && value !== "" && net.isIPv4(value)
        )
    : undefined;
  if (!gateway) throw new Error(`docker network ${name} has no IPv4 gateway`);
  return gateway;
}

export function createDockerEnvironment(
  settings: ContainerSettings
): DockerEnvironment {
  const stopIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
  };
  const inspectNetwork = (signal: AbortSignal) =>
    runDocker(
      settings,
      ["network", "inspect", settings.network, "--format", "{{json .}}"],
      60_000,
      signal
    );
  return {
    settings,
    // 실행 시도 컨테이너끼리는 서로 닿지 않게(icc 끔) 전용 bridge 네트워크를 쓴다. 이미 있는 네트워크도 같은 격리인지 확인한다. gateway는 이 컴퓨터 쪽 주소이며 조직 도구 전용 listener가 여기에 열린다.
    async prepareNetwork(signal) {
      let inspected = await inspectNetwork(signal);
      stopIfAborted(signal);
      if (inspected.code !== 0) {
        const created = await runDocker(
          settings,
          [
            "network",
            "create",
            "--driver",
            "bridge",
            "--opt",
            `${iccOption}=false`,
            "--label",
            `babojubot.owner=${settings.owner}`,
            settings.network,
          ],
          60_000,
          signal
        );
        stopIfAborted(signal);
        if (created.code !== 0 && !/already exists/i.test(created.stderr))
          throw new Error("docker network could not be created");
        inspected = await inspectNetwork(signal);
        stopIfAborted(signal);
      }
      return { gateway: isolatingGateway(settings.network, inspected.stdout) };
    },
    async probe(input, signal) {
      const name = `babojubot-probe-${crypto.randomUUID()}`;
      const launch: ContainerLaunch = {
        settings,
        mounts: [],
        labels: { probe: "1" },
        program: "node",
        env: {},
        hosts: { "host.docker.internal": "host-gateway" },
      };
      const args = dockerRunArgs(launch, {
        name,
        cwd: "/",
        env: {},
        args: ["-e", probeScript, JSON.stringify(input)],
      });
      const result = await runDocker(settings, args, 60_000, signal);
      await removeContainer(settings, name);
      if (result.code !== 0)
        throw new Error("isolation probe container failed");
      const line = result.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .at(-1);
      if (!line) throw new Error("isolation probe returned an invalid result");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("isolation probe returned an invalid result");
      }
      if (typeof parsed !== "object" || parsed === null)
        throw new Error("isolation probe returned an invalid result");
      const { reached, toolsReached } = parsed as {
        reached?: unknown;
        toolsReached?: unknown;
      };
      if (
        !Array.isArray(reached) ||
        reached.some(
          (target) =>
            typeof target !== "object" ||
            target === null ||
            typeof (target as { host?: unknown }).host !== "string" ||
            typeof (target as { port?: unknown }).port !== "number"
        ) ||
        typeof toolsReached !== "boolean"
      )
        throw new Error("isolation probe returned an invalid result");
      return {
        reached: reached as { host: string; port: number }[],
        toolsReached,
      };
    },
    async removeOrphans() {
      const listed = await runDocker(settings, [
        "ps",
        "-aq",
        "--filter",
        `label=babojubot.owner=${settings.owner}`,
      ]);
      if (listed.code !== 0) return;
      const failed: string[] = [];
      for (const id of listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean))
        if (!(await removeContainer(settings, id))) failed.push(id);
      if (failed.length)
        throw new Error(
          `leftover containers could not be removed: ${failed.join(", ")}`
        );
    },
  };
}

/** 격리 안전 확인 한 번의 목표. */
export type IsolationProbe = {
  /** 컨테이너에서 닿으면 안 되는 곳(사용자 API·DB 포트). TCP 연결이 되면 HTTP 응답 코드와 상관없이 닿은 것이다. */
  blocked: { host: string; port: number }[];
  /** 컨테이너에서 닿아야 하는 조직 도구 전용 listener 주소(origin). */
  tools: string;
};
export type IsolationProbeResult = {
  reached: { host: string; port: number }[];
  toolsReached: boolean;
};
/** 격리 실행의 Docker 환경. 서버가 안전 확인·남은 컨테이너 정리에 쓴다. */
export type DockerEnvironment = {
  settings: ContainerSettings;
  /** 전용 네트워크를 만들거나, 이미 있으면 같은 격리(bridge, icc 끔)인지 확인하고 그 gateway 주소(이 컴퓨터 쪽)를 돌려준다. 아니면 던진다. */
  prepareNetwork(signal: AbortSignal): Promise<{ gateway: string }>;
  /** 실행 시도와 같은 네트워크·권한의 시험 컨테이너로 목표에 닿는지 본다. */
  probe(
    input: IsolationProbe,
    signal: AbortSignal
  ): Promise<IsolationProbeResult>;
  /** 이 제품 폴더(`owner`)가 띄웠다가 남은 컨테이너를 지운다. */
  removeOrphans(): Promise<void>;
};
