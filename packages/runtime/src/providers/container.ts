import { execFile } from "node:child_process";
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
  /** 같은 경로로 넣는 폴더. 쓰기 가능 여부. */
  mounts: { path: string; writable: boolean }[];
  /** `babojubot.owner` 밖에 더 붙일 label(예: run, organization). */
  labels: Record<string, string>;
  /** 컨테이너 안 프로그램 이름. 이 컴퓨터의 프로그램 위치 설정은 쓰지 않는다. */
  program: string;
  /** 컨테이너 안 환경에 더할 값. */
  env: Record<string, string>;
  /** 이 컴퓨터의 loopback에만 공개할 컨테이너 포트. */
  publish?: number;
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

export function containerLaunch(
  settings: ContainerSettings,
  options: {
    home: string;
    cwd: string;
    program: string;
    workspace?: RunRequest["workspace"];
    identity?: { runId: string; organizationId: string };
    publish?: number;
  }
): ContainerLaunch {
  const mounts: { path: string; writable: boolean }[] = [];
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
    ...(options.publish === undefined ? {} : { publish: options.publish }),
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
    if (mount.path.includes(","))
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
  for (const mount of launch.mounts)
    args.push(
      "--mount",
      `type=bind,source=${mount.path},target=${mount.path}` +
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
  timeoutMs = 30_000
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
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : null;
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

/** 안전 확인이 시험할 곳. `blocked`에 닿으면 격리가 안전하지 않고, `tools`에 닿아야 조직 도구를 쓸 수 있다. */
export type IsolationProbe = {
  blocked: { host: string; port: number }[];
  tools: string;
};

/** 실제 Docker 엔진에서 격리 경계를 확인할 때 쓰는 도구. 서버는 쓰지 않는다. */
export type DockerEnvironment = {
  settings: ContainerSettings;
  prepareNetwork(signal?: AbortSignal): Promise<{ gateway: string }>;
  probe(
    options: IsolationProbe,
    signal?: AbortSignal
  ): Promise<{
    reached: { host: string; port: number }[];
    toolsReached: boolean;
  }>;
  removeOrphans(): Promise<void>;
};

function dockerExec(
  settings: ContainerSettings,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      settings.docker[0],
      [...settings.docker.slice(1), ...args],
      {
        env: dockerClientEnv({}),
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

export function createDockerEnvironment(
  settings: ContainerSettings
): DockerEnvironment {
  return {
    settings,
    async prepareNetwork(signal) {
      await dockerExec(settings, ["network", "create", settings.network], {
        timeoutMs: 60_000,
        signal,
      });
      const inspected = await dockerExec(
        settings,
        [
          "network",
          "inspect",
          settings.network,
          "--format",
          "{{(index .IPAM.Config 0).Gateway}}",
        ],
        { timeoutMs: 60_000, signal }
      );
      const gateway = inspected.stdout.trim().split("\n")[0]?.trim();
      if (inspected.code !== 0 || !gateway)
        throw new Error(
          `container network is not ready: ${inspected.stderr.trim()}`
        );
      return { gateway };
    },
    async probe(options, signal) {
      const script = `
        const net = require("node:net");
        const targets = ${JSON.stringify(options.blocked)};
        const attempt = (host, port) => new Promise((resolve) => {
          const socket = net.connect({ host, port });
          const done = (ok) => { socket.destroy(); resolve(ok); };
          socket.setTimeout(2000);
          socket.once("connect", () => done(true));
          socket.once("timeout", () => done(false));
          socket.once("error", () => done(false));
        });
        (async () => {
          const reached = [];
          for (const target of targets)
            if (await attempt(target.host, target.port)) reached.push(target);
          let toolsReached = false;
          try {
            const response = await fetch(${JSON.stringify(options.tools)}, {
              signal: AbortSignal.timeout(5000),
            });
            await response.body?.cancel();
            toolsReached = true;
          } catch {}
          console.log(JSON.stringify({ reached, toolsReached }));
        })();
      `;
      const result = await dockerExec(
        settings,
        [
          "run",
          "--rm",
          "--init",
          "--network",
          settings.network,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          settings.image,
          "node",
          "-e",
          script,
        ],
        { timeoutMs: 120_000, signal }
      );
      const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
      if (result.code !== 0 || !line)
        throw new Error(
          `container network probe failed: ${result.stderr.trim()}`
        );
      const parsed = JSON.parse(line) as {
        reached?: unknown;
        toolsReached?: unknown;
      };
      return {
        reached: Array.isArray(parsed.reached)
          ? (parsed.reached as { host: string; port: number }[])
          : [],
        toolsReached: parsed.toolsReached === true,
      };
    },
    async removeOrphans() {
      const listed = await dockerExec(
        settings,
        ["ps", "-aq", "--filter", `label=babojubot.owner=${settings.owner}`],
        { timeoutMs: 60_000 }
      );
      const ids = listed.stdout.split(/\s+/).filter(Boolean);
      if (!ids.length) return;
      await dockerExec(settings, ["rm", "-f", ...ids], {
        timeoutMs: 120_000,
      });
    },
  };
}
