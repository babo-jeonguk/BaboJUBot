import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attemptAll,
  failureCode,
  type Destination,
  type RunRequest,
} from "@babojubot/contracts";
import { runTree, TreeLaunchRefused, type TreeRun } from "@babojubot/process";
import type { RelayHub, RelayIdentity } from "./relay.ts";

/** 격리 실행의 Docker 설정. 서버가 시작할 때 정한다. */
export type ContainerSettings = {
  /** docker 프로그램(앞부분 인자 포함). */
  docker: readonly [string, ...string[]];
  /** 네 프로바이더·git·Python·Node와 시작 프로그램(docker/runner)을 담은 공통 이미지. 받아 오지 않으므로 미리 만들어 둔다. */
  image: string;
  /** 이 제품 폴더가 띄운 컨테이너의 표식(`babojubot.owner` label). 재시작 때 남은 것만 골라 지운다. */
  owner: string;
  /** 실행 시도 밖의 중계. 컨테이너에는 네트워크가 없고 이 중계의 파일 소켓으로만 바깥·조직 도구에 닿는다. 서버가 정책을 붙인다. */
  relay: RelayHub;
  /** 모든 연결이 더 여는 모델·로그인 목적지(운영자가 서버 시작 때 정함). 연결마다 정한 필수 목적지에 더한다. */
  destinations?: readonly Destination[];
};

/** 컨테이너에 넣는 폴더·파일 하나. `path`는 컨테이너 안 경로(프로그램이 쓰는 이 컴퓨터 경로와 같음), `source`는 확인한 실제 경로다. */
export type ContainerMount = {
  path: string;
  writable: boolean;
  source: string;
};

/** 실행 시도 한 번의 컨테이너 배치. */
export type ContainerLaunch = {
  settings: ContainerSettings;
  /** 권한에서 만든 폴더·파일. 모두 링크 없이 확인한 실제 경로다. */
  mounts: ContainerMount[];
  /** `babojubot.owner` 밖에 더 붙일 label(예: run, organization). */
  labels: Record<string, string>;
  /** 컨테이너 안 프로그램 이름. 이미지의 신뢰된 PATH에서 찾는다. 이 컴퓨터의 프로그램 위치 설정은 쓰지 않는다. */
  program: string;
  /** 컨테이너 안 환경에 더할 값. */
  env: Record<string, string>;
  /** 이 실행 시도의 중계. 주인 신원과 그 연결이 늘 여는 목적지, 이 컴퓨터가 부를 컨테이너 안 포트. */
  relay: { identity: RelayIdentity; required: Destination[]; inbound?: number };
};

/** 컨테이너 안 시작 프로그램(docker/runner/relay.mjs)이 여는 loopback 포트. */
export const relayPorts = { proxy: 39280, tools: 39281 } as const;
/** 컨테이너 안에서 본 조직 도구 주소. */
export const containerToolsOrigin = `http://127.0.0.1:${relayPorts.tools}`;
/** 중계 폴더가 들어가는 컨테이너 안 경로. 이미지의 시작 프로그램과 같아야 한다. */
const relayTarget = "/run/babojubot";

/** 컨테이너에 넘기지 않는 환경 변수. 이 컴퓨터의 실행 경로·임시 폴더·Windows 값은 컨테이너에 맞지 않고, GitHub 로그인은 컨테이너에 두지 않는다. 시작 때 다른 코드를 끌어들이는 값과 프록시 설정도 넘기지 않는다(이미지가 정한다). */
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
  "BABOJUBOT_VENV",
  "VIRTUAL_ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "BASH_ENV",
  "ENV",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
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
  /** 컨테이너 안 작업 폴더. 넣은 폴더 안이어야 한다(따로 넣지 않는다). */
  cwd: string;
  /** 컨테이너 안 프로그램 이름. */
  program: string;
  /** 이 실행 시도만의 파일(조직 도구 토큰이 든 설정 등)이 든 폴더. 임시 폴더 바로 아래의 `babojubot-attempt-*`(이 사용자만 접근)만 읽기로 넣는다. */
  attempt?: string;
  /** 실행 시도 전용 폴더의 보통 파일을 컨테이너 안 `target` 위에 읽기로 넣는다. `target`은 넣은 폴더 안이어야 한다. */
  files?: { source: string; target: string }[];
  /** 이 연결이 늘 여는 모델·로그인 목적지. */
  destinations?: readonly Destination[];
  /** 이 컴퓨터가 부를 컨테이너 안 서버 포트(OpenCode). 중계의 역방향 연결로 부른다. */
  inbound?: number;
};

