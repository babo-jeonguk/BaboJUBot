import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  hasErrorCode,
  orIfMissing,
  type EgressRefusal,
  type ProviderConnection,
  type RunRequest,
} from "@babojubot/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import { createClaudeProvider as unownedClaudeProvider } from "./claude.ts";
import {
  createCodexProvider as unownedCodexProvider,
  type CodexOptions,
} from "./codex.ts";
import { createOpenCodeProvider as unownedOpenCodeProvider } from "./opencode.ts";
import { createAntigravityProvider as unownedAntigravityProvider } from "./antigravity.ts";
import {
  createDockerEnvironment,
  type ContainerSettings,
  removeContainer,
  runDocker,
} from "./container.ts";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import { lifelineHolder } from "@babojubot/process/test-cleanup";
import {
  manualClock,
  probeEnvironment,
  within,
} from "@babojubot/process/test-support";
import { attachedRelayHub, request } from "./test-support.ts";
import { refusing, resetRefusing } from "./connect-failure-support.ts";
import { startProcess } from "./process.ts";
import type { CredentialRelay } from "./credential-relay.ts";
import { testFolders } from "./test-folders.ts";

/**
 * 공용 실행(`runTree`)의 결과를 갈음한다. 비어 있으면 실제로 돈다. 상한에 닿아 끈 명령은 끈 이유(`stopped`)와 그 트리를 끝낸 신호를
 * 함께 가질 수 있다. 두 값을 함께 가진 결과를 주입해 둘 다 남는지 본다(#286 리뷰 1회차 STD-2).
 */
const tree = vi.hoisted(() => ({
  run: undefined as undefined | (() => unknown),
}));
vi.mock("@babojubot/process", async (importOriginal) => {
  const real = await importOriginal<typeof import("@babojubot/process")>();
  return {
    ...real,
    runTree: (...args: Parameters<typeof real.runTree>) =>
      tree.run ? Promise.resolve(tree.run()) : real.runTree(...args),
  };
});
/** 상한에 닿아 끈 트리의 결과: 끈 이유와 끝낸 신호를 함께 가진다. */
const stoppedBySignal = () => ({
  started: true,
  code: null,
  signal: "SIGKILL",
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  stopped: "limit",
});

// 격리 실행(#102)을 실제 Docker 없이 확인한다. 가짜 docker(test-fixtures/fake-docker.mjs)는 받은 명령을 남기고,
// `run`이면 컨테이너 안 프로그램 이름을 이 컴퓨터의 재생 프로그램으로 바꿔 컨테이너 환경 변수·작업 폴더로 실행한다.

/** 링크 만들기를 거절하는 오류 코드(권한 없는 Windows·링크를 모르는 파일 시스템). 비어 있으면 실제로 만든다. */
let refusal: string | null = null;
/** 이 이름이 경로에 든 폴더 지우기가 잠긴 파일처럼(EBUSY) 계속 실패한다. 비어 있으면 실제로 지운다. */
const locked = vi.hoisted(() => ({ folder: null as RegExp | null }));
/**
 * 이름이 `opencode.db-wal`인 파일을 열기 바로 전(`beforeWal`), 이름이 `opencode.db`인 경로를 `lstat`으로 보기 바로 전(`beforeNameCheck`,
 * 복사를 마친 뒤 이름이 아직 읽은 파일인지 볼 때)에 한 번 부른다. 비어 있으면 그냥 연다·본다.
 */
const opening = vi.hoisted(() => ({
  beforeWal: undefined as undefined | (() => void),
  beforeNameCheck: undefined as undefined | (() => void),
  /** 참이면 이름이 `opencode.db`인 파일의 다음 열기 한 번이 "없음"으로 실패한다(그 자리는 그대로 있다). */
  missMain: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      locked.folder?.test(String(args[0]))
        ? Promise.reject(
            Object.assign(new Error("EBUSY: resource busy or locked, rm"), {
              code: "EBUSY",
            })
          )
        : actual.rm(...args),
    symlink: (...args: Parameters<typeof actual.symlink>) =>
      refusal
        ? Promise.reject(
            Object.assign(new Error(`${refusal}: cannot link`), {
              code: refusal,
            })
          )
        : actual.symlink(...args),
    lstat: ((...args: Parameters<typeof actual.lstat>) => {
      const before = opening.beforeNameCheck;
      if (before && String(args[0]).endsWith("opencode.db")) {
        opening.beforeNameCheck = undefined;
        before();
      }
      return actual.lstat(...args);
    }) as typeof actual.lstat,
    open: (...args: Parameters<typeof actual.open>) => {
      if (opening.missMain && String(args[0]).endsWith("opencode.db")) {
        opening.missMain = false;
        return Promise.reject(
          Object.assign(new Error("no such file"), { code: "ENOENT" })
        );
      }
      const before = opening.beforeWal;
      if (before && String(args[0]).endsWith("opencode.db-wal")) {
        opening.beforeWal = undefined;
        before();
      }
      return actual.open(...args);
    },
  };
});

/**
 * 중계의 목적지 판정을 갈음한다. 비어 있으면 실제 판정이다. 격리 확인은 중계의 주소 확인이 금지 목적지를 막는지 보는 검사이므로,
 * 그 확인이 고장 난 중계(금지 목적지를 열어 주거나 다른 이유로 거부함)를 만들어 확인이 그것을 알아보는지 본다.
 */
const policy = vi.hoisted(() => ({
  decide: undefined as
    | undefined
    | ((
        host: string,
        port: number
      ) =>
        | { allowed: true; addresses: string[] }
        | { allowed: false; reason: EgressRefusal }),
}));
// 중계가 허용된 목적지로 붙는 연결(`relay.ts`의 `net.connect`)을 정한 오류로 실패시킨다(connect-failure-support.ts). 정한 포트가
// 없으면 모든 연결이 진짜로 간다.
vi.mock("node:net", async (importOriginal) =>
  (await import("./connect-failure-support.ts")).failingNet(
    await importOriginal()
  )
);
vi.mock("./egress-policy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./egress-policy.ts")>();
  return {
    ...actual,
    decideDestination: (
      ...args: Parameters<typeof actual.decideDestination>
    ) =>
      policy.decide
        ? Promise.resolve(policy.decide(args[1], args[2]))
        : actual.decideDestination(...args),
  };
});

const folders = testFolders();
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(() => lifelines.close());
let leftCount = 0;
/**
 * 프로그램이 남길 자식의 연결 쥐기(`code`, 연결을 쥔 뒤 준비 프레임을 낸다)와 그 정리. 자식은 시험 폴더에서 돈다. 정리는 폴더를
 * 지우기 전에 연결이 열려 있음을 본 직후에만 그 번호로 끄고 연결의 닫힘을 기다린다. 이미 끝났으면 신호하지 않는다.
 */
async function leftChild() {
  const folder = await folders.make("babojubot-left-child-");
  const name = `left-child-${++leftCount}`;
  const held = lifelineHolder(
    lifelines,
    name,
    path.join(folder, "pid"),
    "console.log(JSON.stringify({ ready: true }));"
  );
  folders.own(held.end, "the child the program left");
  return { name, code: held.code };
}
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createClaudeProvider = folders.owning(unownedClaudeProvider);
const createCodexProvider = folders.owning(unownedCodexProvider);
const createOpenCodeProvider = folders.owning(unownedOpenCodeProvider);
const createAntigravityProvider = folders.owning(unownedAntigravityProvider);
afterEach(() => {
  resetRefusing();
  refusal = null;
  locked.folder = null;
  policy.decide = undefined;
  opening.beforeWal = undefined;
  opening.beforeNameCheck = undefined;
  opening.missMain = false;
  tree.run = undefined;
  vi.unstubAllEnvs();
});

type Call = {
  args: string[];
  env?: Record<string, string>;
  relayOpen?: boolean;
};
const image = "babojubot-runner-test";
/** 남은 로그인이 있어 시작하지 않은 실행 시도의 안내. */
const leftLogin = "로그인 기록이 남아 있어";
/**
 * 남은 로그인을 확인하지 못해 시작하지 않은 실행 시도의 안내: 공통 문장과 이유마다 다른 부분. 확인하지 못한 것을 "남은 로그인"으로
 * 접으면 판정은 같아도 사용자가 보는 이유가 틀린다(#286).
 */
const unverifiedLogin = "남은 로그인을 확인하지 못했습니다";
const unverifiedBecause = {
  path: "링크나 폴더가 아닌 것이 있어",
  notRegular: "일반 파일이 아닌 것(링크·특수 파일)이 있어",
  unreadable: "로그인 기록을 읽지 못해",
  changed: "로그인 저장소가 확인 중에 바뀌어",
} as const;
/** 확인하지 못한 이유로 시작하지 않았는지 본다. 남은 로그인이라고 하지 않는다. */
function expectUnverified(
  error: string | null | undefined,
  because: keyof typeof unverifiedBecause
) {
  expect(error).toContain(unverifiedLogin);
  expect(error).toContain(unverifiedBecause[because]);
  expect(error).not.toContain(leftLogin);
}
const fixture = (name: string) => path.resolve("test-fixtures", name);
/** 임시 폴더 바로 아래 폴더의 실제 경로. 임시 폴더가 링크 뒤에 있으면(macOS /var → /private/var) mount 원본은 실제 경로다. 폴더는 이미 지워졌을 수 있다. */
const canonicalTemp = (folder: string) =>
  path.join(realpathSync(path.dirname(folder)), path.basename(folder));

