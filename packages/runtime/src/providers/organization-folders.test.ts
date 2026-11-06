import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderConnection, RunRequest } from "@babojubot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { createClaudeProvider } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import type { ContainerSettings } from "./container.ts";
import { createOpenCodeProvider } from "./opencode.ts";
import { request } from "./test-support.ts";

// 조직별 제품 폴더(사용자 결정 2026-11-06, docs/research/org-product-folders-references.md).
// 같은 연결이라도 조직마다 제품 폴더(설정·세션·확장)를 따로 쓴다. 연결 폴더는 로그인 원본·준비 확인·모델 목록·프로세스 기록에만 쓰고
// 컨테이너에 넣지 않는다. 한 조직이 써 둔 설정을 다른 조직의 프로그램이 읽어 그 조직의 실행 시도 토큰을 내보내지 못하게 한다.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const fixture = (name: string) => path.resolve("test-fixtures", name);
const control = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});
type Create = (options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  container?: ContainerSettings;
}) => ProviderConnection;
const providers: [string, Create, string, string][] = [
  // 이름, 만드는 함수, 연결 ID, 그 프로그램의 설정 폴더 변수
  ["Claude", createClaudeProvider, "claude", "CLAUDE_CONFIG_DIR"],
  ["Codex", createCodexProvider, "codex", "CODEX_HOME"],
  ["OpenCode", createOpenCodeProvider, "opencode", "XDG_DATA_HOME"],
  ["Antigravity", createAntigravityProvider, "antigravity", "XDG_CONFIG_HOME"],
];

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-org-folders-"));
  roots.push(root);
  const dump = path.join(root, "env.jsonl");
  // 받은 환경을 한 줄로 남기고 끝나는 프로그램. 프로바이더 실행은 실패하지만 어느 폴더로 띄웠는지는 남는다.
  // 스크립트 파일로 둔다. `node -e`이면 프로바이더가 붙이는 `--print` 같은 인자를 node가 자기 옵션으로 읽는다.
  const script = path.join(root, "dump-env.cjs");
  await writeFile(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env) + "\\n");`
  );
  const dumper: [string, ...string[]] = [process.execPath, script];
  const state = path.join(root, "docker-state");
  await mkdir(state);
  const container: ContainerSettings = {
    docker: [
      process.execPath,
      fixture("fake-docker.mjs"),
      state,
      JSON.stringify({
        claude: dumper,
        codex: dumper,
        opencode: dumper,
        agy: dumper,
      }),
    ],
    image: "babojubot-runner-test",
    network: "babojubot-test",
    owner: "owner-test",
  };
  const requestFor = async (
    organizationId: string,
    execution?: "container"
  ): Promise<RunRequest> => {
    const input = request();
    input.identity.organizationId = organizationId;
    input.context.organization.id = organizationId;
    const shared = path.join(root, "organizations", organizationId, "shared");
    await mkdir(shared, { recursive: true });
    return {
      ...input,
      ...(execution ? { execution } : {}),
      workspace: { cwd: shared, organization: shared },
    };
  };
  const dumps = async (): Promise<NodeJS.ProcessEnv[]> => {
    try {
      return (await readFile(dump, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NodeJS.ProcessEnv);
    } catch {
      return [];
    }
  };
  const runMounts = async () =>
    (await readFile(path.join(state, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] })
      .filter((call) => call.args.includes("run"))
      .map((call) =>
        call.args.flatMap((arg, i) =>
          arg === "--mount" ? [call.args[i + 1]!] : []
        )
      );
  return { root, dumper, container, requestFor, dumps, runMounts };
}

const inside = (folder: string, file: string | undefined) => {
  if (!file) return false;
  const relative = path.relative(folder, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

describe.each(providers)("%s", (_name, create, id, configVariable) => {
  it("runs each organization with its own product folder of the connection on this machine", async () => {
    const env = await setup();
    const provider = create({ dataDir: env.root, command: env.dumper });
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    await provider.adapter.execute(await env.requestFor(a), control());
    await provider.adapter.execute(await env.requestFor(b), control());
    const connection = path.join(env.root, "providers", id);
    const [first, second] = (await env.dumps()).slice(-2);
    const homeA = path.join(connection, "organizations", a);
    const homeB = path.join(connection, "organizations", b);
    expect(first?.HOME).toBe(homeA);
    expect(inside(homeA, first?.[configVariable])).toBe(true);
    expect(second?.HOME).toBe(homeB);
    expect(inside(homeB, second?.[configVariable])).toBe(true);
    // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
    await expect(
      stat(path.join(connection, "processes"))
    ).resolves.toBeTruthy();
    await expect(stat(path.join(homeA, "processes"))).rejects.toThrow();
  });

  it("puts only that organization's product folder into its container, never the connection folder", async () => {
    const env = await setup();
    const provider = create({
      dataDir: env.root,
      command: env.dumper,
      container: env.container,
    });
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    await provider.adapter.execute(
      await env.requestFor(a, "container"),
      control()
    );
    await provider.adapter.execute(
      await env.requestFor(b, "container"),
      control()
    );
    const connection = path.join(env.root, "providers", id);
    const [mountsA, mountsB] = await env.runMounts();
    const product = (mounts: string[] | undefined) =>
      (mounts ?? [])
        .map((mount) => /source=([^,]+)/.exec(mount)![1]!)
        .filter((source) => inside(connection, source));
    const homeA = path.join(connection, "organizations", a);
    const homeB = path.join(connection, "organizations", b);
    // Codex는 연결의 로그인 하나를 같이 쓰므로 로그인 전용 폴더도 넣는다. 그 밖의 연결 폴더는 넣지 않는다.
    const login = id === "codex" ? [path.join(connection, "login")] : [];
    expect(product(mountsA).sort()).toEqual([homeA, ...login].sort());
    expect(product(mountsB).sort()).toEqual([homeB, ...login].sort());
    expect(mountsA).toContain(`type=bind,source=${homeA},target=${homeA}`);
    const [first] = await env.dumps();
    expect(first?.HOME).toBe(homeA);
  });

  it("keeps readiness on the connection folder that no container sees", async () => {
    const env = await setup();
    const provider = create({ dataDir: env.root, command: env.dumper });
    await provider.adapter.checkReadiness(new AbortController().signal);
    const connection = path.join(env.root, "providers", id);
    const dumped = await env.dumps();
    expect(dumped.length).toBeGreaterThan(0);
    for (const one of dumped) expect(one.HOME).toBe(connection);
  });
});

describe("Claude", () => {
  it("compacts a session in its organization's product folder", async () => {
    const env = await setup();
    const provider = createClaudeProvider({
      dataDir: env.root,
      command: env.dumper,
    });
    const organizationId = crypto.randomUUID();
    await provider.adapter.precompact!(
      {
        session: {
          id: "session-one",
          launch: { instructions: "saved", cwd: env.root, model: null },
        },
        access: request().access,
        organizationId,
      },
      new AbortController().signal
    );
    const home = path.join(
      env.root,
      "providers/claude/organizations",
      organizationId
    );
    const [dumped] = await env.dumps();
    expect(dumped?.HOME).toBe(home);
    expect(dumped?.CLAUDE_CONFIG_DIR).toBe(path.join(home, "config"));
  });

  it("gives every organization the connection's one login", async () => {
    const env = await setup();
    await mkdir(path.join(env.root, "providers/claude"), { recursive: true });
    await writeFile(
      path.join(env.root, "providers/claude/setup-token"),
      "synthetic-login"
    );
    const provider = createClaudeProvider({
      dataDir: env.root,
      command: env.dumper,
    });
    await provider.adapter.execute(
      await env.requestFor(crypto.randomUUID()),
      control()
    );
    const [dumped] = await env.dumps();
    expect(dumped?.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-login");
  });
});

describe("Codex", () => {
  it("links every organization's login file to the connection's one login and moves an older login there", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/codex");
    await mkdir(connection, { recursive: true });
    // 연결 폴더에 바로 있던 예전 로그인.
    await writeFile(path.join(connection, "auth.json"), '{"synthetic":1}');
    const provider = createCodexProvider({
      dataDir: env.root,
      command: env.dumper,
    });
    const organizationId = crypto.randomUUID();
    await provider.adapter.execute(
      await env.requestFor(organizationId),
      control()
    );
    const original = path.join(connection, "login", "auth.json");
    expect(await readFile(original, "utf8")).toBe('{"synthetic":1}');
    // 로그인 명령·준비 확인은 연결 폴더로 돌므로 그 자리도 원본을 가리킨다.
    expect(
      (await lstat(path.join(connection, "auth.json"))).isSymbolicLink()
    ).toBe(true);
    expect(await readlink(path.join(connection, "auth.json"))).toBe(original);
    const linked = path.join(
      connection,
      "organizations",
      organizationId,
      "auth.json"
    );
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked)).toBe(original);
    expect(await readFile(linked, "utf8")).toBe('{"synthetic":1}');
  });

  it("drops a link that a container left in place of the shared login, before this machine's Codex can write through it", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/codex");
    // 로그인 전용 폴더는 모든 조직 컨테이너에 쓰기로 들어간다. 에이전트가 원본 자리를 이 컴퓨터의 다른 파일을 가리키는 링크로 바꿔 둔 장면이다.
    // 남겨 두면 이 컴퓨터에서 도는 Codex(준비 확인·모델 목록)가 로그인을 갱신할 때 링크를 따라 그 파일을 덮어쓴다.
    const victim = path.join(env.root, "outside-file");
    await writeFile(victim, "keep me");
    await mkdir(path.join(connection, "login"), { recursive: true });
    await symlink(victim, path.join(connection, "login", "auth.json"));
    const provider = createCodexProvider({
      dataDir: env.root,
      command: env.dumper,
    });
    await provider.adapter.checkReadiness(new AbortController().signal);
    const original = path.join(connection, "login", "auth.json");
    await expect(lstat(original)).rejects.toThrow();
    await symlink(victim, original);
    await provider.adapter.execute(
      await env.requestFor(crypto.randomUUID()),
      control()
    );
    await expect(lstat(original)).rejects.toThrow();
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });
});

describe("OpenCode", () => {
  const login = {
    id: "cred_one",
    integrationID: "opencode-go",
    label: "Go",
    active: true,
    value: { type: "key", key: "synthetic-key" },
  };
  it("copies the connection's login into an organization's product folder that has none, but not its sessions", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/opencode");
    await mkdir(path.join(connection, "data"), { recursive: true });
    await writeFile(
      path.join(connection, "data", "synthetic-credentials.json"),
      JSON.stringify([login])
    );
    await writeFile(path.join(connection, "data", "ses_old.note"), "old");
    const provider = createOpenCodeProvider({
      dataDir: env.root,
      command: [process.execPath, fixture("opencode-simulator.mjs")],
    });
    const organizationId = crypto.randomUUID();
    const result = await provider.adapter.execute(
      await env.requestFor(organizationId),
      control()
    );
    expect(result.stopReason).toBe("completed");
    const data = path.join(connection, "organizations", organizationId, "data");
    expect(
      JSON.parse(
        await readFile(path.join(data, "synthetic-credentials.json"), "utf8")
      )
    ).toEqual([login]);
    await expect(stat(path.join(data, "ses_old.note"))).rejects.toThrow();
  }, 20000);

  it("leaves an organization's own login as it is", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/opencode");
    const organizationId = crypto.randomUUID();
    const data = path.join(connection, "organizations", organizationId, "data");
    await mkdir(path.join(connection, "data"), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(connection, "data", "synthetic-credentials.json"),
      JSON.stringify([login])
    );
    const own = {
      ...login,
      id: "cred_own",
      value: { type: "key", key: "own" },
    };
    await writeFile(
      path.join(data, "synthetic-credentials.json"),
      JSON.stringify([own])
    );
    const provider = createOpenCodeProvider({
      dataDir: env.root,
      command: [process.execPath, fixture("opencode-simulator.mjs")],
    });
    const result = await provider.adapter.execute(
      await env.requestFor(organizationId),
      control()
    );
    expect(result.stopReason).toBe("completed");
    expect(
      JSON.parse(
        await readFile(path.join(data, "synthetic-credentials.json"), "utf8")
      )
    ).toEqual([own]);
  }, 20000);

  it("still runs in a container when the connection's login cannot be read on this machine", async () => {
    const env = await setup();
    // 컨테이너 안 프로그램은 있지만 이 컴퓨터에는 그 프로그램이 없다. 로그인 옮기기는 건너뛰고 실행은 그대로 한다(무료 모델은 로그인 없이 돈다).
    env.container.docker = [
      ...env.container.docker.slice(0, 3),
      JSON.stringify({
        opencode: [process.execPath, fixture("opencode-simulator.mjs")],
      }),
    ] as unknown as ContainerSettings["docker"];
    const provider = createOpenCodeProvider({
      dataDir: env.root,
      command: [path.join(env.root, "missing-opencode")],
      container: env.container,
    });
    const result = await provider.adapter.execute(
      await env.requestFor(crypto.randomUUID(), "container"),
      control()
    );
    expect(result.stopReason).toBe("completed");
  }, 20000);
});