/** 실행 시도 한 번이 돌 곳. `container`가 있으면 컨테이너에서, 없으면 이 컴퓨터에서 돈다. */
export type AttemptPlacement = {
  /** 프로바이더마다 다른 부분을 받아 이 실행 시도의 컨테이너 배치를 만든다. 권한에 맞지 않으면 `ContainerRefusal`을 던진다. */
  container?: (options: AttemptContainer) => ContainerLaunch;
};

/** 폴더 권한 확인에서 거부한 이유. 공개 실패 문장에는 이 코드만 넣고 이 컴퓨터의 경로는 넣지 않는다. */
export type ContainerRefusalCode =
  | "mount_missing"
  | "mount_link"
  | "mount_type"
  | "mount_outside"
  | "mount_overlap"
  | "mount_attempt"
  | "cwd_outside";

/** 격리 실행의 폴더를 권한대로 넣을 수 없어 프로바이더를 띄우지 않았다. */
export class ContainerRefusal extends Error {
  readonly code: ContainerRefusalCode;
  constructor(code: ContainerRefusalCode) {
    super(
      `격리 실행에 넣을 폴더가 권한과 맞지 않아 프로바이더를 시작하지 않았습니다(${code}).`
    );
    this.code = code;
  }
}

/**
 * 실행 시도가 돌 곳을 고른다. 격리 실행인데 컨테이너 설정이 없으면 `null`이며, 이때 프로바이더는 이 컴퓨터에서 대신 돌리지 않고 실패로 끝낸다.
 * 넣는 폴더는 서버가 정한 신원(조직·에이전트)의 자리에서만 만든다. `home`은 그 조직의 제품 폴더(`.../organizations/<조직>`)다.
 * 세션 정비(미리 압축)는 실행 시도·에이전트가 없어 `organizationId`만 준다.
 * 연결의 로그인 원본(연결 폴더의 로그인 폴더·토큰 파일)은 어떤 프로바이더도 넣을 수 없다. 모델 인증은 인증 중계(credential-relay.ts)가 컨테이너 밖에서 붙인다(#148).
 */
export function placeAttempt(
  settings: ContainerSettings | undefined,
  home: string,
  request: {
    execution?: RunRequest["execution"];
    workspace?: RunRequest["workspace"];
    identity?: { runId: string; organizationId: string; agentId: string };
    organizationId?: string;
  }
): AttemptPlacement | null {
  if (request.execution !== "container") return {};
  if (!settings) return null;
  const identity = request.identity && {
    runId: request.identity.runId,
    organizationId: request.identity.organizationId,
    agentId: request.identity.agentId,
  };
  const organizationId = identity?.organizationId ?? request.organizationId;
  return {
    container: (options) =>
      containerLaunch(settings, {
        ...options,
        home,
        workspace: request.workspace ?? undefined,
        identity,
        organizationId,
      }),
  };
}

/** 경로의 이름들(빈 이름 없음). */
const names = (value: string) => value.split(path.sep).filter(Boolean);
const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

/**
 * 자리 하나를 확인한다. `logical`의 끝 이름들이 `tail`과 같아야 하고, 그 위(서버가 만든 부모)는 실제 경로로 풀며,
 * `tail`의 칸마다 링크가 아닌 폴더인지 본다. 에이전트 컨테이너에는 이 부모와 칸들이 들어가지 않으므로 확인 뒤 바꿀 수 없다.
 */