async function setup(programs: Record<string, string[]>, base = tmpdir()) {
  // 임시 폴더가 링크 뒤에 있으면(macOS) 그 실제 경로로 둔다. 링크 뒤 데이터 폴더는 container-mounts 시험이 본다.
  const root = await realpath(
    await mkdtemp(path.join(base, "babojubot-container-"))
  );
  folders.adopt(root);
  const state = path.join(root, "docker-state");
  await mkdir(state);
  const org = crypto.randomUUID(),
    self = crypto.randomUUID(),
    peer = crypto.randomUUID();
  const shared = path.join(root, "organizations", org, "shared");
  const personal = path.join(root, "organizations", org, "agents", self);
  const peerFolder = path.join(root, "organizations", org, "agents", peer);
  for (const folder of [shared, personal, peerFolder])
    await mkdir(folder, { recursive: true });
  const container: ContainerSettings = {
    docker: [
      process.execPath,
      fixture("fake-docker.mjs"),
      state,
      JSON.stringify(programs),
    ],
    image,
    owner: "owner-test",
    relay: attachedRelayHub(),
  };
  const isolated = (): RunRequest => {
    const input = request();
    input.identity.organizationId = org;
    input.identity.agentId = self;
    input.context.organization.id = org;
    return {
      ...input,
      execution: "container",
      workspace: {
        cwd: shared,
        organization: shared,
        personal,
        peers: [{ agentId: peer, path: peerFolder, access: "read" }],
      },
    };
  };
  const calls = async (): Promise<Call[]> => {
    try {
      return (await readFile(path.join(state, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call);
    } catch {
      return [];
    }
  };
  return {
    root,
    state,
    container,
    isolated,
    calls,
    shared,
    personal,
    peerFolder,
    org,
    self,
  };
}

// A container program that leaves a child sharing its output. The child records whether the relay is still open when it is told
// to stop, then ends. The program ends on its first input line, or, after its input closes, once the file `<log>.exit` exists.
/**
 * 자식 하나를 남기고 끝나는 프로그램. 자식은 끄라는 신호(SIGTERM)를 받을 때 중계가 아직 열려 있었는지 기록하고 끝난다. 자식은
 * 연결(`held`)을 쥔 뒤 준비 프레임을 낸다. 시험이 끄지 못한 자식은 정리가 그 연결이 열려 있음을 본 직후에만 그 번호로 끈다.
 */
const leftBehind = (held: string) => `
  const fs = require("node:fs"), path = require("node:path");
  const relay = JSON.parse(process.env.FAKE_DOCKER_MOUNTS).find((m) => m.target === "/run/babojubot").source;
  const record = JSON.stringify([process.argv[1], path.join(relay, "egress.sock")]);
  require("node:child_process").spawn(process.execPath, ["-e", \`
    const [log, egress] = \${record};
    process.on("SIGTERM", () => {
      require("node:fs").writeFileSync(log, require("node:fs").existsSync(egress) ? "relay open" : "relay closed");
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  \` + ${JSON.stringify(held)}], { stdio: ["ignore", "inherit", "ignore"] });
  process.stdin.once("data", () => process.exit(0));
  // Cancelled: the input closes, and the program ends when the test lets it.
  process.stdin.on("end", () =>
    setInterval(() => fs.existsSync(process.argv[1] + ".exit") && process.exit(0), 10)
  );
`;
/** Starting a (fake Docker) program and seeing it react, on a slow machine (#215). */
const programStart = { timeout: 30_000 };
const runCall = (calls: Call[]) => {
  const runs = calls.filter((c) => c.args.includes("run"));
  expect(runs).toHaveLength(1);
  return runs[0]!;
};
const valuesOf = (args: string[], flag: string) =>
  args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
const nameOf = (call: Call) => valuesOf(call.args, "--name")[0]!;
const removed = (calls: Call[], name: string) =>
  calls.some((c) => c.args.includes("rm") && c.args.includes(name));
const control = (signal = new AbortController().signal) => ({
  signal,
  emit: async () => {},
});

// Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행). 실행 시도 중계의 파일 소켓은 Linux·macOS에서 본다.
describe.skipIf(process.platform === "win32")("an isolated attempt", () => {
  it("runs the provider in one container with only the allowed folders, no privileges and no GitHub login, then removes it", async () => {
    const env = await setup({
      claude: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("claude-finish.synthetic.json"),
      ],
    });
    await mkdir(path.join(env.root, "providers/claude"), { recursive: true });
    await writeFile(
      path.join(env.root, "providers/claude/setup-token"),
      "synthetic-login",
      { mode: 0o600 }
    );
    vi.stubEnv("GH_TOKEN", "github-secret");
    vi.stubEnv("GITHUB_TOKEN", "github-secret");
    vi.stubEnv("BABOJUBOT_CLAUDE_PASS_ENV", "GH_TOKEN,GITHUB_TOKEN");
    // 이 컴퓨터의 프로그램 위치 설정은 컨테이너에서 쓰지 않는다. 컨테이너에는 이미지의 프로그램이 있다.
    vi.stubEnv("BABOJUBOT_CLAUDE_COMMAND", "/host/only/claude");
    const provider = createClaudeProvider({
      dataDir: env.root,
      container: env.container,
    });
    expect(provider.isolatable).toBe(true);

    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("completed");

    const calls = await env.calls();
    const run = runCall(calls);
    const args = run.args;
    // 그 조직의 제품 폴더. 로그인 토큰이 든 연결 폴더는 넣지 않는다.
    const home = path.join(env.root, "providers/claude/organizations", env.org);
    // Windows에는 uid가 없어 Docker Desktop이 정한 사용자로 돈다.
    expect(valuesOf(args, "--user")).toEqual(
      process.getuid && process.getgid
        ? [`${process.getuid()}:${process.getgid()}`]
        : []
    );
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toContain("no-new-privileges");
    // 네트워크가 없다. 바깥과 조직 도구는 이 실행 시도의 중계 폴더(읽기만)로만 닿는다.
    expect(valuesOf(args, "--network")).toEqual(["none"]);
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("--add-host");
    expect(args).not.toContain("--privileged");
    expect(valuesOf(args, "--workdir")).toEqual([env.shared]);
    // 서버 재시작 때 이 제품 폴더의 남은 컨테이너만 찾아 지우도록 표식을 단다.
    const labels = valuesOf(args, "--label");
    expect(labels).toContain("babojubot.owner=owner-test");
    expect(labels).toContainEqual(
      expect.stringMatching(/^babojubot\.run=[0-9a-f-]{36}$/)
    );
    // 조직 폴더·자기 개인 폴더·그 조직의 제품 폴더는 읽기·쓰기, 동료 개인 폴더와 이 실행 시도의 파일 폴더는 읽기만. 그 밖에는 없다.
    const relayMount = valuesOf(args, "--mount").filter((m) =>
      m.includes("target=/run/babojubot,")
    );
    expect(relayMount).toEqual([
      expect.stringMatching(
        /^type=bind,source=.*babojubot-relay-[^,]+,target=\/run\/babojubot,readonly$/
      ),
    ]);
    expect(
      valuesOf(args, "--mount")
        .filter((m) => !relayMount.includes(m))
        .sort()
    ).toEqual(
      [
        `type=bind,source=${env.shared},target=${env.shared}`,
        `type=bind,source=${env.personal},target=${env.personal}`,
        `type=bind,source=${env.peerFolder},target=${env.peerFolder},readonly`,
        `type=bind,source=${home},target=${home}`,
        // 토큰이 든 이 실행 시도만의 파일 폴더(읽기만).
        `type=bind,source=${canonicalTemp(path.dirname(valuesOf(args, "--mcp-config")[0]!))},target=${path.dirname(valuesOf(args, "--mcp-config")[0]!)},readonly`,
      ].sort()
    );
    expect(args.join(" ")).not.toMatch(/docker\.sock|--volume|-v /);
    // 이미지 다음은 컨테이너 안 프로그램 이름이다.
    expect(args[args.indexOf(image) + 1]).toBe("claude");
    // 비밀값은 명령줄에 싣지 않는다.
    expect(args.join(" ")).not.toMatch(
      /private-run-token|synthetic-login|github-secret/
    );
    // 컨테이너 환경: 제품 홈은 있고, 연결의 로그인 대신 인증 중계 주소와 이 실행 시도의 권한만 있다(#148).
    // GitHub 로그인과 이 컴퓨터의 임시 폴더는 없다. 공유 가상환경은 자동으로 쓰지 않고, 연구 명령이 고를 개인 폴더만 알려 준다.
    expect(run.env).toMatchObject({
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, "config"),
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1/api/relay/claude",
      BABOJUBOT_PERSONAL: env.personal,
    });
    expect(run.env!.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(run.env)).not.toContain("synthetic-login");
    expect(run.env).not.toHaveProperty("BABOJUBOT_VENV");
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "TMPDIR",
      "TMP",
      "TEMP",
      "PATH",
    ])
      expect(run.env).not.toHaveProperty(name);
    // 끝나면 그 컨테이너를 지운다.
    expect(removed(calls.slice(calls.indexOf(run) + 1), nameOf(run))).toBe(
      true
    );
  });

  it("keeps the run token file out of the product folder that every agent container of the organization shares", async () => {
    const env = await setup({
      claude: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("claude-finish.synthetic.json"),
      ],
    });
    const provider = createClaudeProvider({
      dataDir: env.root,
      container: env.container,
    });
    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("completed");
    const run = runCall(await env.calls());
    const home = path.join(env.root, "providers/claude");
    // 조직의 제품 폴더는 그 조직의 같은 연결 에이전트 컨테이너에 모두 들어간다. 실행 시도 토큰이 든 MCP 설정은 그 밖의 이 실행 시도 전용 폴더에 두고 읽기만 넣는다.
    const config = valuesOf(run.args, "--mcp-config")[0]!;
    expect(path.relative(home, config).startsWith("..")).toBe(true);
    const attempt = path.dirname(config);
    expect(valuesOf(run.args, "--mount")).toContain(
      `type=bind,source=${canonicalTemp(attempt)},target=${attempt},readonly`
    );
    // 지침 파일도 같은 폴더에 둔다.
    expect(
      path.dirname(valuesOf(run.args, "--append-system-prompt-file")[0]!)
    ).toBe(attempt);
    // 끝나면 그 폴더를 지운다.
    await expect(readFile(config, "utf8")).rejects.toThrow();
  });

  it("gives an isolated Antigravity run its organization tools token only through the ACP session, never through a file or the command line", async () => {
    const env = await setup({});
    const recording = path.join(env.root, "agy.json");
    await writeFile(
      recording,
      JSON.stringify({
        steps: [
          { input: { method: "initialize" } },
          { frame: { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } } },
          {
            input: {
              method: "session/new",
              params: {
                mcpServers: [
                  {
                    name: "organization",
                    headers: [
                      {
                        name: "Authorization",
                        value: "Bearer private-run-token",
                      },
                    ],
                  },
                ],
              },
            },
          },
          { frame: { jsonrpc: "2.0", id: 2, result: { sessionId: "c1" } } },
          { input: { method: "session/prompt" } },
          {
            frame: {
              jsonrpc: "2.0",
              id: 3,
              result: { stopReason: "end_turn" },
            },
          },
          { inputEnd: true },
          { exit: 0 },
        ],
      })
    );
    env.container.docker = [
      process.execPath,
      fixture("fake-docker.mjs"),
      env.container.docker[2]!,
      JSON.stringify({
        agy: [process.execPath, fixture("replay.mjs"), recording],
      }),
    ];
    const provider = createAntigravityProvider({
      dataDir: env.root,
      container: env.container,
    });
    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("completed");
    const run = runCall(await env.calls());
    expect(JSON.stringify(run)).not.toContain("private-run-token");
    // 작업 폴더에 조직 도구 설정을 두지 않는다.
    await expect(
      stat(path.join(env.shared, ".agents/mcp_config.json"))
    ).rejects.toThrow();
  });

  it("leaves a user's own Antigravity configuration in the workspace alone, and still runs in a container", async () => {
    const env = await setup({
      agy: [process.execPath, fixture("antigravity-simulator.mjs")],
    });
    const config = path.join(env.shared, ".agents/mcp_config.json");
    await mkdir(path.dirname(config));
    await writeFile(config, '{"user":"keep"}');
    const provider = createAntigravityProvider({
      dataDir: env.root,
      container: env.container,
    });
    await provider.adapter.execute(env.isolated(), control());
    expect(await readFile(config, "utf8")).toBe('{"user":"keep"}');
    expect((await env.calls()).some((c) => c.args.includes("run"))).toBe(true);
  });

  it("removes the container as the last step of cancellation", async () => {
    const env = await setup({
      claude: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("claude-cancel.synthetic.json"),
      ],
    });
    const provider = createClaudeProvider({
      dataDir: env.root,
      container: env.container,
    });
    const controller = new AbortController();
    const result = await provider.adapter.execute(env.isolated(), {
      signal: controller.signal,
      emit: async () => controller.abort(),
    });
    expect(result.stopReason).toBe("cancelled");
    const calls = await env.calls();
    expect(removed(calls, nameOf(runCall(calls)))).toBe(true);
  });

  it("takes the relay back before stopping what a finished program left running, even when that keeps its output open", async () => {
    const left = await leftChild();
    const env = await setup({
      codex: [process.execPath, "-e", leftBehind(left.code)],
    });
    // The program shares the Docker program's output, so the child it leaves holds that output open after both end.
    await writeFile(path.join(env.state, "pass-output"), "");
    const log = path.join(env.root, "relay-at-stop");
    const started = folders.ownRun(
      startProcess({
        command: ["unused"],
        args: [log],
        cwd: env.root,
        env: { PATH: process.env.PATH },
        container: {
          settings: env.container,
          mounts: [],
          labels: {},
          program: "codex",
          env: {},
          relay: { identity: { organizationId: env.org }, required: [] },
        },
        onFrame: async () => {
          started.write({ go: true });
        },
      })
    );

    await within(started.done, 30_000, "the run did not finish");
    // The child recorded, when it was told to stop, whether the relay was still open.
    expect(await readFile(log, "utf8")).toBe("relay closed");
  }, 20_000);

  it("takes the relay back before stopping what a cancelled program left running, when the program ends before its stop timer", async () => {
    const left = await leftChild();
    const env = await setup({
      codex: [process.execPath, "-e", leftBehind(left.code)],
    });
    await writeFile(path.join(env.state, "pass-output"), "");
    const log = path.join(env.root, "relay-at-stop");
    // The stop timer (2 s after the cancel) runs on the test clock, so the program ends before it by state, not by racing it on a
    // slow machine. Once the program ends, the run takes the relay back and stops the tree at once; nothing waits on the clock for
    // the output (#268; before, a 1 s output wait ran on this clock too).
    const clock = manualClock();
    const started = folders.ownRun(
      startProcess({
        clock,
        command: ["unused"],
        args: [log],
        cwd: env.root,
        env: { PATH: process.env.PATH },
        container: {
          settings: env.container,
          mounts: [],
          labels: {},
          program: "codex",
          env: {},
          relay: { identity: { organizationId: env.org }, required: [] },
        },
        onFrame: async () => {
          // Cancel: close the input. The stop timer would signal the group 2 s later.
          started.end();
        },
      }),
      // 취소 뒤 끄기 타이머는 시험 시계 위라, 정리는 그 타이머까지 시계를 옮긴다.
      clock
    );

    await expect.poll(() => clock.scheduled(), programStart).toEqual([2_000]);
    clock.advance(1_500);
    // The program ends 1.5 s after the cancel, before the stop timer.
    await writeFile(log + ".exit", "");
    await within(started.done, 30_000, "the run did not finish");
    expect(await readFile(log, "utf8")).toBe("relay closed");
  }, 20_000);

  it("takes the relay back before removing the container, even when Docker cannot remove it", async () => {
    const env = await setup({
      claude: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("claude-cancel.synthetic.json"),
      ],
    });
    // Docker 프로그램은 끝났지만 daemon이 컨테이너를 지우지 못한다. 컨테이너가 살아 있어도 중계는 이미 닫혀 있어야 한다.
    await writeFile(path.join(env.state, "rm-fails"), "");
    const provider = createClaudeProvider({
      dataDir: env.root,
      container: env.container,
    });
    const controller = new AbortController();
    const result = await provider.adapter.execute(env.isolated(), {
      signal: controller.signal,
      emit: async () => controller.abort(),
    });
    expect(result.stopReason).toBe("cancelled");
    const calls = await env.calls();
    const name = nameOf(runCall(calls));
    const removals = calls.filter(
      (c) => c.args.includes("rm") && c.args.includes(name)
    );
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.map((c) => c.relayOpen)).toEqual(removals.map(() => false));
  }, 20_000);

  it.each([
    ["Claude", createClaudeProvider],
    ["Codex", createCodexProvider],
    ["OpenCode", createOpenCodeProvider],
    ["Antigravity", createAntigravityProvider],
  ])(
    "never runs %s on this machine instead when no container settings exist",
    async (_name, create) => {
      const env = await setup({});
      const marker = path.join(env.root, "ran-on-this-machine");
      const provider = create({
        dataDir: env.root,
        // 이 컴퓨터에서 돌면 표시 파일을 남기는 프로그램이다.
        command: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
        ],
      });
      expect(provider.isolatable).toBe(true);
      const result = await provider.adapter.execute(env.isolated(), control());
      expect(result.stopReason).toBe("failed");
      expect(await env.calls()).toEqual([]);
      await expect(stat(marker)).rejects.toThrow();
    }
  );

  it("keeps running on this machine when isolation is off", async () => {
    const env = await setup({});
    const provider = createClaudeProvider({
      dataDir: env.root,
      container: env.container,
      command: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("claude-finish.synthetic.json"),
      ],
    });
    const input = env.isolated();
    delete input.execution;
    expect((await provider.adapter.execute(input, control())).stopReason).toBe(
      "completed"
    );
    expect(await env.calls()).toEqual([]);
  });

  it("compacts a session in a container when isolation is on", async () => {
    const env = await setup({});
    const compact = path.join(env.root, "compact.json");
    await writeFile(
      compact,
      JSON.stringify({
        steps: [
          { input: { type: "user", message: { content: "/compact" } } },
          {
            frame: {
              type: "system",
              subtype: "init",
              session_id: "session-one",
            },
          },
          {
            frame: {
              type: "system",
              subtype: "compact_boundary",
              session_id: "session-one",
            },
          },
          {
            frame: {
              type: "result",
              subtype: "success",
              session_id: "session-one",
            },
          },
          { exit: 0 },
        ],
      })
    );
    env.container.docker = [
      env.container.docker[0],
      ...env.container.docker.slice(1, 3),
      JSON.stringify({
        claude: [process.execPath, fixture("replay.mjs"), compact],
      }),
    ];
    const provider = createClaudeProvider({
      dataDir: env.root,
      container: env.container,
    });
    const result = await provider.adapter.precompact!(
      {
        session: {
          id: "session-one",
          launch: { instructions: "saved", cwd: env.shared, model: null },
        },
        access: request().access,
        execution: "container",
        organizationId: env.org,
      },
      new AbortController().signal
    );
    expect(result.ok).toBe(true);
    const calls = await env.calls();
    const run = runCall(calls);
    expect(valuesOf(run.args, "--workdir")).toEqual([env.shared]);
    // 그 조직의 제품 폴더에서 압축한다.
    expect(run.env?.HOME).toBe(
      path.join(env.root, "providers/claude/organizations", env.org)
    );
    expect(removed(calls, nameOf(run))).toBe(true);
  });

  it("runs Codex in a container", async () => {
    const env = await setup({
      codex: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("codex-finish.synthetic.json"),
      ],
    });
    const provider = createCodexProvider({
      dataDir: env.root,
      container: env.container,
    });
    expect(provider.isolatable).toBe(true);
    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("completed");
    const calls = await env.calls();
    const run = runCall(calls);
    expect(run.args[run.args.indexOf(image) + 1]).toBe("codex");
    expect(valuesOf(run.args, "--workdir")).toEqual([env.shared]);
    expect(removed(calls, nameOf(run))).toBe(true);
  });

  // 실행 시도 전용 폴더(실행 시도의 로그인 파일이 든 곳)를 끝내 지우지 못해도 실행 결과는 그대로이고, 운영자가 찾을 수 있게
  // 연결과 실행 시도 ID를 진단으로 남긴다. 진단에는 파일 내용이나 토큰을 담지 않는다.
  it("keeps a finished Codex run's result and records an attempt folder it cannot remove", async () => {
    const env = await setup({
      codex: [
        process.execPath,
        fixture("replay.mjs"),
        fixture("codex-finish.synthetic.json"),
      ],
    });
    const provider = createCodexProvider({
      dataDir: env.root,
      container: env.container,
    });
    const input = env.isolated();
    const logged = [
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    onTestFinished(() => {
      for (const spy of logged) spy.mockRestore();
    });
    // 지우지 못하게 한 실행 시도 폴더는 시험 정리가 지운다. 컨테이너에 넣은 로그인 파일의 폴더에서 찾는다.
    // 실패 주입은 그 전에 afterEach가 끈다.
    folders.own(async () => {
      for (const call of await env.calls())
        for (const mount of valuesOf(call.args, "--mount")) {
          const source = /source=([^,]*babojubot-attempt-[^,/\\]*)/.exec(mount);
          if (source) folders.adopt(source[1]!);
        }
    }, "the attempt folder whose removal was made to fail");
    locked.folder = /babojubot-attempt-/;
    const result = await provider.adapter.execute(input, control());
    expect(result.stopReason).toBe("completed");
    const lines = logged.flatMap((spy) =>
      spy.mock.calls.map((call) => call.map(String).join(" "))
    );
    expect(
      lines.some(
        (line) => line.includes("codex") && line.includes(input.identity.runId)
      ),
      lines.join("\n")
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(input.access.token);
  });

  it("controls OpenCode in a container with no network through connections the container offers to its relay", async () => {
    const env = await setup({
      opencode: [process.execPath, fixture("opencode-simulator.mjs")],
    });
    const provider = createOpenCodeProvider({
      dataDir: env.root,
      // 연결 폴더의 로그인을 읽는 이 컴퓨터의 프로그램도 가짜로 둔다.
      command: [process.execPath, fixture("opencode-simulator.mjs")],
      container: env.container,
    });
    expect(provider.isolatable).toBe(true);
    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("completed");
    const calls = await env.calls();
    const run = runCall(calls);
    expect(run.args).not.toContain("--publish");
    expect(run.env).toMatchObject({ BABOJUBOT_INBOUND_PORT: "4096" });
    expect(run.args.slice(run.args.indexOf(image) + 1)).toEqual(
      expect.arrayContaining([
        "opencode",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        "4096",
      ])
    );
    expect(removed(calls, nameOf(run))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "an isolated attempt never receives the connection's login (#148)",
  () => {
    it("copies no OpenCode login into the organization's product folder, and does not start over one left there", async () => {
      const env = await setup({
        opencode: [process.execPath, fixture("opencode-simulator.mjs")],
      });
      const connection = path.join(env.root, "providers/opencode");
      await mkdir(path.join(connection, "data"), { recursive: true });
      const login = {
        id: "cred_synthetic",
        integrationID: "opencode-go",
        label: "Go",
        active: true,
        value: { type: "key", key: "synthetic-key" },
      };
      await writeFile(
        path.join(connection, "data", "synthetic-credentials.json"),
        JSON.stringify([login])
      );
      const provider = createOpenCodeProvider({
        dataDir: env.root,
        command: [process.execPath, fixture("opencode-simulator.mjs")],
        container: env.container,
      });
      const result = await provider.adapter.execute(env.isolated(), control());
      expect(result.stopReason).toBe("completed");
      const data = path.join(connection, "organizations", env.org, "data");
      await expect(
        stat(path.join(data, "synthetic-credentials.json"))
      ).rejects.toThrow();
      // 예전에 이 컴퓨터에서 돌며 옮겨 둔 로그인이 조직 폴더에 남아 있으면 시작하지 않는다.
      await writeFile(
        path.join(data, "synthetic-credentials.json"),
        JSON.stringify([login])
      );
      const refused = await provider.adapter.execute(env.isolated(), control());
      expect(refused.stopReason).toBe("failed");
      expect(refused.error).toContain(leftLogin);
    }, 20000);

    it.each([
      ["Codex", "codex", createCodexProvider, ["auth.json"]],
      [
        "Antigravity",
        "antigravity",
        createAntigravityProvider,
        [".gemini", "antigravity-cli", "antigravity-oauth-token"],
      ],
    ] as const)(
      "does not start %s over a login left as a file in the organization's product folder",
      async (_name, id, create, file) => {
        const env = await setup({});
        const target = path.join(
          env.root,
          "providers",
          id,
          "organizations",
          env.org,
          ...file
        );
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "{}");
        const provider = create({
          dataDir: env.root,
          container: env.container,
        });
        const result = await provider.adapter.execute(
          env.isolated(),
          control()
        );
        expect(result.stopReason).toBe("failed");
        expect(result.error).toContain(leftLogin);
        expect(
          (await env.calls()).some((call) => call.args.includes("run"))
        ).toBe(false);
      }
    );

    // 로그인 자리로 가는 폴더 칸이 폴더가 아니면 그 안을 확인할 수 없다(#280 리뷰 1회차 STD-1). 시작하지 않되, 남은 로그인이 아니라
    // 확인하지 못했다고 알린다(#286).
    it("does not start Antigravity over a file in place of a folder on the way to its login place, saying it could not check", async () => {
      const env = await setup({});
      const organization = path.join(
        env.root,
        "providers",
        "antigravity",
        "organizations",
        env.org
      );
      await mkdir(path.join(organization, ".gemini"), { recursive: true });
      await writeFile(
        path.join(organization, ".gemini", "antigravity-cli"),
        "not a folder"
      );
      const provider = createAntigravityProvider({
        dataDir: env.root,
        container: env.container,
      });
      const result = await provider.adapter.execute(env.isolated(), control());
      expect(result.stopReason).toBe("failed");
      expectUnverified(result.error, "path");
      expect(
        (await env.calls()).some((call) => call.args.includes("run"))
      ).toBe(false);
    });

    it.each([
      [
        "Codex",
        "codex",
        createCodexProvider,
        ["auth.json"],
        "auth.json",
        [process.execPath, "-e", ""],
      ],
      [
        "Antigravity",
        "antigravity",
        createAntigravityProvider,
        [".gemini", "antigravity-cli", "antigravity-oauth-token"],
        "antigravity-oauth-token",
        [process.execPath, fixture("antigravity-simulator.mjs")],
      ],
    ] as const)(
      "keeps a %s login that a run with isolation off set aside out of every folder a later isolated run of the organization mounts (PR #171 SP-1)",
      async (_name, id, create, file, original, program) => {
        // 컨테이너 안의 프로그램은 붙인 자리를 실행 중에 모두 훑어 남은 로그인 내용이 든 파일을 기록한다. 실행 시도의 임시 자리는
        // 실행이 끝나면 지워지므로 끝난 뒤에는 볼 수 없다(`test-fixtures/mount-scan.ts`).
        // 기록 파일은 시험 폴더에 둔다. 폴더 정리는 프로바이더 호출이 돌아온 뒤에만 지운다. 호출의 반환은 그 프로그램의 끝을
        // 확인하지 않는다(`ownCall`). 끝의 확인은 #286 3b-3에서 더한다.
        const scans = path.join(
          await folders.make("babojubot-mount-scan-"),
          "scans.jsonl"
        );
        const scanner = [
          process.execPath,
          fixture("mount-scan.ts"),
          scans,
          "left-in-organization",
        ];
        const env = await setup({ codex: scanner, agy: scanner });
        const connection = path.join(env.root, "providers", id);
        const login = path.join(connection, "login", original);
        await mkdir(path.dirname(login), { recursive: true });
        await writeFile(login, '{"real":1}');
        // 예전 판이나 컨테이너가 조직 제품 폴더의 로그인 자리에 남긴, 로그인 모양의 보통 파일.
        const left = path.join(connection, "organizations", env.org, ...file);
        await mkdir(path.dirname(left), { recursive: true });
        await writeFile(
          left,
          JSON.stringify({ token: { access_token: "left-in-organization" } })
        );
        const provider = create({
          dataDir: env.root,
          container: env.container,
          command: [...program],
        });
        await provider.adapter.execute(
          { ...env.isolated(), execution: "host" },
          control()
        );
        await provider.adapter.execute(env.isolated(), control());
        const sources = valuesOf(runCall(await env.calls()).args, "--mount")
          .map((spec) => /(?:^|,)source=([^,]+)/.exec(spec)?.[1])
          .filter((source): source is string => Boolean(source));
        expect(sources.length).toBeGreaterThan(0);
        // 격리 실행의 붙인 자리는 실행 중에 모두 훑었고, 남은 로그인 내용이 든 파일은 없다.
        expect(
          (
            await orIfMissing(
              () => readFile(scans, "utf8"),
              hasErrorCode("ENOENT"),
              ""
            )
          )
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as unknown)
        ).toEqual([{ sources, holding: [] }]);
        // 치운 로그인은 버리지 않고 이 컴퓨터만 쓰는 연결 폴더에 남긴다.
        const kept = path.join(connection, "set-aside");
        const names = await readdir(kept);
        expect(names).toHaveLength(1);
        expect(await readFile(path.join(kept, names[0]!), "utf8")).toContain(
          "left-in-organization"
        );
      },
      20000
    );

    it.each([
      ["Codex", "codex", createCodexProvider, ["auth.json"], "auth.json"],
      [
        "Antigravity",
        "antigravity",
        createAntigravityProvider,
        [".gemini", "antigravity-cli", "antigravity-oauth-token"],
        "antigravity-oauth-token",
      ],
    ] as const)(
      "starts %s over the link to the connection's login this machine left, but not over a link to anywhere else",
      async (_name, id, create, file, original) => {
        const env = await setup({});
        const target = path.join(
          env.root,
          "providers",
          id,
          "organizations",
          env.org,
          ...file
        );
        await mkdir(path.dirname(target), { recursive: true });
        // 이 컴퓨터에서 돈 실행이 남긴 링크. 연결 폴더는 컨테이너에 없으므로 안에서는 비어 있다.
        await symlink(
          path.join(env.root, "providers", id, "login", original),
          target
        );
        const provider = create({
          dataDir: env.root,
          container: env.container,
        });
        await provider.adapter.execute(env.isolated(), control());
        expect(
          (await env.calls()).some((call) => call.args.includes("run"))
        ).toBe(true);
        // 컨테이너에 들어가는 조직 폴더 안의 다른 파일을 가리키는 링크는 남은 로그인이다.
        await rm(target, { force: true });
        await symlink(path.join(path.dirname(target), "copy"), target);
        const refused = await provider.adapter.execute(
          env.isolated(),
          control()
        );
        expect(refused.stopReason).toBe("failed");
        expect(refused.error).toContain(leftLogin);
      }
    );
  }
);

/** 모의 상류와, 조직 도구 listener처럼 `/api/relay/<연결>` 아래를 중계에 넘기는 서버. 중계는 상류 주소를 받은 뒤 만든다. */
async function relayed(
  connectionId: string,
  connect: (upstream: string) => { handle: http.RequestListener },
  options: { hold?: boolean } = {}
) {
  const seen: http.IncomingHttpHeaders[] = [];
  const urls: string[] = [];
  /** 상류에서 끊긴 요청의 경로. `hold`면 상류는 답하지 않고 요청을 열어 둔다. */
  const closed: string[] = [];
  // 서버마다 연 직후에 닫기를 따로 등록한다. 한 서버를 닫지 못해도 다른 서버를 닫고, 이것을 쓰는 시험은 따로 닫지 않는다.
  const listen = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    onTestFinished(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    });
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  };
  const upstream = await listen((req, res) => {
    seen.push(req.headers);
    urls.push(req.url ?? "");
    req.resume();
    if (options.hold) {
      res.on("close", () => closed.push(req.url ?? ""));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const relay = connect(upstream);
  const tools = await listen((req, res) => {
    const prefix = `/api/relay/${connectionId}`;
    if (!req.url?.startsWith(prefix + "/")) {
      res.writeHead(404).end();
      return;
    }
    req.url = req.url.slice(prefix.length);
    relay.handle(req, res);
  });
  return { tools, seen, urls, closed };
}

describe.skipIf(process.platform === "win32")(
  "an isolated Claude attempt through the credential relay (#148)",
  () => {
    const relayProgram = {
      claude: [process.execPath, fixture("claude-relay.mjs")],
    };

    it("lets the program reach the model only through the relay, which puts the connection's login in place of the run's grant", async () => {
      const env = await setup(relayProgram);
      await mkdir(path.join(env.root, "providers/claude"), { recursive: true });
      await writeFile(
        path.join(env.root, "providers/claude/setup-token"),
        "synthetic-login",
        { mode: 0o600 }
      );
      vi.stubEnv("ANTHROPIC_API_KEY", "api-key-secret");
      vi.stubEnv("BABOJUBOT_CLAUDE_PASS_ENV", "ANTHROPIC_API_KEY");
      let provider!: ReturnType<typeof createClaudeProvider>;
      const network = await relayed("claude", (upstream) => {
        provider = createClaudeProvider({
          dataDir: env.root,
          container: env.container,
          relay: { upstream, verified: true },
        });
        return provider.credentialRelay!;
      });

      const input = env.isolated();
      input.access = { ...input.access, toolsBaseUrl: network.tools };
      const result = await provider.adapter.execute(input, control());
      expect(result.stopReason).toBe("completed");
      expect(network.seen).toHaveLength(1);
      expect(network.seen[0]!.authorization).toBe("Bearer synthetic-login");
      const run = runCall(await env.calls());
      expect(JSON.stringify(run)).not.toMatch(/synthetic-login|api-key-secret/);
      expect(run.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      // 실행 시도가 끝나면 그 권한은 거둬진다.
      const after = await fetch(
        `${network.tools}/api/relay/claude/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${run.env!.CLAUDE_CODE_OAUTH_TOKEN}`,
          },
        }
      );
      expect(after.status).toBe(401);
      expect(network.seen).toHaveLength(1);
    });

    it("ends the run as failed with the reason when the relay cannot read the login, and the program's own retries never reach the model", async () => {
      const env = await setup(relayProgram);
      let provider!: ReturnType<typeof createClaudeProvider>;
      const network = await relayed("claude", (upstream) => {
        provider = createClaudeProvider({
          dataDir: env.root,
          container: env.container,
          relay: { upstream, verified: true },
        });
        return provider.credentialRelay!;
      });

      const input = env.isolated();
      input.access = { ...input.access, toolsBaseUrl: network.tools };
      const result = await provider.adapter.execute(input, control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain("인증 중계");
      expect(network.seen).toHaveLength(0);
      expect(provider.credentialRelay!.failed()).toBe(true);
      // 복구 전에는 새 실행 시도도 시작하지 않는다.
      const again = await provider.adapter.execute(env.isolated(), control());
      expect(again.stopReason).toBe("failed");
      expect(
        (await env.calls()).filter((call) => call.args.includes("run"))
      ).toHaveLength(1);
    });

    it.each([
      [
        "a login left in the organization's product folder",
        async (config: string) => {
          await mkdir(config, { recursive: true });
          await writeFile(path.join(config, ".credentials.json"), "{}");
        },
        undefined,
      ],
      // 로그인 폴더 자리가 폴더가 아니면(일반 파일·FIFO) 그 안을 확인할 수 없다(#280 리뷰 1회차 STD-1). 남은 로그인이 아니라
      // 확인하지 못한 것이다(#286).
      [
        "a file in place of the organization's login folder",
        async (config: string) => {
          await mkdir(path.dirname(config), { recursive: true });
          await writeFile(config, "not a folder");
        },
        "path",
      ],
      [
        "a FIFO in place of the organization's login folder",
        async (config: string) => {
          await mkdir(path.dirname(config), { recursive: true });
          execFileSync("mkfifo", [config], { timeout: 10_000 });
        },
        "path",
      ],
    ] as const)("does not start over %s", async (_case, leave, because) => {
      const env = await setup(relayProgram);
      await leave(
        path.join(env.root, "providers/claude/organizations", env.org, "config")
      );
      const provider = createClaudeProvider({
        dataDir: env.root,
        container: env.container,
        relay: { verified: true },
      });
      const result = await provider.adapter.execute(env.isolated(), control());
      expect(result.stopReason).toBe("failed");
      if (because) expectUnverified(result.error, because);
      else expect(result.error).toContain(leftLogin);
      expect(await env.calls()).toEqual([]);
    });
  }
);

describe.skipIf(process.platform === "win32")(
  "an isolated Codex attempt through the credential relay (#148)",
  () => {
    const relayProgram = {
      codex: [process.execPath, fixture("codex-relay.mjs")],
    };
    /** 연결의 로그인 원본(합성 값). 실제 Codex의 ChatGPT 로그인 파일 형식이다. */
    const realLogin = {
      tokens: {
        id_token: "real-id-token",
        access_token: "real-access-token",
        refresh_token: "real-refresh-token",
        account_id: "real-account",
      },
      last_refresh: new Date().toISOString(),
    };
    async function codexSetup(
      login: string | null = JSON.stringify(realLogin),
      command?: [string, ...string[]],
      timeouts?: CodexOptions["timeouts"],
      program: string[] = relayProgram.codex
    ) {
      const env = await setup({ codex: program });
      const loginFolder = path.join(env.root, "providers/codex/login");
      await mkdir(loginFolder, { recursive: true });
      if (login !== null)
        await writeFile(path.join(loginFolder, "auth.json"), login, {
          mode: 0o600,
        });
      let provider!: ReturnType<typeof createCodexProvider>;
      const network = await relayed("codex", (upstream) => {
        provider = createCodexProvider({
          dataDir: env.root,
          container: env.container,
          relay: { upstream, verified: true },
          // 격리를 끈 실행과 로그인 갱신은 이 컴퓨터의 프로그램으로 돈다.
          command: command ?? [
            process.execPath,
            fixture("replay.mjs"),
            fixture("codex-finish.synthetic.json"),
          ],
          ...(timeouts ? { timeouts } : {}),
        });
        return provider.credentialRelay!;
      });
      const organization = path.join(
        env.root,
        "providers/codex/organizations",
        env.org
      );
      const input = () => {
        const request = env.isolated();
        request.access = { ...request.access, toolsBaseUrl: network.tools };
        return request;
      };
      type Seen = {
        login: { tokens: Record<string, string>; [key: string]: unknown };
        args: string[];
        refreshUrl: string | null;
      };
      /** 프로그램들이 본 로그인·인수·갱신 주소(실행 시도마다 한 줄). */
      const seenAll = async () =>
        (await readFile(path.join(organization, "seen-auth.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Seen);
      const seen = async () => (await seenAll()).at(-1)!;
      return {
        env,
        network,
        provider: () => provider,
        input,
        seen,
        seenAll,
        organization,
        loginFolder,
      };
    }

    it("lets the program reach the model only through the relay, which puts the connection's access token and account in place of the run's grant", async () => {
      const t = await codexSetup();

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("completed");
      expect(t.network.urls).toEqual(["/responses"]);
      expect(t.network.seen[0]!.authorization).toBe("Bearer real-access-token");
      expect(t.network.seen[0]!["chatgpt-account-id"]).toBe("real-account");
      const seen = await t.seen();
      // 컨테이너의 로그인 파일에는 이 실행 시도의 권한만 있다. 갱신 값·계정은 없다.
      const grant = seen.login.tokens.access_token!;
      expect(grant).not.toBe("real-access-token");
      expect(seen.login.tokens.refresh_token ?? "").toBe("");
      expect(seen.login.tokens.account_id).toBeUndefined();
      expect(JSON.stringify(seen)).not.toMatch(
        /real-access-token|real-refresh-token|real-account|real-id-token/
      );
      // 모델 통신과 ChatGPT 보조 요청은 중계 주소로, 갱신은 중계 안의 허용하지 않은 경로로 간다.
      const relayBase = `${t.network.tools}/api/relay/codex`;
      expect(seen.args.join(" ")).toContain(`base_url="${relayBase}"`);
      expect(seen.args.join(" ")).toContain(
        `chatgpt_base_url="${relayBase}/backend-api/"`
      );
      expect(seen.refreshUrl).toBe(`${relayBase}/oauth/token`);
      const run = runCall(await t.env.calls());
      expect(JSON.stringify(run)).not.toMatch(
        /real-access-token|real-refresh-token|real-id-token/
      );
      // 권한이 든 로그인 파일은 이 실행 시도 전용 폴더에 있고, 이 컨테이너에만 조직 폴더의 로그인 자리 위에 읽기로 들어간다.
      // 조직 폴더(그 조직의 모든 컨테이너에 들어간다)에는 권한 값이 없는 자리 표시만 남는다.
      const loginAt = path.join(t.organization, "auth.json");
      const mount = valuesOf(run.args, "--mount").find((spec) =>
        spec.includes(`target=${loginAt},`)
      );
      expect(mount).toMatch(/,readonly$/);
      const source = /source=([^,]+)/.exec(mount!)![1]!;
      expect(source).not.toContain(t.organization);
      await expect(stat(source)).rejects.toThrow();
      expect(await readFile(loginAt, "utf8")).not.toContain(grant);
      // 실행 시도가 끝나면 권한을 거둔다.
      const after = await fetch(`${relayBase}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant}` },
      });
      expect(after.status).toBe(401);
      expect(t.network.urls).toHaveLength(1);
    });

    it.each([
      ["a request goes unanswered", "--never-start-thread"],
      ["the program dies while a request waits", "--die-on-thread"],
    ])(
      "when %s, the run fails and returns only after the grant is refused, its own folder deleted and the container removed",
      async (_case, flag) => {
        const t = await codexSetup(undefined, undefined, { request: 2_000 }, [
          process.execPath,
          fixture("codex-relay.mjs"),
          flag,
        ]);

        const result = await t.provider().adapter.execute(t.input(), control());
        expect(result.stopReason).toBe("failed");
        const calls = await t.env.calls();
        const run = runCall(calls);
        expect(removed(calls, nameOf(run))).toBe(true);
        const mount = valuesOf(run.args, "--mount").find((spec) =>
          spec.includes(`target=${path.join(t.organization, "auth.json")},`)
        );
        await expect(
          stat(/source=([^,]+)/.exec(mount!)![1]!)
        ).rejects.toThrow();
        const grant = (await t.seen()).login.tokens.access_token!;
        const after = await fetch(
          `${t.network.tools}/api/relay/codex/responses`,
          { method: "POST", headers: { authorization: `Bearer ${grant}` } }
        );
        expect(after.status).toBe(401);
        expect(t.network.urls).toHaveLength(0);
      },
      10_000
    );

    it("ends the run as failed with the reason when the relay cannot read the login, and the program's own retries never reach the model", async () => {
      const t = await codexSetup(null);

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain("인증 중계");
      expect(t.network.urls).toHaveLength(0);
      expect(t.provider().credentialRelay!.failed()).toBe(true);
      // 복구 전에는 새 실행 시도도 시작하지 않는다.
      const again = await t.provider().adapter.execute(t.input(), control());
      expect(again.stopReason).toBe("failed");
      expect(
        (await t.env.calls()).filter((call) => call.args.includes("run"))
      ).toHaveLength(1);
    });

    it("replaces the link to the connection's login this machine left without writing through it, and starts again over the placeholder it left", async () => {
      const t = await codexSetup();

      const original = path.join(t.loginFolder, "auth.json");
      const before = await readFile(original, "utf8");
      await mkdir(t.organization, { recursive: true });
      await symlink(original, path.join(t.organization, "auth.json"));
      const first = await t.provider().adapter.execute(t.input(), control());
      expect(first.stopReason).toBe("completed");
      // 원본 로그인은 그대로다.
      expect(await readFile(original, "utf8")).toBe(before);
      // 이 어댑터가 남긴 자리 표시 위에서 다음 실행도 시작한다.
      const second = await t.provider().adapter.execute(t.input(), control());
      expect(second.stopReason).toBe("completed");
      expect(await readFile(original, "utf8")).toBe(before);
      expect(t.network.urls).toHaveLength(2);
    });

    it("gives two runs of one organization at the same time each its own grant", async () => {
      const t = await codexSetup();

      const results = await Promise.all([
        t.provider().adapter.execute(t.input(), control()),
        t.provider().adapter.execute(t.input(), control()),
      ]);
      expect(results.map((result) => result.stopReason)).toEqual([
        "completed",
        "completed",
      ]);
      const grants = (await t.seenAll()).map(
        (record) => record.login.tokens.access_token
      );
      expect(grants).toHaveLength(2);
      expect(new Set(grants).size).toBe(2);
      expect(t.network.urls).toEqual(["/responses", "/responses"]);
    });

    it("a run with isolation off does not take the placeholder as the connection's login", async () => {
      const t = await codexSetup();

      const original = path.join(t.loginFolder, "auth.json");
      const before = await readFile(original, "utf8");
      expect(
        (await t.provider().adapter.execute(t.input(), control())).stopReason
      ).toBe("completed");
      const host = t.input();
      delete host.execution;
      expect(
        (await t.provider().adapter.execute(host, control())).stopReason
      ).toBe("completed");
      expect(await readFile(original, "utf8")).toBe(before);
      expect(
        await readFile(path.join(t.organization, "auth.json"), "utf8")
      ).toBe(before);
    });

    /** Codex의 접근 토큰처럼 만료 시각이 든 JWT 모양 값. */
    const jwt = (claims: Record<string, unknown>) =>
      [{ alg: "none" }, claims]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".") + ".sig";
    const expiringLogin = () =>
      JSON.stringify({
        tokens: {
          ...realLogin.tokens,
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 60 }),
        },
        last_refresh: new Date(Date.now() - 86_400_000).toISOString(),
      });
    async function refreshSetup(
      mode: "ok" | "slow" | "fail" | "fail-once" | "silent" | "exit" | "stall",
      timeouts?: CodexOptions["timeouts"]
    ) {
      const log = path.join(
        await realpath(
          await mkdtemp(path.join(tmpdir(), "babojubot-refresh-"))
        ),
        "refreshes.log"
      );
      folders.adopt(path.dirname(log));
      const t = await codexSetup(
        expiringLogin(),
        [process.execPath, fixture("codex-refresh.mjs"), log, mode],
        timeouts
      );
      // 처음 갱신 전에는 기록이 없다. 없음만 0으로 보고, 그 밖의 읽기 실패는 드러낸다.
      const refreshes = async () =>
        (
          await orIfMissing(
            () => readFile(log, "utf8"),
            hasErrorCode("ENOENT"),
            ""
          )
        )
          .split("\n")
          .filter(Boolean).length;
      return { ...t, refreshes };
    }

    it("refreshes a login about to expire once on this machine, before sending the model request with the new access token", async () => {
      const t = await refreshSetup("ok");

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("completed");
      expect(await t.refreshes()).toBe(1);
      const login = JSON.parse(
        await readFile(path.join(t.loginFolder, "auth.json"), "utf8")
      ) as { tokens: Record<string, string> };
      expect(login.tokens.refresh_token).toBe("rotated-refresh-1");
      expect(t.network.seen[0]!.authorization).toBe(
        `Bearer ${login.tokens.access_token}`
      );
      // 컨테이너는 새 로그인도 보지 못한다.
      expect(JSON.stringify(await t.seen())).not.toContain(
        login.tokens.access_token
      );
    });

    it("refreshes once when two runs need the expiring login at the same time", async () => {
      const t = await refreshSetup("slow");

      const results = await Promise.all([
        t.provider().adapter.execute(t.input(), control()),
        t.provider().adapter.execute(t.input(), control()),
      ]);
      expect(results.map((result) => result.stopReason)).toEqual([
        "completed",
        "completed",
      ]);
      expect(await t.refreshes()).toBe(1);
      expect(t.network.seen).toHaveLength(2);
      expect(t.network.seen[0]!.authorization).toBe(
        t.network.seen[1]!.authorization
      );
    });

    it("fails the run and the connection when the refresh fails, and nothing reaches the model", async () => {
      const t = await refreshSetup("fail");

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain("인증 중계");
      expect(t.provider().credentialRelay!.failed()).toBe(true);
      expect(t.network.urls).toHaveLength(0);
      const again = await t.provider().adapter.execute(t.input(), control());
      expect(again.stopReason).toBe("failed");
      expect(t.network.urls).toHaveLength(0);
    });

    it.each([
      ["goes unanswered", "silent", { refresh: 500 }],
      ["ends with the program", "exit", undefined],
      [
        "takes longer in all than its one limit, though each step is within it",
        "stall",
        { refresh: 1_000 },
      ],
    ] as const)(
      "fails the run, and starts no model turn, when the refresh %s",
      async (_case, mode, timeouts) => {
        const t = await refreshSetup(mode, timeouts);

        const result = await t.provider().adapter.execute(t.input(), control());
        expect(result.stopReason).toBe("failed");
        expect(result.error).toContain("인증 중계");
        expect(await t.refreshes()).toBe(0);
        expect(t.network.urls).toHaveLength(0);
      },
      10_000
    );

    it("refreshes again after a failed refresh once the relay is checked again", async () => {
      const t = await refreshSetup("fail-once");

      const first = await t.provider().adapter.execute(t.input(), control());
      expect(first.stopReason).toBe("failed");
      expect(t.provider().credentialRelay!.failed()).toBe(true);
      // Checking the relay again reads the login, which runs a new refresh instead of reusing the failed one.
      await t.provider().credentialRelay!.recover();
      expect(await t.refreshes()).toBe(1);
      expect(t.provider().credentialRelay!.failed()).toBe(false);
      const again = await t.provider().adapter.execute(t.input(), control());
      expect(again.stopReason).toBe("completed");
      expect(await t.refreshes()).toBe(1);
    });

    it("does not refresh a login that is not about to expire", async () => {
      const t = await refreshSetup("ok");

      await writeFile(
        path.join(t.loginFolder, "auth.json"),
        JSON.stringify({
          ...realLogin,
          tokens: {
            ...realLogin.tokens,
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          },
        })
      );
      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("completed");
      expect(await t.refreshes()).toBe(0);
    });

    it("does not start over a real-looking login left in the organization's product folder", async () => {
      const t = await codexSetup();

      await mkdir(t.organization, { recursive: true });
      await writeFile(
        path.join(t.organization, "auth.json"),
        JSON.stringify({ ...realLogin, tokens: { ...realLogin.tokens } })
      );
      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain(leftLogin);
      expect(await t.env.calls()).toEqual([]);
      expect(t.network.urls).toHaveLength(0);
    });
  }
);

describe.skipIf(process.platform === "win32")(
  "an isolated OpenCode attempt through the credential relay (#148)",
  () => {
    const relayProgram = {
      opencode: [
        process.execPath,
        fixture("opencode-simulator.mjs"),
        "--relay",
      ],
    };
    /** OpenCode 2.2.6의 로그인 저장소(`<XDG_DATA_HOME>/opencode/opencode.db`의 `credential` 표)를 합성한다. */
    async function storeLogins(
      dataHome: string,
      rows: { integration: string; value: unknown }[]
    ) {
      await mkdir(path.join(dataHome, "opencode"), { recursive: true });
      const db = new DatabaseSync(
        path.join(dataHome, "opencode", "opencode.db")
      );
      db.exec(
        "create table credential (id text primary key, integration_id text, label text not null, value text not null, connector_id text, method_id text, active integer, time_created integer, time_updated integer)"
      );
      for (const [n, row] of rows.entries())
        db.prepare(
          "insert into credential (id, integration_id, label, value, active) values (?, ?, ?, ?, 1)"
        ).run(`cred_${n}`, row.integration, "Go", JSON.stringify(row.value));
      db.close();
    }
    async function openCodeSetup(login = true, hold = false) {
      const env = await setup(relayProgram);
      const connection = path.join(env.root, "providers/opencode");
      if (login)
        await storeLogins(path.join(connection, "data"), [
          {
            integration: "opencode-go",
            value: { type: "key", key: "real-go-key" },
          },
        ]);
      let provider!: ReturnType<typeof createOpenCodeProvider>;
      const network = await relayed(
        "opencode",
        (upstream) => {
          provider = createOpenCodeProvider({
            dataDir: env.root,
            command: [process.execPath, fixture("opencode-simulator.mjs")],
            container: env.container,
            relay: { upstream, verified: true },
          });
          return provider.credentialRelay!;
        },
        { hold }
      );
      const input = (model?: string) => {
        const request = env.isolated();
        request.access = { ...request.access, toolsBaseUrl: network.tools };
        if (model) request.model = model;
        return request;
      };
      const organization = path.join(connection, "organizations", env.org);
      return { env, network, provider: () => provider, input, organization };
    }

    it("sends the free model through the relay with the public key only, as today", async () => {
      const t = await openCodeSetup();

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("completed");
      expect(t.network.urls).toEqual(["/openai/v1/responses"]);
      expect(t.network.seen[0]!.authorization).toBe("Bearer public");
      expect(t.network.seen[0]!["x-api-key"]).toBeUndefined();
    }, 20000);

    it.each([
      [
        "an OpenAI-protocol",
        "opencode-go/glm-5.3",
        "/go/openai/v1/chat/completions",
        "authorization",
        "Bearer real-go-key",
      ],
      [
        "an Anthropic-protocol",
        "opencode-go/qwen3.8-flash",
        "/go/anthropic/v1/messages",
        "x-api-key",
        "real-go-key",
      ],
    ])(
      "sends %s Go model through the relay, which puts the connection's Go key in place of the run's grant",
      async (_family, model, upstreamPath, header, value) => {
        const t = await openCodeSetup();

        const result = await t
          .provider()
          .adapter.execute(t.input(model), control());
        expect(result.stopReason).toBe("completed");
        expect(t.network.urls).toEqual([upstreamPath]);
        expect(t.network.seen[0]![header]).toBe(value);
        const run = runCall(await t.env.calls());
        expect(JSON.stringify(run)).not.toContain("real-go-key");
        // 조직의 제품 폴더에는 로그인을 옮기지 않는다.
        await expect(
          stat(path.join(t.organization, "data", "opencode", "opencode.db"))
        ).rejects.toThrow();
      },
      20000
    );

    it.each([
      [
        "a login stored in the organization's database",
        async (data: string) =>
          storeLogins(data, [
            { integration: "opencode-go", value: { type: "key", key: "left" } },
          ]),
        undefined,
      ],
      [
        "a legacy login file",
        async (data: string) => {
          await mkdir(path.join(data, "opencode"), { recursive: true });
          await writeFile(path.join(data, "opencode", "auth.json"), "{}");
        },
        undefined,
      ],
      // 읽을 수 없는 저장소(데이터베이스가 아닌 내용)는 행을 셀 수 없다. 남은 로그인이 아니라 확인하지 못한 것이다(#286).
      [
        "a store that is not a database",
        async (data: string) => {
          await mkdir(path.join(data, "opencode"), { recursive: true });
          await writeFile(
            path.join(data, "opencode", "opencode.db"),
            "not a database"
          );
        },
        "unreadable",
      ],
      // 조직 제품 폴더는 같은 조직의 컨테이너가 쓸 수 있다. 데이터베이스 자리의 FIFO를 경로로 열면 쓰는 쪽이 나타날 때까지
      // 열기가 끝나지 않고, 데이터베이스 도구의 열기는 동기라 서버 전체가 멈춘다. 확인할 수 없으므로 시작하지 않고 그 이유를 알린다.
      [
        "a FIFO in place of the organization's database",
        async (data: string) => {
          await mkdir(path.join(data, "opencode"), { recursive: true });
          execFileSync("mkfifo", [path.join(data, "opencode", "opencode.db")], {
            timeout: 10_000,
          });
        },
        "notRegular",
      ],
      // 로그인 폴더 자리가 폴더가 아니면(FIFO·일반 파일) 그 안을 확인할 수 없다(#280 리뷰 1회차 SPEC-1). 없는 것도 남은 것도 아니다(#286).
      [
        "a FIFO in place of the organization's login folder",
        async (data: string) => {
          await mkdir(data, { recursive: true });
          execFileSync("mkfifo", [path.join(data, "opencode")], {
            timeout: 10_000,
          });
        },
        "path",
      ],
      [
        "a file in place of the organization's login folder",
        async (data: string) => {
          await mkdir(data, { recursive: true });
          await writeFile(path.join(data, "opencode"), "not a folder");
        },
        "path",
      ],
      // 로그인 폴더 자리의 링크를 따라가면 조직 폴더 밖(여기서는 로그인이 없는 데이터베이스)을 보고 통과시킨다.
      [
        "a link in place of the organization's login folder",
        async (data: string) => {
          const elsewhere = `${data}-elsewhere`;
          await storeLogins(elsewhere, []);
          await mkdir(data, { recursive: true });
          await symlink(
            path.join(elsewhere, "opencode"),
            path.join(data, "opencode")
          );
        },
        "path",
      ],
    ] as const)(
      "does not start a container over %s left in the organization's product folder",
      async (_case, leave, because) => {
        const t = await openCodeSetup();

        await leave(path.join(t.organization, "data"));
        const result = await t
          .provider()
          .adapter.execute(t.input("opencode-go/glm-5.3"), control());
        expect(result.stopReason).toBe("failed");
        if (because) expectUnverified(result.error, because);
        else expect(result.error).toContain(leftLogin);
        expect(await t.env.calls()).toEqual([]);
        expect(t.network.urls).toHaveLength(0);
      },
      20000
    );

    // 서버는 조직의 저장소를 경로로 열지 않고 DB와 WAL을 차례로 복사해 사본을 연다. 그 사이 원본의 체크포인트가 WAL에만 있던
    // 로그인 행을 DB로 옮기고 WAL을 비우면, 사본은 옛 DB와 빈 WAL이 되어 정상적으로 열리면서 행을 0개로 센다. 그런 사본은
    // 원본의 어느 한 때와도 같지 않으므로 남은 로그인이 없다고 볼 근거가 되지 못한다(#286 항목 7). 시작하지 않되, 남은 로그인이
    // 아니라 확인 중에 바뀌어 확인하지 못했다고 알린다.
    it("does not start a container when the organization's database moved a login from its log into the database while it was being copied", async () => {
      const t = await openCodeSetup();
      const store = path.join(t.organization, "data", "opencode");
      await mkdir(store, { recursive: true });
      const db = new DatabaseSync(path.join(store, "opencode.db"));
      try {
        db.exec("PRAGMA journal_mode=WAL");
        db.exec("PRAGMA wal_autocheckpoint=0");
        db.exec(
          "create table credential (id text primary key, integration_id text, label text not null, value text not null, active integer)"
        );
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        // 로그인 행은 WAL에만 있다.
        db.prepare(
          "insert into credential (id, integration_id, label, value, active) values (?, ?, ?, ?, 1)"
        ).run("cred_left", "opencode-go", "Go", JSON.stringify({ key: "x" }));
        let checkpointed = false;
        opening.beforeWal = () => {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          checkpointed = true;
        };
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());

        const result = await t
          .provider()
          .adapter.execute(t.input("opencode-go/glm-5.3"), control());
        expect(checkpointed).toBe(true);
        expect(result.stopReason).toBe("failed");
        expectUnverified(result.error, "changed");
        expect(warned).toHaveBeenCalledWith(
          "[provider] the OpenCode login store changed while it was copied; the remaining login could not be checked"
        );
        expect(await t.env.calls()).toEqual([]);
        expect(t.network.urls).toHaveLength(0);
      } finally {
        db.close();
      }
    }, 20000);

    // 저장소를 열 때는 없었는데 바로 뒤에는 있으면 그 사이 자리가 바뀐 것이다. 일반 파일이 아닌 것과 다른 까닭이다(#286 리뷰 1회차 SPEC-2).
    it("does not start a container when the organization's database changed place while it was opened, saying it changed", async () => {
      const t = await openCodeSetup();
      await storeLogins(path.join(t.organization, "data"), []);
      opening.missMain = true;
      const result = await t
        .provider()
        .adapter.execute(t.input("opencode-go/glm-5.3"), control());
      expect(opening.missMain).toBe(false);
      expect(result.stopReason).toBe("failed");
      expectUnverified(result.error, "changed");
      expect(await t.env.calls()).toEqual([]);
    }, 20000);

    // 복사한 handle의 내용이 그대로여도, 그 사이 그 이름에 다른 저장소가 들어왔으면 읽은 것은 지금 그 이름의 저장소가 아니다. 남은 로그인이
    // 없다고 볼 근거가 되지 못하므로 시작하지 않고 확인 중에 바뀌었다고 알린다(#286 병합분 항목 15).
    it("does not start a container when another store with a login took the database's name while it was being copied", async () => {
      const t = await openCodeSetup();
      const data = path.join(t.organization, "data");
      await storeLogins(data, []);
      const replacement = path.join(t.organization, "replacement");
      await storeLogins(replacement, [
        { integration: "opencode-go", value: { type: "key", key: "left" } },
      ]);
      let replaced = false;
      opening.beforeWal = () => {
        renameSync(
          path.join(replacement, "opencode", "opencode.db"),
          path.join(data, "opencode", "opencode.db")
        );
        replaced = true;
      };
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());

      const result = await t
        .provider()
        .adapter.execute(t.input("opencode-go/glm-5.3"), control());
      expect(replaced).toBe(true);
      expect(result.stopReason).toBe("failed");
      expectUnverified(result.error, "changed");
      expect(await t.env.calls()).toEqual([]);
      expect(t.network.urls).toHaveLength(0);
    }, 20000);

    // 같은 모양의 WAL 쪽: 복사를 마친 뒤 WAL 이름이 다른 파일로 바뀌었거나(내용이 같아도), 열 때 없던 WAL이 생겼거나, 있던 WAL이 사라졌으면
    // 읽은 짝이 지금 그 이름의 저장소가 아니다. 확인 중에 바뀐 것으로 막는다(#296 외부 리뷰 1회차 권고, 항목 15).
    it.each([
      [
        "its log was replaced by another file with the same content",
        true,
        (wal: string) => {
          copyFileSync(wal, `${wal}.new`);
          renameSync(`${wal}.new`, wal);
        },
      ],
      [
        "a log appeared after it found none",
        false,
        (wal: string) => writeFileSync(wal, ""),
      ],
      ["its log disappeared", true, (wal: string) => unlinkSync(wal)],
    ] as const)(
      "does not start a container when %s while the organization's database was being copied",
      async (_case, withLog, change) => {
        const t = await openCodeSetup();
        const store = path.join(t.organization, "data", "opencode");
        await mkdir(store, { recursive: true });
        const db = new DatabaseSync(path.join(store, "opencode.db"));
        onTestFinished(() => db.close());
        db.exec(
          withLog
            ? "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0"
            : "PRAGMA journal_mode=DELETE"
        );
        db.exec(
          "create table credential (id text primary key, integration_id text, label text not null, value text not null, active integer)"
        );
        const wal = path.join(store, "opencode.db-wal");
        expect(statSync(wal, { throwIfNoEntry: false }) !== undefined).toBe(
          withLog
        );
        let changed = false;
        opening.beforeNameCheck = () => {
          change(wal);
          changed = true;
        };
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());

        const result = await t
          .provider()
          .adapter.execute(t.input("opencode-go/glm-5.3"), control());
        expect(changed).toBe(true);
        expect(result.stopReason).toBe("failed");
        expectUnverified(result.error, "changed");
        expect(warned).toHaveBeenCalledWith(
          "[provider] the OpenCode login store changed while it was copied; the remaining login could not be checked"
        );
        expect(await t.env.calls()).toEqual([]);
      },
      20000
    );

    it("copies no connection login into the organization's product folder while an isolated run of the organization is still going, even after isolation is turned off (PR #171 SP-2)", async () => {
      const t = await openCodeSetup(true, true);

      // 이 컴퓨터의 실행이 조직 폴더로 옮겨 가는 연결의 로그인(시뮬레이터 저장소).
      await writeFile(
        path.join(
          t.env.root,
          "providers/opencode/data/synthetic-credentials.json"
        ),
        JSON.stringify([
          {
            id: "cred_synthetic",
            integrationID: "opencode-go",
            label: "Go",
            active: true,
            value: { type: "key", key: "synthetic-key" },
          },
        ])
      );
      const cancel = new AbortController();
      const isolated = t
        .provider()
        .adapter.execute(t.input(), control(cancel.signal));
      // 격리 실행의 컨테이너가 조직 제품 폴더를 넣은 채 모델 응답을 기다린다.
      await expect
        .poll(() => t.network.urls.length, { timeout: 10_000 })
        .toBe(1);
      // 그 사이 사용자가 격리를 끄고, 같은 조직의 다음 실행이 이 컴퓨터에서 돈다.
      const base = t.input();
      const host = await t.provider().adapter.execute(
        {
          ...base,
          execution: "host",
          identity: { ...base.identity, runId: crypto.randomUUID() },
        },
        control()
      );
      expect(host.stopReason).toBe("completed");
      await expect(
        stat(path.join(t.organization, "data", "synthetic-credentials.json"))
      ).rejects.toThrow();
      cancel.abort();
      expect((await isolated).stopReason).toBe("cancelled");
    }, 30_000);

    it("starts no container for an isolated run while a run with isolation off is still copying the login into the organization, and refuses once the copy has landed (PR #171 REC-1)", async () => {
      const t = await openCodeSetup();

      await writeFile(
        path.join(
          t.env.root,
          "providers/opencode/data/synthetic-credentials.json"
        ),
        JSON.stringify([
          {
            id: "cred_synthetic",
            integrationID: "opencode-go",
            label: "Go",
            active: true,
            value: { type: "key", key: "synthetic-key" },
          },
        ])
      );
      // 이 컴퓨터의 실행이 조직 폴더에 로그인을 쓰는 순간을 붙잡아 둔다.
      const data = path.join(t.organization, "data");
      await mkdir(data, { recursive: true });
      const hold = path.join(data, "hold-credential");
      await writeFile(hold, "");
      const base = t.input();
      const host = t.provider().adapter.execute(
        {
          ...base,
          execution: "host",
          identity: { ...base.identity, runId: crypto.randomUUID() },
        },
        control()
      );
      await expect
        .poll(
          () =>
            stat(`${hold}.reached`).then(
              () => true,
              () => false
            ),
          {
            timeout: 10_000,
          }
        )
        .toBe(true);
      // 옮기기가 끝나지 않은 동안 같은 조직의 격리 실행이 시작한다. 그 실행은 옮기기를 기다린다고 알린 자리에서 멈춘다.
      let waiting!: (text: string) => void;
      const waitingForCopy = new Promise<string>((resolve) => {
        waiting = resolve;
      });
      const isolated = t.provider().adapter.execute(t.input(), {
        signal: new AbortController().signal,
        emit: async (activity: unknown) => {
          const { type, text } = activity as { type: string; text?: string };
          if (type === "progress" && text) waiting(text);
        },
      });
      expect(await waitingForCopy).toBe(
        "로그인 정보를 옮기는 중이라 끝날 때까지 기다립니다."
      );
      expect(
        (await t.env.calls()).some((call) => call.args.includes("run"))
      ).toBe(false);
      await rm(hold);
      expect((await host).stopReason).toBe("completed");
      const refused = await isolated;
      expect(refused.stopReason).toBe("failed");
      expect(refused.error).toContain(leftLogin);
      expect(t.network.urls).toHaveLength(0);
    }, 30_000);

    it("ends the run as failed with the reason when the relay cannot read the Go login", async () => {
      const t = await openCodeSetup(false);

      const result = await t
        .provider()
        .adapter.execute(t.input("opencode-go/glm-5.3"), control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain("인증 중계");
      expect(t.provider().credentialRelay!.failed()).toBe(true);
      expect(t.network.urls).toHaveLength(0);
    }, 20000);
  }
);

