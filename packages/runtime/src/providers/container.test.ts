import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import type net from "node:net";
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
import { attachedRelayHub, request } from "./test-support.ts";

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

type Call = {
  args: string[];
  env?: Record<string, string>;
  relayOpen?: boolean;
};
const image = "babojubot-runner-test";
const fixture = (name: string) => path.resolve("test-fixtures", name);
/** 임시 폴더 바로 아래 폴더의 실제 경로. 임시 폴더가 링크 뒤에 있으면(macOS /var → /private/var) mount 원본은 실제 경로다. 폴더는 이미 지워졌을 수 있다. */
const canonicalTemp = (folder: string) =>
  path.join(realpathSync(path.dirname(folder)), path.basename(folder));

async function setup(programs: Record<string, string[]>) {
  // 임시 폴더가 링크 뒤에 있으면(macOS) 그 실제 경로로 둔다. 링크 뒤 데이터 폴더는 container-mounts 시험이 본다.
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "babojubot-container-"))
  );
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
      expect(refused.error).toContain("로그인 기록");
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
        expect(result.error).toContain("로그인 기록");
        expect(
          (await env.calls()).some((call) => call.args.includes("run"))
        ).toBe(false);
      }
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
        expect(refused.error).toContain("로그인 기록");
      }
    );
  }
);

/** 모의 상류와, 조직 도구 listener처럼 `/api/relay/<연결>` 아래를 중계에 넘기는 서버. 중계는 상류 주소를 받은 뒤 만든다. */
async function relayed(
  connectionId: string,
  connect: (upstream: string) => { handle: http.RequestListener }
) {
  const seen: http.IncomingHttpHeaders[] = [];
  const urls: string[] = [];
  const servers: http.Server[] = [];
  const listen = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  };
  const upstream = await listen((req, res) => {
    seen.push(req.headers);
    urls.push(req.url ?? "");
    req.resume();
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
  const close = async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  return { tools, seen, urls, close };
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
      process.env.ANTHROPIC_API_KEY = "api-key-secret";
      process.env.BABOJUBOT_CLAUDE_PASS_ENV = "ANTHROPIC_API_KEY";
      let provider!: ReturnType<typeof createClaudeProvider>;
      const network = await relayed("claude", (upstream) => {
        provider = createClaudeProvider({
          dataDir: env.root,
          container: env.container,
          relay: { upstream, verified: true },
        });
        return provider.credentialRelay!;
      });
      try {
        const input = env.isolated();
        input.access = { ...input.access, toolsBaseUrl: network.tools };
        const result = await provider.adapter.execute(input, control());
        expect(result.stopReason).toBe("completed");
        expect(network.seen).toHaveLength(1);
        expect(network.seen[0]!.authorization).toBe("Bearer synthetic-login");
        const run = runCall(await env.calls());
        expect(JSON.stringify(run)).not.toMatch(
          /synthetic-login|api-key-secret/
        );
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
      } finally {
        await network.close();
      }
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
      try {
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
      } finally {
        await network.close();
      }
    });

    it("does not start when a login is left in the organization's product folder", async () => {
      const env = await setup(relayProgram);
      const config = path.join(
        env.root,
        "providers/claude/organizations",
        env.org,
        "config"
      );
      await mkdir(config, { recursive: true });
      await writeFile(path.join(config, ".credentials.json"), "{}");
      const provider = createClaudeProvider({
        dataDir: env.root,
        container: env.container,
        relay: { verified: true },
      });
      const result = await provider.adapter.execute(env.isolated(), control());
      expect(result.stopReason).toBe("failed");
      expect(result.error).toContain("로그인 기록");
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
      login: string | null = JSON.stringify(realLogin)
    ) {
      const env = await setup(relayProgram);
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
      /** 프로그램이 본 로그인·인수·갱신 주소. */
      const seen = async () =>
        JSON.parse(
          await readFile(path.join(organization, "seen-auth.json"), "utf8")
        ) as {
          login: { tokens: Record<string, string>; [key: string]: unknown };
          args: string[];
          refreshUrl: string | null;
        };
      return {
        env,
        network,
        provider: () => provider,
        input,
        seen,
        organization,
        loginFolder,
      };
    }

    it("lets the program reach the model only through the relay, which puts the connection's access token and account in place of the run's grant", async () => {
      const t = await codexSetup();
      try {
        const result = await t.provider().adapter.execute(t.input(), control());
        expect(result.stopReason).toBe("completed");
        expect(t.network.urls).toEqual(["/responses"]);
        expect(t.network.seen[0]!.authorization).toBe(
          "Bearer real-access-token"
        );
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
        // 실행 시도가 끝나면 권한을 거두고, 조직 폴더의 가짜 로그인 파일을 지운다.
        const after = await fetch(`${relayBase}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${grant}` },
        });
        expect(after.status).toBe(401);
        expect(t.network.urls).toHaveLength(1);
        await expect(
          stat(path.join(t.organization, "auth.json"))
        ).rejects.toThrow();
      } finally {
        await t.network.close();
      }
    });

    it("ends the run as failed with the reason when the relay cannot read the login, and the program's own retries never reach the model", async () => {
      const t = await codexSetup(null);
      try {
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
      } finally {
        await t.network.close();
      }
    });

    it("replaces the link to the connection's login this machine left without writing through it, and starts over its own leftover login file", async () => {
      const t = await codexSetup();
      try {
        const original = path.join(t.loginFolder, "auth.json");
        const before = await readFile(original, "utf8");
        await mkdir(t.organization, { recursive: true });
        await symlink(original, path.join(t.organization, "auth.json"));
        const first = await t.provider().adapter.execute(t.input(), control());
        expect(first.stopReason).toBe("completed");
        // 원본 로그인은 그대로다.
        expect(await readFile(original, "utf8")).toBe(before);
        // 서버가 실행 중에 멈춰 이 어댑터의 가짜 로그인 파일이 남았어도 다음 실행은 시작한다.
        const leftover = (await t.seen()).login;
        await writeFile(
          path.join(t.organization, "auth.json"),
          JSON.stringify(leftover)
        );
        const second = await t.provider().adapter.execute(t.input(), control());
        expect(second.stopReason).toBe("completed");
        expect(await readFile(original, "utf8")).toBe(before);
        expect(t.network.urls).toHaveLength(2);
      } finally {
        await t.network.close();
      }
    });

    it("does not start over a real-looking login left in the organization's product folder", async () => {
      const t = await codexSetup();
      try {
        await mkdir(t.organization, { recursive: true });
        await writeFile(
          path.join(t.organization, "auth.json"),
          JSON.stringify({ ...realLogin, tokens: { ...realLogin.tokens } })
        );
        const result = await t.provider().adapter.execute(t.input(), control());
        expect(result.stopReason).toBe("failed");
        expect(result.error).toContain("로그인 기록");
        expect(await t.env.calls()).toEqual([]);
        expect(t.network.urls).toHaveLength(0);
      } finally {
        await t.network.close();
      }
    });
  }
);

describe("the Docker engine check", () => {
  async function engine(files: Record<string, string> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "babojubot-engine-"));
    roots.push(root);
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
    process.env.DOCKER_HOST = "tcp://10.0.0.9:2375";
    await expect(
      (await engine()).checkDaemon(AbortSignal.timeout(10_000))
    ).rejects.toThrow(/not on this computer/);
  });
});