function slot(
  logical: string,
  tail: string[]
): { source: string; target: string } {
  const target = path.resolve(logical);
  const parts = names(target);
  if (
    parts.length <= tail.length ||
    tail.some((name, i) => parts[parts.length - tail.length + i] !== name)
  )
    throw new ContainerRefusal("mount_outside");
  const anchor = path.resolve(
    path.sep,
    ...parts.slice(0, parts.length - tail.length)
  );
  let current: string;
  try {
    current = realpathSync(anchor);
  } catch {
    throw new ContainerRefusal("mount_missing");
  }
  for (const name of tail) {
    current = path.join(current, name);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      throw new ContainerRefusal("mount_missing");
    }
    if (info.isSymbolicLink()) throw new ContainerRefusal("mount_link");
    if (!info.isDirectory()) throw new ContainerRefusal("mount_type");
  }
  return { source: current, target };
}

/** 임시 폴더 바로 아래, 이 사용자만 쓰는 `babojubot-attempt-*` 폴더. 실제 경로를 돌려준다. */
function attemptFolder(logical: string): string {
  const target = path.resolve(logical);
  let base: string;
  try {
    base = realpathSync(os.tmpdir());
  } catch {
    throw new ContainerRefusal("mount_attempt");
  }
  const parent = (() => {
    try {
      return realpathSync(path.dirname(target));
    } catch {
      throw new ContainerRefusal("mount_attempt");
    }
  })();
  const name = path.basename(target);
  if (parent !== base || !name.startsWith("babojubot-attempt-"))
    throw new ContainerRefusal("mount_attempt");
  const source = path.join(base, name);
  let info;
  try {
    info = lstatSync(source);
  } catch {
    throw new ContainerRefusal("mount_missing");
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new ContainerRefusal("mount_attempt");
  return source;
}

function containerLaunch(
  settings: ContainerSettings,
  options: AttemptContainer & {
    home: string;
    workspace?: NonNullable<RunRequest["workspace"]>;
    identity?: { runId: string; organizationId: string; agentId: string };
    organizationId?: string;
  }
): ContainerLaunch {
  const organizationId = options.organizationId;
  if (!organizationId) throw new ContainerRefusal("mount_outside");
  const mounts: ContainerMount[] = [];
  const grant = (
    found: { source: string; target: string },
    writable: boolean
  ) => mounts.push({ source: found.source, path: found.target, writable });
  // 제품 폴더: providers/<연결>/organizations/<조직>
  const product = slot(options.home, ["organizations", organizationId]);
  grant(product, true);
  const workspace = options.workspace;
  let personal: string | undefined;
  if (workspace) {
    const agentId = options.identity?.agentId;
    const organization = workspace.organization ?? workspace.cwd;
    grant(
      slot(organization, ["organizations", organizationId, "shared"]),
      true
    );
    const base = path.dirname(path.dirname(path.resolve(organization)));
    const member = (folder: string, id: string) => {
      if (
        path.resolve(folder) !== path.join(base, organizationId, "agents", id)
      )
        throw new ContainerRefusal("mount_outside");
      return slot(folder, ["organizations", organizationId, "agents", id]);
    };
    if (workspace.personal) {
      if (!agentId) throw new ContainerRefusal("mount_outside");
      const own = member(workspace.personal, agentId);
      personal = own.target;
      grant(own, true);
    }
    const seen = new Set<string>();
    for (const peer of workspace.peers ?? []) {
      if (peer.agentId === agentId || seen.has(peer.agentId))
        throw new ContainerRefusal("mount_overlap");
      seen.add(peer.agentId);
      grant(member(peer.path, peer.agentId), false);
    }
  } else if (!inside(product.target, options.cwd)) {
    // 세션 정비처럼 workspace가 없으면 작업 폴더가 그 조직 폴더일 때만 읽기로 넣는다.
    grant(
      slot(options.cwd, ["organizations", organizationId, "shared"]),
      false
    );
  }
  if (options.attempt)
    mounts.push({
      source: attemptFolder(options.attempt),
      path: path.resolve(options.attempt),
      writable: false,
    });
  // 서로 겹치는 폴더는 받지 않는다(한 권한이 다른 권한을 덮거나, 넣은 폴더가 다른 폴더의 부모가 되지 않게).
  for (let i = 0; i < mounts.length; i++)
    for (let j = i + 1; j < mounts.length; j++)
      if (
        inside(mounts[i]!.source, mounts[j]!.source) ||
        inside(mounts[j]!.source, mounts[i]!.source) ||
        mounts[i]!.path === mounts[j]!.path
      )
        throw new ContainerRefusal("mount_overlap");
  const folders = [...mounts];
  const within = (target: string) =>
    folders.some((mount) => inside(mount.path, target));
  // 작업 폴더는 넣은 폴더 안이어야 한다. 프로그램이 실제 경로(realpath)로 연 작업 폴더면 같은 확인한 폴더를 그 경로에도 넣는다.
  const cwd = path.resolve(options.cwd);
  if (!within(cwd)) {
    const owner = folders.find((mount) => inside(mount.source, cwd));
    if (!owner) throw new ContainerRefusal("cwd_outside");
    const alias = {
      source: owner.source,
      path: owner.source,
      writable: owner.writable,
    };
    mounts.push(alias);
    // 실행 시도 전용 파일의 자리(작업 폴더 안)도 이 경로로 올 수 있다.
    folders.push(alias);
  }
  for (const file of options.files ?? []) {
    const directory = attemptFolder(path.dirname(file.source));
    const source = path.join(directory, path.basename(file.source));
    let info;
    try {
      info = lstatSync(source);
    } catch {
      throw new ContainerRefusal("mount_missing");
    }
    if (info.isSymbolicLink()) throw new ContainerRefusal("mount_link");
    if (!info.isFile() || info.nlink !== 1)
      throw new ContainerRefusal("mount_type");
    if (!within(path.resolve(file.target)))
      throw new ContainerRefusal("cwd_outside");
    mounts.push({ source, path: path.resolve(file.target), writable: false });
  }
  return {
    settings,
    mounts,
    labels: options.identity
      ? {
          run: options.identity.runId,
          organization: options.identity.organizationId,
        }
      : { organization: organizationId },
    program: options.program,
    // 연구 패키지는 연구 명령이 개인 폴더의 가상환경을 직접 골라 쓴다. 자동으로 PATH에 넣지 않는다.
    env: {
      ...(personal ? { BABOJUBOT_PERSONAL: personal } : {}),
      // 이미지의 시작 프로그램이 이 포트로 역방향 연결을 잇는다.
      ...(options.inbound
        ? { BABOJUBOT_INBOUND_PORT: String(options.inbound) }
        : {}),
    },
    relay: {
      identity: options.identity ? { ...options.identity } : { organizationId },
      required: [
        ...(options.destinations ?? []),
        ...(settings.destinations ?? []),
      ],
      ...(options.inbound ? { inbound: options.inbound } : {}),
    },
  };
}

export function dockerRunArgs(
  launch: ContainerLaunch,
  options: {
    name: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    args: readonly string[];
    /** 이 실행 시도의 중계 폴더(이 컴퓨터 경로). 컨테이너 안 `/run/babojubot`에 읽기로 넣는다. */
    relay: string;
  }
): string[] {
  const { settings } = launch;
  for (const value of [
    ...launch.mounts.flatMap((mount) => [mount.path, mount.source]),
    options.cwd,
    options.relay,
  ])
    if (value.includes(","))
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
  // 네트워크가 없다. 바깥·조직 도구는 중계 폴더의 파일 소켓으로만 닿는다.
  args.push(
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "none"
  );
  for (const mount of launch.mounts)
    args.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.path}` +
        (mount.writable ? "" : ",readonly")
    );
  args.push(
    "--mount",
    `type=bind,source=${options.relay},target=${relayTarget},readonly`
  );
  args.push("--workdir", options.cwd);
  const env: NodeJS.ProcessEnv = { ...options.env, ...launch.env };
  for (const name of Object.keys(env)) {
    if (env[name] === undefined || excluded.has(name)) continue;
    args.push("-e", name);
  }
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

/** `runDocker`가 돌려주는 결과: 끝남 코드(또는 `null`)와 출력, 끈 경우 그 이유(공용 실행이 정한 값). */
type DockerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped?: Extract<TreeRun, { started: true }>["stopped"];
};

/**
 * docker 클라이언트 명령 하나를 공용 실행으로 끝까지 돌린다. 상한·취소에 닿으면 그 트리를 끄고 확인한다. 실패해도 던지지 않고
 * `code: null`로 돌려준다(띄우지 못함, 상한·취소·출력 상한, 끝났음을 확인하지 못함).
 */
export async function runDocker(
  settings: ContainerSettings,
  args: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal
): Promise<DockerResult> {
  let run: Awaited<ReturnType<typeof runTree>>;
  try {
    run = await runTree({
      command: settings.docker,
      args,
      cwd: process.cwd(),
      env: dockerClientEnv({}),
      limitMs: timeoutMs,
      ...(signal ? { signal } : {}),
      maxOutputBytes: 1024 * 1024,
      overflow: "stop",
    });
  } catch (error) {
    return {
      code: null,
      stdout: "",
      // Windows에서 묶음 실행기를 쓸 수 없어 띄우지 않았거나, 띄운 클라이언트가 끝났음을 확인하지 못했다.
      stderr:
        error instanceof TreeLaunchRefused
          ? error.message
          : `the docker client could not be confirmed stopped (${failureCode(error)})`,
    };
  }
  if (!run.started) return { code: null, stdout: "", stderr: run.reason };
  const stdout = run.stdout.toString(),
    stderr = run.stderr.toString();
  if (run.stopped) return { code: null, stdout, stderr, stopped: run.stopped };
  return { code: run.code, stdout, stderr };
}

/** docker 명령이 어떻게 끝났는지: 종료 코드(없으면 띄우지 못했거나 시한·취소·출력 상한에 멈춤과 그 이유)와 오류 출력의 끝(`runDocker`는 띄우지 못한 이유를 여기 담는다). 진단에만 쓴다. */
function dockerEnding(
  result: Pick<DockerResult, "code" | "stderr" | "stopped">
) {
  const reported = result.stderr.trim().slice(-300);
  const ending =
    result.code === null
      ? result.stopped
        ? `stopped: ${result.stopped}`
        : "no exit code"
      : `exit ${result.code}`;
  return `${ending}${reported ? `: ${reported}` : ""}`;
}

export async function removeContainer(
  settings: ContainerSettings,
  name: string
): Promise<boolean> {
  let lastFailure:
    Pick<DockerResult, "code" | "stderr" | "stopped"> | undefined;
  let lastInspected:
    Pick<DockerResult, "code" | "stderr" | "stopped"> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const removed = await runDocker(settings, ["rm", "-f", name]);
    if (removed.code !== 0) lastFailure = removed;
    const inspected = await runDocker(settings, ["container", "inspect", name]);
    lastInspected = inspected;
    if (
      inspected.code !== 0 &&
      /no such (container|object)/i.test(inspected.stderr)
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const reported = lastFailure ?? lastInspected;
  if (reported)
    console.warn(
      `[provider] container ${name} could not be removed (${dockerEnding(reported)})`
    );
  return false;
}

// 컨테이너 안에서 돈다(이미지 시작 프로그램 뒤). 네트워크 장치, 직접 연결, 중계를 거친 금지 목적지, 조직 도구 연결(양성 대조)을 본다.
// TCP 연결이 되면 HTTP 응답 코드와 상관없이 닿은 것이다. 연결 실패만으로 안전하다고 보지 않도록 조직 도구 연결을 함께 본다.
const probeScript = `
const net = require("node:net");
const os = require("node:os");
const input = JSON.parse(process.argv[1]);
// 금지 목적지에 닿지 못한 연결 오류는 답이다. 그 밖의 오류와 중계·조직 도구 연결의 오류는 원인을 남긴다.
// 원래 오류의 사실(code·name)만 보내고 이름 붙이기는 서버(failureCode)가 한다. 문구는 주소가 섞일 수 있어 보내지 않는다.
const failures = [];
const unreachable = (error) =>
  ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EPERM", "EACCES", "ENOTFOUND", "EAI_AGAIN"].includes(error.code);
const note = (probe, error, expected) => {
  if (!expected(error)) failures.push({ probe, code: error.code, name: error.name });
};
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
    socket.once("error", (error) => { note("direct", error, unreachable); finish(false); });
  });