describe.skipIf(process.platform === "win32")(
  "an isolated Antigravity attempt through the credential relay (#148)",
  () => {
    const simulator = [process.execPath, fixture("antigravity-simulator.mjs")];
    /** 연결의 로그인 원본(합성 값). 키링 없는 agy의 로그인 파일 형식이다. */
    const realLogin = (fields: Record<string, unknown> = {}) => ({
      token: {
        access_token: "real-agy-access",
        token_type: "Bearer",
        refresh_token: "real-agy-refresh",
        expiry: new Date(Date.now() + 3_600_000).toISOString(),
      },
      auth_method: "consumer",
      ...fields,
    });
    async function agySetup(login: unknown = realLogin()) {
      const env = await setup({ agy: simulator });
      const loginFolder = path.join(env.root, "providers/antigravity/login");
      await mkdir(loginFolder, { recursive: true });
      const original = path.join(loginFolder, "antigravity-oauth-token");
      if (login !== null)
        await writeFile(original, JSON.stringify(login), { mode: 0o600 });
      let provider!: ReturnType<typeof createAntigravityProvider>;
      const network = await relayed("antigravity", (upstream) => {
        provider = createAntigravityProvider({
          dataDir: env.root,
          container: env.container,
          relay: { upstream, verified: true },
          // 격리를 끈 실행과 로그인 갱신(`agy models`)은 이 컴퓨터의 프로그램으로 돈다.
          command: [process.execPath, fixture("antigravity-simulator.mjs")],
        });
        return provider.credentialRelay!;
      });
      const organization = path.join(
        env.root,
        "providers/antigravity/organizations",
        env.org
      );
      const loginAt = path.join(
        organization,
        ".gemini/antigravity-cli/antigravity-oauth-token"
      );
      const input = () => {
        const request = env.isolated();
        request.access = { ...request.access, toolsBaseUrl: network.tools };
        return request;
      };
      return {
        env,
        network,
        provider: () => provider,
        input,
        original,
        loginAt,
      };
    }

    it("lets the program reach the model only through the relay, which puts the connection's access token in place of the run's grant", async () => {
      const t = await agySetup();

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("completed");
      expect(t.network.urls).toEqual([
        "/v1internal:streamGenerateContent?alt=sse",
      ]);
      expect(t.network.seen[0]!.authorization).toBe("Bearer real-agy-access");
      const run = runCall(await t.env.calls());
      expect(JSON.stringify(run)).not.toMatch(
        /real-agy-access|real-agy-refresh/
      );
      expect(run.env?.CLOUD_CODE_URL).toBe(
        `${t.network.tools}/api/relay/antigravity`
      );
      // 권한이 든 로그인 파일은 이 실행 시도 전용 폴더에 있고 이 컨테이너에만 로그인 자리 위에 읽기로 들어간다.
      const mount = valuesOf(run.args, "--mount").find((spec) =>
        spec.includes(`target=${t.loginAt},`)
      );
      expect(mount).toMatch(/,readonly$/);
      await expect(stat(/source=([^,]+)/.exec(mount!)![1]!)).rejects.toThrow();
      // 조직 폴더에는 권한 없는 자리 표시만 남는다.
      const placeholder = JSON.parse(await readFile(t.loginAt, "utf8")) as {
        token: Record<string, string>;
      };
      expect(placeholder.token.access_token).toBe("");
      expect(placeholder.token.refresh_token).toBeUndefined();
    }, 20000);

    it("ends the run as failed with the reason when the relay cannot read the login", async () => {
      const t = await agySetup(null);

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain("인증 중계");
      expect(t.provider().credentialRelay!.failed()).toBe(true);
      expect(t.network.urls).toHaveLength(0);
    }, 20000);

    it("refreshes a login about to expire with agy on this machine before the relay uses it", async () => {
      const t = await agySetup(
        realLogin({
          expired: true,
          token: {
            access_token: "old-agy-access",
            token_type: "Bearer",
            refresh_token: "real-agy-refresh",
            expiry: new Date(Date.now() - 60_000).toISOString(),
          },
        })
      );

      const result = await t.provider().adapter.execute(t.input(), control());
      expect(result.stopReason).toBe("completed");
      const login = JSON.parse(await readFile(t.original, "utf8")) as {
        token: Record<string, string>;
        refreshed: number;
      };
      expect(login.refreshed).toBe(1);
      expect(login.token.access_token).not.toBe("old-agy-access");
      expect(t.network.seen[0]!.authorization).toBe(
        `Bearer ${login.token.access_token}`
      );
    }, 20000);

    it("a run with isolation off does not take the placeholder as the connection's login", async () => {
      const t = await agySetup();

      const before = await readFile(t.original, "utf8");
      await t.provider().adapter.execute(t.input(), control());
      const host = t.input();
      delete host.execution;
      await t.provider().adapter.execute(host, control());
      expect(await readFile(t.original, "utf8")).toBe(before);
      expect(await readFile(t.loginAt, "utf8")).toBe(before);
    }, 20000);
  }
);

