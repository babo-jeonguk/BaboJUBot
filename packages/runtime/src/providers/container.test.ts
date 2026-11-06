import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunRequest } from "@babojubot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeProvider } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import { createOpenCodeProvider } from "./opencode.ts";
import { createAntigravityProvider } from "./antigravity.ts";
import {
  createDockerEnvironment,
  type ContainerSettings,
} from "./container.ts";
import { request } from "./test-support.ts";

// 격리 실행(#102)을 실제 Docker 없이 확인한다. 가짜 docker(test-fixtures/fake-docker.mjs)는 받은 명령을 남기고,
// `run`이면 컨테이너 안 프로그램 이름을 이 컴퓨터의 재생 프로그램으로 바꿔 컨테이너 환경 변수·작업 폴더로 실행한다.

const roots: string[] = [];
const saved = { ...process.env };
afterEach(async () => {
  process.env = { ...saved };
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

type Call = { args: string[]; env?: Record<string, string> };
const image = "babojubot-runner-test";
const fixture = (name: string) => path.resolve("test-fixtures", name);

async function setup(programs: Record<string, string[]>) {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-container-"));
  roots.push(root);
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
    network: "babojubot-test",
    owner: "owner-test",
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

describe("an isolated attempt", () => {
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
    process.env.GH_TOKEN = "github-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    process.env.BABOJUBOT_CLAUDE_PASS_ENV = "GH_TOKEN,GITHUB_TOKEN";
    // 이 컴퓨터의 프로그램 위치 설정은 컨테이너에서 쓰지 않는다. 컨테이너에는 이미지의 프로그램이 있다.
    process.env.BABOJUBOT_CLAUDE_COMMAND = "/host/only/claude";
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
    expect(valuesOf(args, "--network")).toEqual(["babojubot-test"]);
    expect(args).not.toContain("--privileged");
    expect(valuesOf(args, "--workdir")).toEqual([env.shared]);
    // 서버 재시작 때 이 제품 폴더의 남은 컨테이너만 찾아 지우도록 표식을 단다.
    const labels = valuesOf(args, "--label");
    expect(labels).toContain("babojubot.owner=owner-test");
    expect(labels).toContainEqual(
      expect.stringMatching(/^babojubot\.run=[0-9a-f-]{36}$/)
    );
    // 조직 폴더·자기 개인 폴더·그 조직의 제품 폴더는 읽기·쓰기, 동료 개인 폴더와 이 실행 시도의 파일 폴더는 읽기만. 그 밖에는 없다.
    expect(valuesOf(args, "--mount").sort()).toEqual(
      [
        `type=bind,source=${env.shared},target=${env.shared}`,
        `type=bind,source=${env.personal},target=${env.personal}`,
        `type=bind,source=${env.peerFolder},target=${env.peerFolder},readonly`,
        `type=bind,source=${home},target=${home}`,
        // 토큰이 든 이 실행 시도만의 파일 폴더(읽기만).
        `type=bind,source=${path.dirname(valuesOf(args, "--mcp-config")[0]!)},target=${path.dirname(valuesOf(args, "--mcp-config")[0]!)},readonly`,
      ].sort()
    );
    expect(args.join(" ")).not.toMatch(/docker\.sock|--volume|-v /);
    // 이미지 다음은 컨테이너 안 프로그램 이름이다.
    expect(args[args.indexOf(image) + 1]).toBe("claude");
    // 비밀값은 명령줄에 싣지 않는다.
    expect(args.join(" ")).not.toMatch(
      /private-run-token|synthetic-login|github-secret/
    );
    // 컨테이너 환경: 제품 홈·로그인은 있고, GitHub 로그인과 이 컴퓨터의 임시 폴더는 없다. 추가 패키지는 조직 폴더의 가상환경이다.
    expect(run.env).toMatchObject({
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, "config"),
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-login",
      BABOJUBOT_VENV: path.join(env.shared, ".venv"),
    });
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
      `type=bind,source=${attempt},target=${attempt},readonly`
    );
    // 지침 파일도 같은 폴더에 둔다.
    expect(
      path.dirname(valuesOf(run.args, "--append-system-prompt-file")[0]!)
    ).toBe(attempt);
    // 끝나면 그 폴더를 지운다.
    await expect(readFile(config, "utf8")).rejects.toThrow();
  });

  it("keeps the Antigravity run token out of the organization folder that every container of the organization shares", async () => {
    const env = await setup({});
    const recording = path.join(env.root, "agy.json");
    await writeFile(
      recording,
      JSON.stringify({
        steps: [
          { frame: { event: "init", conversation_id: "c1" } },
          { input: { event: "user" } },
          {
            frame: {
              event: "result",
              result: { status: "SUCCESS", conversation_id: "c1" },
            },
          },
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
    // Antigravity는 작업 폴더의 .agents/mcp_config.json만 읽는다. 조직 폴더는 그 조직의 모든 컨테이너가 쓰기로 넣으므로,
    // 토큰이 든 설정은 이 실행 시도 전용 폴더에 두고 이 컨테이너에만 그 경로 위에 읽기로 넣는다. 조직 폴더의 파일은 자리만 잡는다.
    const config = path.join(
      await realpath(env.shared),
      ".agents/mcp_config.json"
    );
    const seen: { shared: string; source: string; mode: number }[] = [];
    const result = await provider.adapter.execute(env.isolated(), {
      signal: new AbortController().signal,
      emit: async () => {
        const run = runCall(await env.calls());
        const overlay = valuesOf(run.args, "--mount").find((m) =>
          m.endsWith(`,target=${config},readonly`)
        );
        expect(overlay).toBeDefined();
        const source = /source=([^,]+)/.exec(overlay!)![1]!;
        seen.push({
          shared: await readFile(config, "utf8"),
          source: await readFile(source, "utf8"),
          mode: (await stat(source)).mode & 0o777,
        });
      },
    });
    expect(result.stopReason).toBe("completed");
    expect(seen.length).toBeGreaterThan(0);
    for (const { shared, source, mode } of seen) {
      expect(shared).not.toContain("private-run-token");
      expect(source).toContain("private-run-token");
      // Windows는 권한 비트를 쓰지 않는다.
      if (process.platform !== "win32") expect(mode).toBe(0o600);
    }
    const run = runCall(await env.calls());
    const mounts = valuesOf(run.args, "--mount");
    const source = /source=([^,]+)/.exec(
      mounts.find((m) => m.endsWith(`,target=${config},readonly`))!
    )![1]!;
    // 토큰 파일은 이 컨테이너가 쓰기로 넣는 어느 폴더(제품·조직·자기 폴더)에도 없다.
    for (const mount of mounts.filter((m) => !m.endsWith(",readonly"))) {
      const target = /target=([^,]+)/.exec(mount)![1]!;
      expect(path.relative(target, source).startsWith("..")).toBe(true);
    }
    // 끝나면 토큰 파일과 조직 폴더의 자리 파일을 모두 지운다.
    await expect(stat(source)).rejects.toThrow();
    await expect(stat(config)).rejects.toThrow();
  });

  it("keeps a user's own Antigravity configuration in the organization folder and refuses to run in a container", async () => {
    const env = await setup({});
    const config = path.join(env.shared, ".agents/mcp_config.json");
    await mkdir(path.dirname(config));
    await writeFile(config, '{"user":"keep"}');
    const provider = createAntigravityProvider({
      dataDir: env.root,
      container: env.container,
    });
    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("failed");
    expect(await readFile(config, "utf8")).toBe('{"user":"keep"}');
    expect((await env.calls()).some((c) => c.args.includes("run"))).toBe(false);
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
      ...env.container.docker.slice(0, 3),
      JSON.stringify({
        claude: [process.execPath, fixture("replay.mjs"), compact],
      }),
    ] as unknown as ContainerSettings["docker"];
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

  it("controls OpenCode in a container through a port published only on this machine's loopback", async () => {
    const env = await setup({
      opencode: [process.execPath, fixture("opencode-simulator.mjs")],
    });
    const provider = createOpenCodeProvider({
      dataDir: env.root,
      container: env.container,
    });
    expect(provider.isolatable).toBe(true);
    const result = await provider.adapter.execute(env.isolated(), control());
    expect(result.stopReason).toBe("completed");
    const calls = await env.calls();
    const run = runCall(calls);
    expect(valuesOf(run.args, "--publish")).toEqual(["127.0.0.1::4096"]);
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
    expect(
      calls.some((c) => c.args.includes("port") && c.args.includes(nameOf(run)))
    ).toBe(true);
    expect(removed(calls, nameOf(run))).toBe(true);
  });
});

describe("the dedicated network", () => {
  async function network(existing?: Record<string, unknown>) {
    const root = await mkdtemp(path.join(tmpdir(), "babojubot-network-"));
    roots.push(root);
    if (existing)
      await writeFile(
        path.join(root, "network.json"),
        JSON.stringify(existing)
      );
    const settings: ContainerSettings = {
      docker: [process.execPath, fixture("fake-docker.mjs"), root, "{}"],
      image,
      network: "babojubot-test",
      owner: "owner-test",
    };
    return createDockerEnvironment(settings);
  }
  const isolating = {
    Name: "babojubot-test",
    Driver: "bridge",
    Options: { "com.docker.network.bridge.enable_icc": "false" },
    Labels: { "babojubot.owner": "someone-else" },
    IPAM: { Config: [{ Subnet: "172.31.0.0/16", Gateway: "172.31.0.1" }] },
  };

  it("creates a bridge network whose containers cannot reach each other and uses its gateway", async () => {
    const environment = await network();
    await expect(
      environment.prepareNetwork(AbortSignal.timeout(10_000))
    ).resolves.toEqual({ gateway: "172.31.0.1" });
  });

  it("accepts an existing network with the same isolation, whoever created it", async () => {
    // 같은 컴퓨터의 다른 제품 폴더도 같은 이름의 네트워크를 쓴다. 격리는 네트워크의 속성이 정한다.
    const environment = await network(isolating);
    await expect(
      environment.prepareNetwork(AbortSignal.timeout(10_000))
    ).resolves.toEqual({ gateway: "172.31.0.1" });
  });

  it.each([
    [
      "containers on it can reach each other",
      {
        ...isolating,
        Options: { "com.docker.network.bridge.enable_icc": "true" },
      },
    ],
    [
      "it does not say whether containers can reach each other",
      { ...isolating, Options: {} },
    ],
    ["it is not a bridge", { ...isolating, Driver: "macvlan" }],
  ])(
    "does not accept an existing network of the same name when %s",
    async (_case, existing) => {
      const environment = await network(existing);
      await expect(
        environment.prepareNetwork(AbortSignal.timeout(10_000))
      ).rejects.toThrow();
    }
  );
});