const proxied = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: ${relayPorts.proxy} });
    let text = "";
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(5000, () => { failures.push({ probe: "proxied", timeoutMs: 5000 }); finish(false); });
    socket.once("error", (error) => { note("proxied", error, () => false); finish(false); });
    socket.on("connect", () =>
      socket.write("CONNECT " + (host.includes(":") ? "[" + host + "]" : host) + ":" + port + " HTTP/1.1\\r\\n\\r\\n")
    );
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\\r\\n")) finish(/^HTTP\\/1\\.[01] 200/.test(text));
    });
  });
const tools = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: ${relayPorts.tools} });
    let text = "";
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(5000, () => { failures.push({ probe: "tools", timeoutMs: 5000 }); finish(false); });
    socket.once("error", (error) => { note("tools", error, () => false); finish(false); });
    socket.on("connect", () => socket.write("GET /api/tools/probe HTTP/1.1\\r\\nHost: tools\\r\\nConnection: close\\r\\n\\r\\n"));
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\\r\\n")) finish(/^HTTP\\/1\\.[01] \\d{3}/.test(text));
    });
  });
(async () => {
  const interfaces = Object.entries(os.networkInterfaces())
    .filter(([, list]) => (list ?? []).some((entry) => !entry.internal))
    .map(([name]) => name);
  const [direct, relayed, toolsReached] = await Promise.all([
    Promise.all(input.blocked.map((t) => attempt(t.host, t.port).then((r) => (r ? [t] : [])))),
    Promise.all(input.forbidden.map((t) => proxied(t.host, t.port).then((r) => (r ? [t] : [])))),
    tools(),
  ]);
  console.log(
    JSON.stringify({
      interfaces,
      reached: direct.flat(),
      proxied: relayed.flat(),
      toolsReached,
      failures,
      proxyEnv: process.env.HTTPS_PROXY === "http://127.0.0.1:${relayPorts.proxy}",
    })
  );
})();
`;

/** 이 제품이 아는 시작 프로그램의 판(docker/runner/Dockerfile의 `babojubot.runner` label). */
export const runnerVersion = "2";

const isTarget = (value: unknown): value is { host: string; port: number } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { host?: unknown }).host === "string" &&
  typeof (value as { port?: unknown }).port === "number";

/** 확인 스크립트가 보낸 실패: 어느 확인인지와 원래 오류의 사실(`code`는 없거나 문자열이 아닐 수 있다), 답이 없었으면 기다린 시간. */
type ProbeFailure =
  | { probe: string; code?: unknown; name: string }
  | { probe: string; timeoutMs: number };
const isProbeFailure = (value: unknown): value is ProbeFailure =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { probe?: unknown }).probe === "string" &&
  (typeof (value as { name?: unknown }).name === "string" ||
    typeof (value as { timeoutMs?: unknown }).timeoutMs === "number");

export function createDockerEnvironment(
  settings: ContainerSettings
): DockerEnvironment {
  return {
    settings,
    // 같은 컴퓨터의 Linux Docker Engine만 받는다. 이 컴퓨터에서 확인한 폴더와 중계 소켓이 컨테이너에 그대로 들어가야 하기 때문이다.
    async checkDaemon(signal) {
      // DOCKER_HOST가 없으면 지금 Docker context의 주소를 본다(ssh·tcp context도 다른 컴퓨터다).
      let host = process.env.DOCKER_HOST;
      if (!host) {
        const context = await runDocker(
          settings,
          ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
          60_000,
          signal
        );
        signal.throwIfAborted();
        if (context.code !== 0)
          throw new Error("docker context could not be inspected", {
            cause: new Error(dockerEnding(context)),
          });
        host = context.stdout.trim();
      }
      if (!host.startsWith("unix://"))
        throw new Error("docker daemon is not on this computer");
      const info = await runDocker(
        settings,
        ["info", "--format", "{{json .}}"],
        60_000,
        signal
      );
      signal.throwIfAborted();
      if (info.code !== 0)
        throw new Error("docker is not available", {
          cause: new Error(dockerEnding(info)),
        });
      let value: unknown;
      try {
        value = JSON.parse(info.stdout);
      } catch {
        throw new Error("docker info could not be read");
      }
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("docker info could not be read");
      const parsed = value as Record<string, unknown>;
      if (parsed.OSType !== "linux")
        throw new Error("docker daemon is not a Linux engine");
      if (
        typeof parsed.OperatingSystem === "string" &&
        /docker desktop/i.test(parsed.OperatingSystem)
      )
        throw new Error("Docker Desktop is not supported for isolated runs");
      if (
        Array.isArray(parsed.SecurityOptions) &&
        parsed.SecurityOptions.some(
          (option) => typeof option === "string" && /rootless/.test(option)
        )
      )
        throw new Error("rootless Docker is not supported for isolated runs");
      const image = await runDocker(
        settings,
        [
          "image",
          "inspect",
          "--format",
          '{{ index .Config.Labels "babojubot.runner" }}',
          settings.image,
        ],
        60_000,
        signal
      );
      signal.throwIfAborted();
      if (image.code !== 0)
        throw new Error("runner image is missing", {
          cause: new Error(dockerEnding(image)),
        });
      if (image.stdout.trim() !== runnerVersion)
        throw new Error(
          "runner image is outdated; rebuild it with pnpm runner:build"
        );
    },
    async probe(input, signal) {
      const name = `babojubot-probe-${crypto.randomUUID()}`;
      const relay = settings.relay.open({
        identity: { organizationId: "isolation-probe" },
        // 금지 목적지를 목록에 올려 두고도 주소 확인이 막는지 본다.
        required: input.forbidden.map((target) => ({
          host: target.host,
          port: target.port,
        })),
      });
      let result: DockerResult | undefined;
      // 본문(확인 컨테이너 실행)과 서로 독립인 정리(중계 닫기, 확인 컨테이너 지우기)를 모두 하고 실패를 함께 알린다.
      // 중계를 먼저 닫아, 컨테이너가 늦게 지워지거나 못 지워져도 그 사이 밖에 닿지 못하게 한다.
      await attemptAll(
        [
          async () => {
            await relay.ready;
            const launch: ContainerLaunch = {
              settings,
              mounts: [],
              labels: { probe: "1" },
              program: "node",
              env: {},
              relay: {
                identity: { organizationId: "isolation-probe" },
                required: [],
              },
            };
            const args = dockerRunArgs(launch, {
              name,
              cwd: "/",
              env: {},
              args: ["-e", probeScript, JSON.stringify(input)],
              relay: relay.directory,
            });
            result = await runDocker(settings, args, 60_000, signal);
          },
          () => relay.close(),
          async () => {
            if (!(await removeContainer(settings, name)))
              throw new Error(
                `the isolation probe container ${name} could not be removed`
              );
          },
        ],
        "the isolation probe could not finish"
      );
      const finished = result!;
      if (finished.code !== 0)
        throw new Error("isolation probe container failed", {
          cause: new Error(dockerEnding(finished)),
        });
      const line = finished.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .at(-1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line ?? "");
      } catch {
        throw new Error("isolation probe returned an invalid result");
      }
      const value = (
        typeof parsed === "object" && parsed !== null ? parsed : {}
      ) as Record<string, unknown>;
      if (
        !Array.isArray(value.interfaces) ||
        !value.interfaces.every((entry) => typeof entry === "string") ||
        !Array.isArray(value.reached) ||
        !value.reached.every(isTarget) ||
        !Array.isArray(value.proxied) ||
        !value.proxied.every(isTarget) ||
        typeof value.toolsReached !== "boolean" ||
        !Array.isArray(value.failures) ||
        !value.failures.every(isProbeFailure) ||
        typeof value.proxyEnv !== "boolean"
      )
        throw new Error("isolation probe returned an invalid result");
      // 컨테이너 안의 오류를 같은 모양으로 되살려 이름 붙이기를 failureCode 한 곳에 맡긴다. 답이 없었으면 기다린 시간을 적는다.
      const failures = value.failures as ProbeFailure[];
      for (const failure of failures)
        console.warn(
          `[provider] the isolation probe's ${failure.probe} check failed (${
            "timeoutMs" in failure
              ? `no answer within ${failure.timeoutMs} ms`
              : failureCode(
                  Object.assign(new Error(), {
                    name: failure.name,
                    code: failure.code,
                  })
                )
          })`
        );
      return {
        interfaces: value.interfaces as string[],
        reached: value.reached as { host: string; port: number }[],
        proxied: value.proxied as { host: string; port: number }[],
        toolsReached: value.toolsReached && value.proxyEnv,
        unverified: [...new Set(failures.map((failure) => failure.probe))],
      };
    },
    async removeOrphans() {
      const listed = await runDocker(settings, [
        "ps",
        "-aq",
        "--filter",
        `label=babojubot.owner=${settings.owner}`,
      ]);
      if (listed.code !== 0)
        throw new Error(
          `leftover containers could not be listed (${dockerEnding(listed)})`
        );
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
  /** 컨테이너에서 직접 닿으면 안 되는 곳(이 컴퓨터의 주소 × 사용자 API·DB 포트). */
  blocked: { host: string; port: number }[];
  /** 중계를 거쳐도 열리면 안 되는 곳. 목록에 올려 두고도 주소 확인이 막는지 본다. */
  forbidden: { host: string; port: number }[];
};
export type IsolationProbeResult = {
  /** loopback 밖의 네트워크 장치. 없어야 한다. */
  interfaces: string[];
  reached: { host: string; port: number }[];
  proxied: { host: string; port: number }[];
  /** 중계를 거쳐 조직 도구에 닿았고 이미지의 시작 프로그램이 프록시 환경을 정했는지. */
  toolsReached: boolean;
  /**
   * 끝까지 확인하지 못한 검사(`direct`·`proxied`·`tools`)의 이름. 예상한 차단(닿지 못한 연결)은 들지 않는다. 하나라도 있으면
   * 결과를 모르는 것이므로 안전하다고 보지 않는다(fail closed).
   */
  unverified: string[];
};
/** 격리 실행의 Docker 환경. 서버가 안전 확인·남은 컨테이너 정리에 쓴다. */
export type DockerEnvironment = {
  settings: ContainerSettings;
  /** 같은 컴퓨터의 Linux Docker Engine이고 이미지가 이 제품의 시작 프로그램 판인지 본다. 아니면 던진다. */
  checkDaemon(signal: AbortSignal): Promise<void>;
  /** 실행 시도와 같은 권한·네트워크 없음·중계의 시험 컨테이너로 목표를 본다. */
  probe(
    input: IsolationProbe,
    signal: AbortSignal
  ): Promise<IsolationProbeResult>;
  /** 이 제품 폴더(`owner`)가 띄웠다가 남은 컨테이너를 지운다. */
  removeOrphans(): Promise<void>;
};