describe.skipIf(process.platform === "win32")(
  "connections behind the credential relay (#148)",
  () => {
    /** 연결마다 원본 로그인(합성)을 두고 중계에 붙인 연결을 만든다. */
    const connections = {
      claude: {
        program: "claude-relay.mjs",
        async login(root: string) {
          await mkdir(path.join(root, "providers/claude"), { recursive: true });
          await writeFile(
            path.join(root, "providers/claude/setup-token"),
            "real-claude-token"
          );
        },
        create: createClaudeProvider,
      },
      codex: {
        program: "codex-relay.mjs",
        async login(root: string) {
          await mkdir(path.join(root, "providers/codex/login"), {
            recursive: true,
          });
          await writeFile(
            path.join(root, "providers/codex/login/auth.json"),
            JSON.stringify({
              tokens: {
                id_token: "real-id",
                access_token: "real-codex-access",
                refresh_token: "real-codex-refresh",
                account_id: "real-account",
              },
              last_refresh: new Date().toISOString(),
            })
          );
        },
        create: createCodexProvider,
      },
      opencode: {
        program: "opencode-simulator.mjs",
        args: ["--relay"],
        async login() {},
        create: createOpenCodeProvider,
      },
      antigravity: {
        program: "antigravity-simulator.mjs",
        async login(root: string) {
          await mkdir(path.join(root, "providers/antigravity/login"), {
            recursive: true,
          });
          await writeFile(
            path.join(
              root,
              "providers/antigravity/login/antigravity-oauth-token"
            ),
            JSON.stringify({
              token: {
                access_token: "real-agy-access",
                refresh_token: "real-agy-refresh",
                expiry: new Date(Date.now() + 3_600_000).toISOString(),
              },
              auth_method: "consumer",
            })
          );
        },
        create: createAntigravityProvider,
      },
    } as const;
    it.each([
      ["Claude", createClaudeProvider],
      ["Codex", createCodexProvider],
      ["OpenCode", createOpenCodeProvider],
      ["Antigravity", createAntigravityProvider],
    ] as const)(
      "%s opens isolated runs by default: its relay was checked with a real subscription (2026-11-12)",
      async (_name, create) => {
        const env = await setup({});
        const provider = create({
          dataDir: env.root,
          container: env.container,
        });
        expect(provider.credentialRelay?.verified).toBe(true);
      }
    );

    const containerProgram = {
      claude: "claude",
      codex: "codex",
      opencode: "opencode",
      antigravity: "agy",
    } as const;

    it.each(Object.keys(connections) as (keyof typeof connections)[])(
      "%s: a cancel refuses the run's grant at once, cuts the model request, and returns only after the container is removed",
      async (id) => {
        const connection = connections[id];
        const env = await setup({
          [containerProgram[id]]: [
            process.execPath,
            fixture(connection.program),
            ...("args" in connection ? connection.args : []),
          ],
        });
        await connection.login(env.root);
        let provider!: ReturnType<typeof connection.create>;
        /** 발급한 실행 시도 권한. 발급을 바꾸지 않고 기록만 하는 관찰 spy가 본다. */
        let granted!: MockInstance<CredentialRelay["grant"]>;
        const grants = () =>
          granted.mock.results.map(({ value }) => value.token);
        const network = await relayed(
          id,
          (upstream) => {
            provider = connection.create({
              dataDir: env.root,
              container: env.container,
              relay: { upstream, verified: true },
              command: [process.execPath, fixture(connection.program)],
            });
            const relay = provider.credentialRelay as CredentialRelay;
            const spy = vi.spyOn(relay, "grant");
            onTestFinished(() => spy.mockRestore());
            granted = spy;
            return relay;
          },
          { hold: true }
        );

        const input = env.isolated();
        input.access = { ...input.access, toolsBaseUrl: network.tools };
        const cancel = new AbortController();
        const running = provider.adapter.execute(input, control(cancel.signal));
        await expect
          .poll(() => network.urls.length, { timeout: 10_000 })
          .toBe(1);
        cancel.abort();
        // 중단이 효력을 갖는 순간부터 그 권한의 새 요청은 상류에 닿지 않는다.
        const after = await fetch(`${network.tools}/api/relay/${id}/any`, {
          method: "POST",
          headers: { authorization: `Bearer ${grants()[0]}` },
        });
        expect(after.status).toBe(401);
        await expect.poll(() => network.closed.length, programStart).toBe(1);
        const result = await running;
        expect(result.stopReason).toBe("cancelled");
        expect(network.urls).toHaveLength(1);
        // 실행 시도는 컨테이너를 지운 뒤에야 끝난다(그 전에 같은 자리를 다시 쓰지 않는다).
        const calls = await env.calls();
        expect(removed(calls, nameOf(runCall(calls)))).toBe(true);
        expect(grants()).toHaveLength(1);
      },
      30_000
    );

    it.each([
      ["Claude", "claude", "claude-relay.mjs", createClaudeProvider],
      ["Codex", "codex", "codex-relay.mjs", createCodexProvider],
      [
        "OpenCode",
        "opencode",
        "opencode-simulator.mjs",
        createOpenCodeProvider,
      ],
      [
        "Antigravity",
        "agy",
        "antigravity-simulator.mjs",
        createAntigravityProvider,
      ],
    ] as const)(
      "give an isolated %s run no direct way to the provider's model service: its model traffic leaves only through the credential relay",
      async (_name, id, program, create) => {
        const env = await setup({
          [id]: [process.execPath, fixture(program)],
        });
        const hub = env.container.relay;
        const opened: string[][] = [];
        const stop = new AbortController();
        const open = hub.open.bind(hub);
        hub.open = (input) => {
          opened.push(input.required.map(({ host }) => host));
          // 열린 목적지만 본다. 프로그램은 닿지 않는 중계를 계속 다시 시도해 스스로 끝나지 않으므로, 중계를 연 뒤 실행을 멈춘다.
          const relay = open(input);
          stop.abort();
          return relay;
        };
        const provider = create({
          dataDir: env.root,
          container: env.container,
          relay: { verified: true },
        });
        await provider.adapter.execute(env.isolated(), control(stop.signal));
        expect(opened).toHaveLength(1);
        // OpenCode만 공개 모델 목록(로그인 없이 받는 catalog) 주소를 연다. 모델 통신 주소는 열지 않는다.
        expect(opened[0]).toEqual(
          id === "opencode" ? ["models.opencode.ai"] : []
        );
      }
    );
  }
);

// #209: 링크를 만들 수 없는 컴퓨터에서는 연결의 로그인이 연결 폴더 자리에 있다. 중계는 이 컴퓨터의 실행이 읽는 그 로그인을 읽는다.
describe.skipIf(process.platform === "win32")(
  "an isolated attempt on a machine that cannot create links (#209)",
  () => {
    const codexLogin = (access: string, refresh = "real-codex-refresh") =>
      JSON.stringify({
        tokens: {
          id_token: "real-id",
          access_token: access,
          refresh_token: refresh,
          account_id: "real-account",
        },
        last_refresh: new Date().toISOString(),
      });
    const agyLogin = (access: string, fields: Record<string, unknown> = {}) =>
      JSON.stringify({
        token: {
          access_token: access,
          token_type: "Bearer",
          refresh_token: "real-agy-refresh",
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
        auth_method: "consumer",
        ...fields,
      });
    const codexRelay = [process.execPath, fixture("codex-relay.mjs")];
    const agy = [process.execPath, fixture("antigravity-simulator.mjs")];
    const connections: {
      name: string;
      id: string;
      programs: Record<string, string[]>;
      place: string[];
      login: (access: string) => string;
      create: (
        options: Parameters<typeof createCodexProvider>[0]
      ) => ProviderConnection;
    }[] = [
      {
        name: "Codex (app-server)",
        id: "codex",
        programs: { codex: codexRelay },
        place: ["auth.json"],
        login: (access: string) => codexLogin(access),
        create: (options: Parameters<typeof createCodexProvider>[0]) =>
          createCodexProvider({
            ...options,
            command: [
              process.execPath,
              fixture("replay.mjs"),
              fixture("codex-finish.synthetic.json"),
            ],
          }),
      },
      {
        name: "Codex (exec)",
        id: "codex",
        programs: { codex: codexRelay },
        place: ["auth.json"],
        login: (access: string) => codexLogin(access),
        create: (options: Parameters<typeof createCodexProvider>[0]) =>
          createCodexProvider({
            ...options,
            mode: "exec",
            command: [
              process.execPath,
              fixture("replay.mjs"),
              fixture("codex-exec.synthetic.json"),
            ],
          }),
      },
      {
        name: "Antigravity",
        id: "antigravity",
        programs: { agy },
        place: [".gemini", "antigravity-cli", "antigravity-oauth-token"],
        login: (access: string) => agyLogin(access),
        create: (options: Parameters<typeof createAntigravityProvider>[0]) =>
          createAntigravityProvider({
            ...options,
            command: agy as [string, ...string[]],
          }),
      },
    ];

    const byName = (name: string) =>
      connections.find((connection) => connection.name === name)!;
    async function noLinkSetup(
      connection: (typeof connections)[number],
      login: string | null,
      options: {
        create?: (
          options: Parameters<typeof createCodexProvider>[0]
        ) => ProviderConnection;
        /** 데이터 폴더를 만들 곳. 기본은 임시 폴더다. */
        base?: string;
      } = {}
    ) {
      const create = options.create ?? connection.create;
      const env = await setup(connection.programs, options.base);
      const folder = path.join(env.root, "providers", connection.id);
      const original = path.join(folder, "login", connection.place.at(-1)!);
      /** 연결 폴더의 로그인 자리. 링크를 만들 수 없으면 이 컴퓨터의 실행·로그인 명령·갱신이 여기의 로그인을 읽고 쓴다. */
      const connectionPlace = path.join(folder, ...connection.place);
      if (login !== null) {
        await mkdir(path.dirname(original), { recursive: true });
        await writeFile(original, login, { mode: 0o600 });
      }
      let provider!: ProviderConnection;
      const network = await relayed(connection.id, (upstream) => {
        provider = create({
          dataDir: env.root,
          container: env.container,
          relay: { upstream, verified: true },
        });
        return provider.credentialRelay!;
      });
      const isolated = () => {
        const request = env.isolated();
        request.access = { ...request.access, toolsBaseUrl: network.tools };
        return request;
      };
      const onHost = () => {
        const request = isolated();
        delete request.execution;
        return request;
      };
      /** 연결 폴더 자리에 다시 로그인한다(로그인 명령은 연결 폴더에서 돈다: 링크면 따라가 원본에, 아니면 그 자리에 쓴다). */
      const logIn = async (contents: string) => {
        await mkdir(path.dirname(connectionPlace), { recursive: true });
        await writeFile(connectionPlace, contents, { mode: 0o600 });
      };
      /** 연결 폴더 안에서 그 값을 담은 보통 파일. */
      const holding = async (secret: string) => {
        const found: string[] = [];
        // 연결 폴더가 아직 없으면 담은 파일이 없다. 그 밖의 조회 실패(권한·디스크)는 접지 않고 드러낸다.
        const look = async (at: string): Promise<void> => {
          const info = await orIfMissing(
            () => lstat(at),
            hasErrorCode("ENOENT"),
            undefined
          );
          if (info?.isDirectory())
            for (const name of await readdir(at))
              await look(path.join(at, name));
          else if (
            info?.isFile() &&
            (await readFile(at, "utf8")).includes(secret)
          )
            found.push(at);
        };
        await look(folder);
        return found;
      };
      const runs = async () =>
        (await env.calls()).filter((call) => call.args.includes("run"));
      const authorizations = () =>
        network.seen.map((headers) => headers.authorization);
      return {
        env,
        network,
        provider: () => provider,
        folder,
        original,
        connectionPlace,
        isolated,
        onHost,
        logIn,
        holding,
        runs,
        authorizations,
      };
    }

    describe.each(["EPERM", "ENOTSUP", "EOPNOTSUPP"])(
      "that refuses links with %s",
      (code) => {
        it.each(connections)(
          "completes an isolated $name run with the connection's login, and puts no connection folder, login folder or login in any mount",
          async (connection) => {
            const t = await noLinkSetup(
              connection,
              connection.login("real-access")
            );
            refusal = code;

            const result = await t
              .provider()
              .adapter.execute(t.isolated(), control());
            expect(result.stopReason).toBe("completed");
            expect(t.authorizations()).toEqual(["Bearer real-access"]);
            expect(t.provider().credentialRelay!.failed()).toBe(false);
            const [run] = await t.runs();
            const sources = valuesOf(run!.args, "--mount").map(
              (mount) => /source=([^,]+)/.exec(mount)![1]!
            );
            const organization = path.join(
              t.folder,
              "organizations",
              t.env.org
            );
            expect(
              sources.filter(
                (source) => !path.relative(t.folder, source).startsWith("..")
              )
            ).toEqual([organization]);
            expect(JSON.stringify(run)).not.toContain("real-access");
            // 로그인은 연결 폴더 자리 하나에만 있다. 조직 폴더에도 없다.
            expect(await t.holding("real-access")).toEqual([t.connectionPlace]);
          },
          20_000
        );
      }
    );

    it.each(connections)(
      "sends the next isolated $name run with a login made again at the connection folder's place",
      async (connection) => {
        const t = await noLinkSetup(
          connection,
          connection.login("first-access")
        );
        refusal = "EPERM";

        const first = await t
          .provider()
          .adapter.execute(t.isolated(), control());
        expect(first.stopReason).toBe("completed");
        await t.logIn(connection.login("second-access"));
        const second = await t
          .provider()
          .adapter.execute(t.isolated(), control());
        expect(second.stopReason).toBe("completed");
        expect(t.authorizations()).toEqual([
          "Bearer first-access",
          "Bearer second-access",
        ]);
        expect(await t.holding("first-access")).toEqual([]);
        expect(await t.holding("second-access")).toEqual([t.connectionPlace]);
      },
      20_000
    );

    // 링크를 풀어 복사한 데이터 폴더나 링크 대신 보통 파일을 쓰는 프로그램 판이면 로그인 전용 폴더와 연결 폴더 자리에 로그인 파일이
    // 하나씩 남는다. 링크를 만들 수 없는 컴퓨터의 실행·로그인 명령·갱신은 연결 폴더 자리의 것을 읽고 쓰므로 그것이 연결의 로그인이다.
    // 로그인 전용 폴더의 것은 지우지 않고 연결 폴더 `set-aside/`로 치운다(2026-11-17 사용자 결정).
    it.each(connections)(
      "sends an isolated $name run with the login at the connection folder's place when the login folder also holds one, and sets the login folder's aside",
      async (connection) => {
        const t = await noLinkSetup(
          connection,
          connection.login("copied-access")
        );
        await t.logIn(connection.login("newer-access"));
        refusal = "EPERM";

        const result = await t
          .provider()
          .adapter.execute(t.isolated(), control());
        expect(result.stopReason).toBe("completed");
        expect(t.authorizations()).toEqual(["Bearer newer-access"]);
        expect(await t.holding("newer-access")).toEqual([t.connectionPlace]);
        const aside = await t.holding("copied-access");
        expect(aside.map((file) => path.dirname(file))).toEqual([
          path.join(t.folder, "set-aside"),
        ]);
        await expect(lstat(t.original)).rejects.toThrow();
      },
      20_000
    );

    it.each(connections)(
      "ends an isolated $name run as a relay failure, with nothing reaching the model, when there is no login anywhere",
      async (connection) => {
        const t = await noLinkSetup(connection, null);
        refusal = "EPERM";

        const result = await t
          .provider()
          .adapter.execute(t.isolated(), control());
        expect(result.stopReason).toBe("failed");
        expect(result.error).toContain("인증 중계");
        expect(t.provider().credentialRelay!.failed()).toBe(true);
        expect(t.network.urls).toEqual([]);
      },
      20_000
    );

    it.each(connections)(
      "completes the next isolated $name run after a relay failure once the login is made again at the connection folder's place and the relay is checked again",
      async (connection) => {
        const t = await noLinkSetup(connection, null);
        refusal = "EPERM";

        const first = await t
          .provider()
          .adapter.execute(t.isolated(), control());
        expect(first.stopReason).toBe("failed");
        expect(t.provider().credentialRelay!.failed()).toBe(true);
        await t.logIn(connection.login("fixed-access"));
        await t.provider().credentialRelay!.recover();
        expect(t.provider().credentialRelay!.failed()).toBe(false);
        const next = await t
          .provider()
          .adapter.execute(t.isolated(), control());
        expect(next.stopReason).toBe("completed");
        expect(t.authorizations()).toEqual(["Bearer fixed-access"]);
      },
      20_000
    );

    it("refreshes an expiring Codex login once on this machine at the connection folder's place, and the model gets the refreshed login", async () => {
      const log = path.join(
        await realpath(
          await mkdtemp(path.join(tmpdir(), "babojubot-refresh-"))
        ),
        "refreshes.log"
      );
      folders.adopt(path.dirname(log));
      const expiring = (() => {
        const jwt =
          [{ alg: "none" }, { exp: Math.floor(Date.now() / 1000) + 60 }]
            .map((part) =>
              Buffer.from(JSON.stringify(part)).toString("base64url")
            )
            .join(".") + ".sig";
        return codexLogin(jwt, "first-refresh");
      })();
      const t = await noLinkSetup(byName("Codex (app-server)"), expiring, {
        create: (options) =>
          createCodexProvider({
            ...options,
            command: [
              process.execPath,
              fixture("codex-refresh.mjs"),
              log,
              "ok",
            ],
          }),
      });
      refusal = "EPERM";

      const result = await t
        .provider()
        .adapter.execute(t.isolated(), control());
      expect(result.stopReason).toBe("completed");
      expect(
        (await readFile(log, "utf8")).split("\n").filter(Boolean)
      ).toHaveLength(1);
      const login = JSON.parse(await readFile(t.connectionPlace, "utf8")) as {
        tokens: Record<string, string>;
      };
      expect(login.tokens.refresh_token).toBe("rotated-refresh-1");
      expect(t.authorizations()).toEqual([
        `Bearer ${login.tokens.access_token}`,
      ]);
      await expect(stat(t.original)).rejects.toThrow();
    }, 20_000);

    it("refreshes an expiring Antigravity login with agy on this machine at the connection folder's place, and the model gets the refreshed login", async () => {
      const t = await noLinkSetup(
        byName("Antigravity"),
        agyLogin("old-agy-access", {
          expired: true,
          token: {
            access_token: "old-agy-access",
            token_type: "Bearer",
            refresh_token: "real-agy-refresh",
            expiry: new Date(Date.now() - 60_000).toISOString(),
          },
        })
      );
      refusal = "EPERM";

      const result = await t
        .provider()
        .adapter.execute(t.isolated(), control());
      expect(result.stopReason).toBe("completed");
      const login = JSON.parse(await readFile(t.connectionPlace, "utf8")) as {
        token: Record<string, string>;
        refreshed: number;
      };
      expect(login.refreshed).toBe(1);
      expect(t.authorizations()).toEqual([
        `Bearer ${login.token.access_token}`,
      ]);
      await expect(stat(t.original)).rejects.toThrow();
    }, 20_000);

    it.each(connections)(
      "keeps one $name login while links become impossible and possible again among isolated runs and runs with isolation off, and the model gets the last login",
      async (connection) => {
        const t = await noLinkSetup(connection, connection.login("login-1"));
        const run = async (request: RunRequest) =>
          (await t.provider().adapter.execute(request, control())).stopReason;

        expect(await run(t.isolated())).toBe("completed");
        expect(await run(t.onHost())).toBe("completed");
        // 링크를 모르는 디스크로 데이터 폴더를 옮기면 링크는 따라오지 않는다.
        refusal = "EPERM";
        await rm(t.connectionPlace, { force: true });
        expect(await run(t.onHost())).toBe("completed");
        expect(await run(t.isolated())).toBe("completed");
        await t.logIn(connection.login("login-2"));
        expect(await run(t.isolated())).toBe("completed");
        expect(await run(t.onHost())).toBe("completed");
        refusal = null;
        expect(await run(t.onHost())).toBe("completed");
        expect(await run(t.isolated())).toBe("completed");
        await t.logIn(connection.login("login-3"));
        expect(await run(t.isolated())).toBe("completed");
        expect(t.authorizations()).toEqual([
          "Bearer login-1",
          "Bearer login-1",
          "Bearer login-2",
          "Bearer login-2",
          "Bearer login-3",
        ]);
        // 원본은 하나다: 로그인 전용 폴더의 원본만 로그인을 담고, 연결 폴더 자리는 그것을 가리킨다.
        expect(await t.holding("login-")).toEqual([t.original]);
        expect((await lstat(t.connectionPlace)).isSymbolicLink()).toBe(true);
        expect(t.provider().credentialRelay!.failed()).toBe(false);
      },
      30_000
    );

    /**
     * 링크를 모르는 실제 디스크(CI는 vfat 이미지를 loop로 붙인다)의 폴더. 링크 거절을 흉내 내지 않고 대표 장면을 돈다.
     * 붙일 수 없는 환경(로컬 기본값, macOS, Windows)에서는 비어 있어 건너뛴다.
     */
    // Linux CI는 링크를 모르는 실제 디스크(vfat)를 붙여 그 폴더를 BABOJUBOT_TEST_NO_LINK_DIR로 주고,
    // BABOJUBOT_REQUIRE_NO_LINK_DIR=1로 이 검사를 필수로 정한다. 그때 폴더가 없으면 건너뛰지 않고 실패한다.
    const volume = probeEnvironment({
      variable: "BABOJUBOT_REQUIRE_NO_LINK_DIR",
      what: "링크를 모르는 실제 디스크",
      probe: () => {
        const folder = process.env.BABOJUBOT_TEST_NO_LINK_DIR ?? "";
        if (folder === "")
          return { missing: "BABOJUBOT_TEST_NO_LINK_DIR가 비어 있다" };
        return statSync(folder, { throwIfNoEntry: false })?.isDirectory()
          ? { value: folder }
          : { missing: `${folder}가 폴더가 아니다` };
      },
    });
    describe.skipIf(!volume)("on a real disk that refuses links", () => {
      it("refuses a file link in that folder", async () => {
        const probe = await mkdtemp(path.join(volume!, "babojubot-probe-"));
        folders.adopt(probe);
        await writeFile(path.join(probe, "target"), "");
        const code = await symlink(
          path.join(probe, "target"),
          path.join(probe, "link"),
          "file"
        ).then(
          () => "linked",
          (error: NodeJS.ErrnoException) => error.code
        );
        expect(["EPERM", "ENOTSUP", "EOPNOTSUPP"]).toContain(code);
      });

      it.each(connections)(
        "completes isolated $name runs with the connection's login, and the next one with a login made again",
        async (connection) => {
          const t = await noLinkSetup(connection, connection.login("disk-1"), {
            base: volume!,
          });

          const run = async () =>
            (await t.provider().adapter.execute(t.isolated(), control()))
              .stopReason;
          expect(await run()).toBe("completed");
          await t.logIn(connection.login("disk-2"));
          expect(await run()).toBe("completed");
          expect(t.authorizations()).toEqual([
            "Bearer disk-1",
            "Bearer disk-2",
          ]);
          expect(await t.holding("disk-2")).toEqual([t.connectionPlace]);
          for (const call of await t.runs())
            expect(JSON.stringify(call)).not.toMatch(/disk-1|disk-2/);
        },
        30_000
      );
    });
  }
);

// docker가 실패하면 그 종료 코드와 오류 출력을 남긴다. 목록을 읽지 못한 것을 "남은 컨테이너 없음"으로 바꾸지 않는다.
describe("docker failures during container cleanup", () => {
  const failing = {
    docker: [
      process.execPath,
      "-e",
      `process.stderr.write("Cannot connect to the Docker daemon", () => process.exit(1));`,
    ] as const,
    image,
    owner: "owner-test",
    relay: attachedRelayHub(),
  };

  it("fails leftover cleanup with the cause when the containers cannot be listed", async () => {
    await expect(
      createDockerEnvironment(failing).removeOrphans()
    ).rejects.toThrow(
      /could not be listed \(exit 1: Cannot connect to the Docker daemon\)/
    );
  });

  // 시한·출력 상한에 닿아 끈 것은 원인이다. "끝남 코드 없음"으로 접지 않는다(#264 외부 리뷰 4회차 STD-3).
  it("keeps why a docker command was stopped when it stays silent past its limit", async () => {
    const silent = {
      ...failing,
      docker: [process.execPath, "-e", "setInterval(() => {}, 1000);"] as const,
    };
    const result = await runDocker(silent, ["ps"], 200);
    expect(result).toMatchObject({ code: null, stopped: "limit", stderr: "" });
    // 끈 트리를 끝낸 신호도 남는다. 이 프로그램은 SIGTERM을 다루지 않아 끄기 순서의 첫 SIGTERM으로 끝난다
    // (packages/process/supervisor/src/unix.rs `end_tree`). Windows는 신호 없이 끝난다(#286 리뷰 1회차 STD-2).
    expect(result.signal).toBe(
      process.platform === "win32" ? undefined : "SIGTERM"
    );
  });

  // 바깥에서 받은 종료 신호로 끝난 docker 명령도 그 신호가 원인이다. "끝남 코드 없음"으로 접지 않는다(#286 항목 2).
  // Windows에는 프로세스를 끝내는 신호가 없어(끝남 코드로만 끝난다) 이 갈래가 생기지 않는다.
  it.skipIf(process.platform === "win32")(
    "keeps the signal that ended a docker command, and fails leftover cleanup with it",
    async () => {
      const signalled = {
        ...failing,
        docker: [
          process.execPath,
          "-e",
          `process.kill(process.pid, "SIGTERM");`,
        ] as const,
      };
      await expect(runDocker(signalled, ["ps"])).resolves.toMatchObject({
        code: null,
        signal: "SIGTERM",
      });
      await expect(
        createDockerEnvironment(signalled).removeOrphans()
      ).rejects.toThrow(
        "leftover containers could not be listed (signal SIGTERM)"
      );
    }
  );

  it("keeps both why a docker command was stopped and the signal that ended it", async () => {
    tree.run = stoppedBySignal;
    await expect(runDocker(failing, ["ps"])).resolves.toMatchObject({
      code: null,
      stopped: "limit",
      signal: "SIGKILL",
    });
    await expect(
      createDockerEnvironment(failing).removeOrphans()
    ).rejects.toThrow(
      "leftover containers could not be listed (stopped: limit, signal SIGKILL)"
    );
  });

  it("fails leftover cleanup with the output limit as the cause when docker prints too much", async () => {
    const flooding = {
      ...failing,
      docker: [
        process.execPath,
        "-e",
        `process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`,
      ] as const,
    };
    // 끈 트리를 끝낸 신호도 남는다(#286 리뷰 1회차 STD-2). 끄기 순서는 SIGTERM → 유예 → SIGKILL이고
    // (packages/process/supervisor/src/unix.rs `end_tree`), 이 프로그램은 SIGTERM을 다루지 않아 SIGTERM이 닿는 순간 끝난다.
    // Windows는 신호 없이 끝난다. 예전 기대는 신호를 버린 문구를 고정했다.
    await expect(
      createDockerEnvironment(flooding).removeOrphans()
    ).rejects.toThrow(
      process.platform === "win32"
        ? "leftover containers could not be listed (stopped: output)"
        : "leftover containers could not be listed (stopped: output, signal SIGTERM)"
    );
  });

  it("leaves why a container could not be removed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    expect(await removeContainer(failing, "babojubot-test")).toBe(false);
    expect(warned).toHaveBeenCalledWith(
      expect.stringMatching(
        /babojubot-test.*exit 1.*Cannot connect to the Docker daemon/
      )
    );
  });
});

// Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행). 확인이 여는 중계의 파일 소켓은 Linux·macOS에서 본다.
describe.skipIf(process.platform === "win32")("the isolation probe", () => {
  // 확인하지 못한 검사는 "막혔다"가 아니다. 결과를 모를 때 안전한 쪽은 확인 불가다(#264 외부 리뷰 4회차 SPEC-3).
  it("reports the checks it could not complete as unverified and names each failure from the original error's code and name", async () => {
    const root = await folders.make("babojubot-probe-");
    // 컨테이너 안 확인 스크립트 대신 정해진 결과를 내는 프로그램. 확인 스크립트는 원래 오류의 code·name(답이 없으면 기다린 시간)만 보낸다.
    const answer = path.join(root, "answer.mjs");
    await writeFile(
      answer,
      `console.log(${JSON.stringify(
        JSON.stringify({
          interfaces: [],
          reached: [],
          proxied: [],
          toolsReached: false,
          failures: [
            { probe: "tools", code: "ECONNREFUSED", name: "Error" },
            { probe: "proxied", name: "TypeError" },
            { probe: "proxied", timeoutMs: 5000 },
            { probe: "direct", code: 7, name: "RangeError" },
          ],
          proxyEnv: true,
        })
      )});\n`
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const environment = createDockerEnvironment({
      docker: [
        process.execPath,
        fixture("fake-docker.mjs"),
        root,
        JSON.stringify({ node: [process.execPath, answer] }),
      ],
      image,
      owner: "owner-test",
      relay: attachedRelayHub(),
    });
    await expect(
      environment.probe(
        { blocked: [], forbidden: [] },
        AbortSignal.timeout(10_000)
      )
    ).resolves.toEqual({
      interfaces: [],
      reached: [],
      proxied: [],
      toolsReached: false,
      unverified: ["tools", "proxied", "direct"],
    });
    expect(warned.mock.calls.map(([line]) => line)).toEqual([
      "[provider] the isolation probe's tools check failed (ECONNREFUSED)",
      "[provider] the isolation probe's proxied check failed (TypeError)",
      "[provider] the isolation probe's proxied check failed (no answer within 5000 ms)",
      "[provider] the isolation probe's direct check failed (RangeError)",
    ]);
  });

  /** 모든 검사를 끝까지 한 확인 결과를 내는 가짜 docker와 그 기록 폴더. `files`는 가짜 docker의 상태 파일이다(`rm-fails` 등). */
  async function cleanProbe(files: Record<string, string> = {}) {
    const root = await folders.make("babojubot-probe-");
    for (const [name, value] of Object.entries(files))
      await writeFile(path.join(root, name), value);
    const answer = path.join(root, "answer.mjs");
    await writeFile(
      answer,
      `console.log(${JSON.stringify(
        JSON.stringify({
          interfaces: [],
          reached: [],
          proxied: [],
          toolsReached: true,
          failures: [],
          proxyEnv: true,
        })
      )});\n`
    );
    const environment = createDockerEnvironment({
      docker: [
        process.execPath,
        fixture("fake-docker.mjs"),
        root,
        JSON.stringify({ node: [process.execPath, answer] }),
      ],
      image,
      owner: "owner-test",
      relay: attachedRelayHub(),
    });
    const removals = async () =>
      (await readFile(path.join(root, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Call)
        .filter((call) => call.args[0] === "rm");
    return { environment, removals };
  }

  // 중계 닫기와 확인 컨테이너 지우기는 서로 독립인 정리다. 한쪽이 실패해도 다른 쪽을 하고, 실패는 확인의 실패로 드러난다
  // (#264 외부 리뷰 5회차 STD-4). 확인이 실패하면 관문은 격리 환경 없음으로 본다.
  it("still removes its container when the relay does not close, and fails the check", async () => {
    const { environment, removals } = await cleanProbe();
    const close = net.Server.prototype.close;
    const failing = vi
      .spyOn(net.Server.prototype, "close")
      .mockImplementation(function (
        this: net.Server,
        callback?: (error?: Error) => void
      ) {
        return close.call(this, (error?: Error) =>
          callback?.(
            error ?? Object.assign(new Error("close failed"), { code: "EBUSY" })
          )
        );
      });
    onTestFinished(() => failing.mockRestore());
    await expect(
      environment.probe(
        { blocked: [], forbidden: [] },
        AbortSignal.timeout(10_000)
      )
    ).rejects.toThrow("a relay server did not close (EBUSY)");
    expect(await removals()).toEqual([
      {
        args: ["rm", "-f", expect.stringMatching(/^babojubot-probe-/)],
        relayOpen: false,
      },
    ]);
  });

  it("fails the check when its container cannot be removed, after closing the relay", async () => {
    const { environment, removals } = await cleanProbe({ "rm-fails": "" });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    await expect(
      environment.probe(
        { blocked: [], forbidden: [] },
        AbortSignal.timeout(10_000)
      )
    ).rejects.toThrow(
      /the isolation probe container babojubot-probe-\S+ could not be removed/
    );
    // 지우기 전에 중계를 닫았다(가짜 docker가 rm 때 중계 소켓이 남았는지 기록한다). 지우기는 세 번 시도한다.
    expect(await removals()).toEqual(
      Array.from({ length: 3 }, () => ({
        args: ["rm", "-f", expect.stringMatching(/^babojubot-probe-/)],
        relayOpen: false,
      }))
    );
  });

  // 확인 컨테이너가 실패하고 정리도 실패하면 두 실패를 함께 알린다. 정리 실패만 남기면 확인 컨테이너의 끝남 코드와 오류
  // 출력이 사라진다(#286 항목 3).
  it("keeps the probe container's own failure when removing the container fails too", async () => {
    const root = await folders.make("babojubot-probe-");
    await writeFile(path.join(root, "rm-fails"), "");
    const broken = path.join(root, "broken.mjs");
    await writeFile(
      broken,
      `process.stderr.write("probe broke", () => process.exit(3));\n`
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    const environment = createDockerEnvironment({
      docker: [
        process.execPath,
        fixture("fake-docker.mjs"),
        root,
        JSON.stringify({ node: [process.execPath, broken] }),
      ],
      image,
      owner: "owner-test",
      relay: attachedRelayHub(),
    });
    const failure = await environment
      .probe({ blocked: [], forbidden: [] }, AbortSignal.timeout(10_000))
      .then(
        () => new Error("the probe did not fail"),
        (error: unknown) => error
      );
    if (!(failure instanceof AggregateError))
      throw new Error(`expected both failures, got ${String(failure)}`, {
        cause: failure,
      });
    const [ran, removed, ...rest] = failure.errors as Error[];
    expect(rest).toEqual([]);
    expect(ran?.message).toBe("isolation probe container failed");
    expect((ran?.cause as Error | undefined)?.message).toBe(
      "exit 3: probe broke"
    );
    expect(removed?.message).toMatch(
      /^the isolation probe container babojubot-probe-\S+ could not be removed$/
    );
  });
});

/**
 * 실제 확인 스크립트를 이 컴퓨터에서 돌린다. 가짜 docker가 `node`를 이 프로그램으로 바꿔 띄우고, 먼저 읽히는 모듈이 컨테이너의
 * 네트워크를 대신한다: 네트워크 장치는 loopback뿐이고, 컨테이너 안 중계 포트(이미지의 relay.mjs가 잇는 127.0.0.1:39280·39281)는 이 확인이 연 실제 중계의 파일
 * 소켓으로 잇고, `HTTPS_PROXY`는 이미지의 시작 프로그램처럼 둔다. 직접 연결은 옆 파일 `direct.json`에 적은 주소만 정한 결과
 * (연결됨·연결 오류 코드·답 없음)를 내고, 그 밖은 이 컴퓨터에서 실제로 연결한다. 옆 파일 `answers.json`에 중계 포트의 답을 적으면
 * 그 포트는 중계 대신 그 글자를 답하고 열어 둔다(HTTP가 아닌 것이 답한 경우).
 */
const containerNetwork = `
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
// --network none의 컨테이너에는 loopback만 있다.
os.networkInterfaces = () => ({
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
});
const mounts = JSON.parse(process.env.FAKE_DOCKER_MOUNTS);
const relay = mounts.find((mount) => mount.target === "/run/babojubot").source;
const outcomes = JSON.parse(readFileSync(new URL("./direct.json", import.meta.url), "utf8"));
const answers = JSON.parse(readFileSync(new URL("./answers.json", import.meta.url), "utf8"));
const relayed = { 39280: "egress.sock", 39281: "tools.sock" };
process.env.HTTPS_PROXY = "http://127.0.0.1:39280";
const real = net.connect;
/** 연결되자마자 정한 글자를 답하고, 닫지 않는 상대. 열린 연결처럼 프로세스를 붙들고, 시한은 실제 타이머로 지난다. */
const answering = (text) => {
  const socket = new net.Socket();
  let timer;
  socket.write = () => true;
  socket.setTimeout = (ms, callback) => {
    if (callback) socket.once("timeout", callback);
    timer = setTimeout(() => socket.emit("timeout"), ms);
    return socket;
  };
  socket.destroy = () => {
    clearTimeout(timer);
    return socket;
  };
  setImmediate(() => {
    socket.emit("connect");
    socket.emit("data", Buffer.from(text));
  });
  return socket;
};
const connect = (options, ...rest) => {
  if (typeof options === "object" && options.host === "127.0.0.1" && answers[options.port] !== undefined)
    return answering(answers[options.port]);
  if (typeof options === "object" && options.host === "127.0.0.1" && relayed[options.port])
    return real({ path: path.join(relay, relayed[options.port]) }, ...rest);
  const outcome = typeof options === "object" ? outcomes[options.host + ":" + options.port] : undefined;
  if (outcome === undefined) return real(options, ...rest);
  const socket = new net.Socket();
  setImmediate(() => {
    if (outcome === "connected") socket.emit("connect");
    else if (outcome === "silent") socket.emit("timeout");
    else socket.emit("error", Object.assign(new Error(outcome), { code: outcome }));
  });
  return socket;
};
net.connect = connect;
net.createConnection = connect;
`;

describe.skipIf(process.platform === "win32")(
  "the isolation probe script against its relay",
  () => {
    /**
     * 확인 스크립트를 돌릴 가짜 docker. `direct`는 직접 연결의 정한 결과(`host:port` → 결과), `answers`는 중계 포트 대신 답할
     * 글자(포트 → 글자)다.
     */
    async function probeEnvironmentWith(
      direct: Record<string, string> = {},
      answers: Record<string, string> = {}
    ) {
      const root = await folders.make("babojubot-probe-");
      const network = path.join(root, "container-network.mjs");
      await writeFile(network, containerNetwork);
      await writeFile(path.join(root, "direct.json"), JSON.stringify(direct));
      await writeFile(path.join(root, "answers.json"), JSON.stringify(answers));
      return createDockerEnvironment({
        docker: [
          process.execPath,
          fixture("fake-docker.mjs"),
          root,
          JSON.stringify({ node: [process.execPath, "--import", network] }),
        ],
        image,
        owner: "owner-test",
        relay: attachedRelayHub(),
      });
    }

    /**
     * 금지 목적지. 중계가 그 주소로 붙으면 그 연결은 정한 오류(EHOSTUNREACH)로 실패하고 붙은 주소·포트가 남는다
     * (connect-failure-support.ts). 닫은 포트에 다시 붙는 실제 연결은 그 사이 다른 프로그램이 번호를 잡으면 결함 없이 실패한다
     * (#294 외부 리뷰 2회차 STD-2).
     */
    function forbiddenTarget() {
      const target = { host: "127.0.0.1", port: 40_125 };
      refusing.refuse = { port: target.port, code: "EHOSTUNREACH" };
      return target;
    }

    it("finds a forbidden destination blocked only when the relay refuses its address", async () => {
      const target = forbiddenTarget();
      const environment = await probeEnvironmentWith();
      await expect(
        environment.probe(
          { blocked: [], forbidden: [target] },
          AbortSignal.timeout(20_000)
        )
      ).resolves.toEqual({
        interfaces: [],
        reached: [],
        proxied: [],
        toolsReached: true,
        unverified: [],
      });
      // 주소 확인이 거부했으므로 중계는 목적지로 붙지 않았다.
      expect(refusing.dialed).not.toHaveBeenCalled();
    });

    // 중계가 502로 답한 것은 정책이 그 목적지를 열고 연결만 실패한 것이다. 주소 확인이 막지 못했으므로 막혔다고 세지 않는다
    // (#286 항목 1).
    it("counts a forbidden destination the relay let through as reached, even when the connection behind it failed", async () => {
      const target = forbiddenTarget();
      policy.decide = () => ({ allowed: true, addresses: ["127.0.0.1"] });
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const environment = await probeEnvironmentWith();
      await expect(
        environment.probe(
          { blocked: [], forbidden: [target] },
          AbortSignal.timeout(20_000)
        )
      ).resolves.toMatchObject({ proxied: [target] });
      // 정책이 연 주소로 붙었고 그 연결이 실패했다(502).
      expect(refusing.dialed.mock.calls).toEqual([[target]]);
    });

    // 주소 확인이 아닌 이유의 거부(정책을 읽지 못함·목록에 없음·이름을 풀지 못함)로는 주소 확인이 막는지 알 수 없다. 확인 불가다.
    it.each([
      "policy_unavailable",
      "destination_not_allowed",
      "not_resolved",
    ] as const)(
      "reports the relay check as unverified when the relay refuses for %s instead of the address",
      async (reason) => {
        const target = forbiddenTarget();
        policy.decide = () => ({ allowed: false, reason });
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());
        const environment = await probeEnvironmentWith();
        await expect(
          environment.probe(
            { blocked: [], forbidden: [target] },
            AbortSignal.timeout(20_000)
          )
        ).resolves.toMatchObject({ proxied: [], unverified: ["proxied"] });
        expect(refusing.dialed).not.toHaveBeenCalled();
      }
    );

    // 직접 연결이 거부되거나 길이 없으면 닿지 않은 것이다. 답이 없거나(시한) 그 밖의 오류는 닿지 못했다는 답이 아니다.
    it.each([
      ["refused", "ECONNREFUSED", []],
      ["unreachable", "ENETUNREACH", []],
      ["silent until its limit", "silent", ["direct"]],
      ["timed out by the system", "ETIMEDOUT", ["direct"]],
      ["unresolvable", "ENOTFOUND", ["direct"]],
    ])(
      "tells a direct connection that was %s from one it could not check",
      async (_case, outcome, unverified) => {
        const target = { host: "192.0.2.10", port: 5432 };
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());
        const environment = await probeEnvironmentWith({
          "192.0.2.10:5432": outcome,
        });
        await expect(
          environment.probe(
            { blocked: [target], forbidden: [] },
            AbortSignal.timeout(20_000)
          )
        ).resolves.toEqual({
          interfaces: [],
          reached: [],
          proxied: [],
          toolsReached: true,
          unverified,
        });
      }
    );

    // 중계의 답은 HTTP 파서가 읽은 머리로만 판정한다. 본문에 거부 머리와 같은 글자가 있어도 주소 거부가 아니다(#286 병합분 항목 10).
    it("does not take refusal words in the body of the relay's answer for its address refusal", async () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const environment = await probeEnvironmentWith(
        {},
        {
          39280:
            "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nx-babojubot-refusal: address_not_allowed\r\n",
        }
      );
      await expect(
        environment.probe(
          { blocked: [], forbidden: [{ host: "192.0.2.20", port: 5432 }] },
          AbortSignal.timeout(20_000)
        )
      ).resolves.toEqual({
        interfaces: [],
        reached: [],
        proxied: [],
        toolsReached: true,
        unverified: ["proxied"],
      });
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] the isolation probe's proxied check failed (answered 403)",
      ]);
    });

    // 상태 줄 하나는 답이 아니다. 머리를 HTTP로 다 읽지 못하면 조직 도구에 닿았다고 보지 않고 파서가 알린 원인을 남긴다(#286 병합분 항목 10).
    it("does not count the organization tools as reached when only the status line of their answer reads as HTTP", async () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const environment = await probeEnvironmentWith(
        {},
        { 39281: "HTTP/1.1 200 OK\r\nnot a header line\r\n\r\n" }
      );
      await expect(
        environment.probe(
          { blocked: [], forbidden: [] },
          AbortSignal.timeout(20_000)
        )
      ).resolves.toEqual({
        interfaces: [],
        reached: [],
        proxied: [],
        toolsReached: false,
        unverified: ["tools"],
      });
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] the isolation probe's tools check failed (HPE_INVALID_HEADER_TOKEN)",
      ]);
    });

    it("counts a direct connection that opened as reached", async () => {
      const target = { host: "192.0.2.10", port: 5432 };
      const environment = await probeEnvironmentWith({
        "192.0.2.10:5432": "connected",
      });
      await expect(
        environment.probe(
          { blocked: [target], forbidden: [] },
          AbortSignal.timeout(20_000)
        )
      ).resolves.toMatchObject({ reached: [target], unverified: [] });
    });

    // HTTP가 아닌 것이 답하면 닿았는지 막혔는지 알 수 없다. HTTP 파서가 알린 원인을 남기고 확인 불가로 넘긴다(#286).
    it.each([
      ["the organization tools", 39281, "tools"],
      ["the relay", 39280, "proxied"],
    ] as const)(
      "reports %s check answered by something other than HTTP as unverified, with the cause its HTTP parser gave",
      async (_case, port, probe) => {
        const target = forbiddenTarget();
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());
        const environment = await probeEnvironmentWith(
          {},
          { [port]: "SSH-2.0-OpenSSH_9.9\r\n\r\n" }
        );
        const result = await environment.probe(
          { blocked: [], forbidden: [target] },
          AbortSignal.timeout(20_000)
        );
        expect(result.unverified).toEqual([probe]);
        expect(result.proxied).toEqual([]);
        // 답을 바꿔 넣은 확인은 중계에 닿지 않아 목적지로 붙지 않았다.
        expect(refusing.dialed).not.toHaveBeenCalled();
        expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
          `[provider] the isolation probe's ${probe} check failed (HPE_INVALID_CONSTANT)`,
        ]);
      }
    );
  }
);

describe("the Docker engine check", () => {
  async function engine(files: Record<string, string> = {}) {
    const root = await folders.make("babojubot-engine-");
    for (const [name, value] of Object.entries(files))
      await writeFile(path.join(root, name), value);
    return createDockerEnvironment({
      docker: [process.execPath, fixture("fake-docker.mjs"), root, "{}"],
      image,
      owner: "owner-test",
      relay: attachedRelayHub(),
    });
  }

  it("accepts a local Linux engine with the current runner image", async () => {
    await expect(
      (await engine()).checkDaemon(AbortSignal.timeout(10_000))
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      "Docker Desktop",
      {
        "info.json": JSON.stringify({
          OSType: "linux",
          OperatingSystem: "Docker Desktop",
          SecurityOptions: [],
        }),
      },
    ],
    [
      "rootless Docker",
      {
        "info.json": JSON.stringify({
          OSType: "linux",
          OperatingSystem: "Ubuntu",
          SecurityOptions: ["name=rootless"],
        }),
      },
    ],
    [
      "a Windows engine",
      {
        "info.json": JSON.stringify({
          OSType: "windows",
          OperatingSystem: "Windows",
          SecurityOptions: [],
        }),
      },
    ],
    ["an image without the relay start program", { "runner-version": "" }],
    [
      "a Docker context on another computer",
      { "context-host": "ssh://user@build-box" },
    ],
  ])("refuses %s", async (_case, files) => {
    await expect(
      (await engine(files)).checkDaemon(AbortSignal.timeout(10_000))
    ).rejects.toThrow();
  });

  it("refuses a daemon on another computer, whose folders this computer cannot check", async () => {
    vi.stubEnv("DOCKER_HOST", "tcp://10.0.0.9:2375");
    await expect(
      (await engine()).checkDaemon(AbortSignal.timeout(10_000))
    ).rejects.toThrow(/not on this computer/);
  });
});
