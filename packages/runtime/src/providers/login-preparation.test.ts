import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderConnection, RunRequest } from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { createCodexProvider } from "./codex.ts";
import type { ContainerSettings } from "./container.ts";
import type { CredentialRelay } from "./credential-relay.ts";
import { attachedRelayHub, request } from "./test-support.ts";

// 로그인을 파일로 같이 쓰는 Codex·Antigravity의 실행 준비(#146). 조직 신원 확인 → 연결 로그인 준비 → 격리 실행이면 흔적 검사·
// 실행 시도 전용 로그인 파일, 격리를 끈 실행이면 조직 자리 링크 → 돌 제품 폴더 → 프로세스 시작. 준비 중에 취소하면 시작한
// 파일 작업은 끝내고 프로세스는 띄우지 않는다. 링크를 만들 수 없는 컴퓨터에서도 격리 실행은 조직 제품 폴더로만 돈다.

/** 띄운 프로세스(이 컴퓨터의 프로그램이나 docker)의 명령. 실제로 프로세스를 시작했는지 여기서 본다. */
const spawned: string[][] = [];
vi.mock("cross-spawn", async (importOriginal) => {
  const actual = await importOriginal<{
    default: (...args: unknown[]) => unknown;
  }>();
  const spawn = (command: string, args: string[] = [], ...rest: unknown[]) => {
    spawned.push([command, ...args]);
    return actual.default(command, args, ...rest);
  };
  return { ...actual, default: Object.assign(spawn, actual.default) };
});

/** 붙잡아 둘 파일 작업 하나. 그 작업에 들어오면 알리고, 풀어 줄 때까지 기다린 뒤 실제로 한다. */
type Gate = {
  operation: "symlink" | "writeFile" | "rename";
  matches: (file: string) => boolean;
  entered: (file: string) => void;
  held: Promise<void>;
};
let gate: Gate | undefined;
/**
 * 로그인 옮기기와 중계 읽기의 경합 순간을 정하는 끼움(#209). `afterRename`은 그 rename을 한 뒤 돌려주기 전에 기다려 다음 작업을
 * 붙잡고, `onRead`는 파일 읽기의 결과를 받아 돌려주기 전에 기다릴 것을 정한다.
 */
let race:
  | {
      afterRename?: (from: string) => Promise<void> | undefined;
      onRead?: (
        file: string,
        result: Promise<unknown>
      ) => Promise<void> | undefined;
    }
  | undefined;
/** 링크 만들기를 거절하는 오류 코드(권한 없는 Windows·링크를 모르는 파일 시스템). */
let refusal: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const hold = (operation: Gate["operation"], file: unknown) => {
    const current = gate;
    if (current?.operation !== operation || !current.matches(String(file)))
      return undefined;
    gate = undefined;
    current.entered(String(file));
    return current.held;
  };
  return {
    ...actual,
    symlink: (...args: Parameters<typeof actual.symlink>) => {
      if (refusal)
        return Promise.reject(
          Object.assign(new Error(`${refusal}: cannot link`), { code: refusal })
        );
      const held = hold("symlink", args[1]);
      return held
        ? held.then(() => actual.symlink(...args))
        : actual.symlink(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await hold("rename", args[0]);
      await actual.rename(...args);
      await race?.afterRename?.(String(args[0]));
    },
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      const result = actual.readFile(...args);
      const wait = race?.onRead?.(String(args[0]), result);
      return wait
        ? result.then(
            (value) => wait.then(() => value),
            (error: unknown) =>
              wait.then(() => {
                throw error;
              })
          )
        : result;
    }) as typeof actual.readFile,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      const held = hold("writeFile", args[0]);
      return held
        ? held.then(() => actual.writeFile(...args))
        : actual.writeFile(...args);
    },
  };
});

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  gate = undefined;
  refusal = null;
  spawned.length = 0;
  race = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const fixture = (name: string) => path.resolve("test-fixtures", name);
const listen = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
};
const control = (signal = new AbortController().signal) => ({
  signal,
  emit: async () => {},
});

type Create = (options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  container?: ContainerSettings;
  relay?: { upstream?: string; verified?: boolean };
}) => ProviderConnection;
const connections: {
  name: string;
  id: string;
  create: Create;
  /** 제품 폴더 안 로그인 자리. */
  place: string[];
  /** 로그인 전용 폴더의 원본 이름. */
  original: string;
  /** 잘못된 조직 ID를 받은 실행이 끝나는 방식. Codex는 던지고, Antigravity는 실패로 돌려준다(변경 전과 같음). */
  invalidOrganization: "throws" | "fails";
  /** 그 접근 토큰을 담은 연결의 로그인(합성)과, 중계가 그 로그인을 넣어 보내는 모델 요청 경로. */
  login: (access: string) => string;
  route: string;
}[] = [
  {
    name: "Codex (app-server)",
    id: "codex",
    create: createCodexProvider,
    place: ["auth.json"],
    original: "auth.json",
    invalidOrganization: "throws",
    login: (access) =>
      JSON.stringify({
        tokens: { access_token: access, account_id: "synthetic-account" },
      }),
    route: "/responses",
  },
  {
    name: "Codex (exec)",
    id: "codex",
    create: (options) => createCodexProvider({ ...options, mode: "exec" }),
    place: ["auth.json"],
    original: "auth.json",
    invalidOrganization: "throws",
    login: (access) =>
      JSON.stringify({
        tokens: { access_token: access, account_id: "synthetic-account" },
      }),
    route: "/responses",
  },
  {
    name: "Antigravity",
    id: "antigravity",
    create: createAntigravityProvider,
    place: [".gemini", "antigravity-cli", "antigravity-oauth-token"],
    original: "antigravity-oauth-token",
    invalidOrganization: "fails",
    login: (access) =>
      JSON.stringify({
        token: {
          access_token: access,
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    route: "/v1internal:streamGenerateContent",
  },
];

async function setup(connection: (typeof connections)[number]) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "babojubot-login-prep-"))
  );
  roots.push(root);
  // 받은 환경을 남기고 끝나는 프로그램. 프로바이더 실행은 실패하지만 프로세스를 띄웠는지·어느 폴더로 띄웠는지는 남는다.
  const script = path.join(root, "dump-env.cjs");
  const dump = path.join(root, "env.jsonl");
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
      JSON.stringify({ codex: dumper, agy: dumper }),
    ],
    image: "babojubot-runner-test",
    owner: "owner-test",
    relay: attachedRelayHub(),
  };
  const folder = path.join(root, "providers", connection.id);
  const original = path.join(folder, "login", connection.original);
  await mkdir(path.dirname(original), { recursive: true });
  await writeFile(original, '{"synthetic-login":1}', { mode: 0o600 });
  /** 모의 모델 서비스. 중계가 넣어 보낸 인증을 남기고 200으로 답한다. */
  const upstreamSeen: (string | undefined)[] = [];
  const upstream = await listen((req, res) => {
    upstreamSeen.push(req.headers.authorization);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const provider = connection.create({
    dataDir: root,
    command: dumper,
    container,
    relay: { upstream, verified: true },
  });
  /** 발급한 실행 시도 권한. */
  const grants: string[] = [];
  const relay = provider.credentialRelay as CredentialRelay;
  const grant = relay.grant.bind(relay);
  relay.grant = (scope) => {
    const issued = grant(scope);
    grants.push(issued.token);
    return issued;
  };
  /** 중계가 받은 요청을 넘긴 뒤 부르는 함수. 중계는 원본 읽기까지 이어서 하므로, 넘긴 직후에 읽기가 시작됐는지 볼 수 있다. */
  const handed: { then?: () => void } = {};
  const relayUrl = await listen((req, res) => {
    relay.handle(req, res);
    handed.then?.();
  });
  /** 중계에 그 권한으로 경로 밖 요청을 보낸 응답 코드. 살아 있는 권한이면 403(경로 거절), 거둔 권한이면 401이다. */
  const relayStatus = async (token: string) =>
    (
      await fetch(`${relayUrl}/not-a-route`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
    ).status;
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
  const organization = (organizationId: string) =>
    path.join(folder, "organizations", organizationId);
  const loginAt = (organizationId: string) =>
    path.join(organization(organizationId), ...connection.place);
  const dumps = async (): Promise<NodeJS.ProcessEnv[]> =>
    (await readFile(dump, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NodeJS.ProcessEnv);
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
  return {
    root,
    folder,
    original,
    /** 연결 폴더의 로그인 자리. 링크를 만들 수 없으면 원본이 여기 보통 파일로 있다. */
    connectionPlace: path.join(folder, ...connection.place),
    upstreamSeen,
    relay,
    relayUrl,
    handed,
    provider,
    grants,
    relayStatus,
    requestFor,
    organization,
    loginAt,
    dumps,
    runMounts,
  };
}

/** 그 파일 작업에 들어올 때까지 기다리게 붙잡는다. `release`를 부르면 그 작업을 실제로 한다. */
function holdAt(
  operation: Gate["operation"],
  matches: (file: string) => boolean
) {
  let release!: () => void;
  let entered!: (file: string) => void;
  // 준비가 그 작업에 끝내 들어오지 않으면 시험 시한까지 기다리지 않고 바로 실패한다.
  const reached = new Promise<string>((resolve, reject) => {
    const limit = setTimeout(
      () => reject(new Error(`no ${operation} reached the gate`)),
      10_000
    );
    entered = (file) => {
      clearTimeout(limit);
      resolve(file);
    };
  });
  gate = {
    operation,
    matches,
    entered,
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  return { reached, release };
}

const inside = (folder: string, file: string) => {
  const relative = path.relative(folder, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

// Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행).
const noIsolation = process.platform === "win32";

describe.each(connections)("$name", (connection) => {
  it("does not start the program when cancelled while the organization's login link is being made, and finishes the link first", async () => {
    const env = await setup(connection);
    const a = crypto.randomUUID();
    const held = holdAt("symlink", (file) => inside(env.organization(a), file));
    const cancel = new AbortController();
    const running = env.provider.adapter.execute(
      await env.requestFor(a),
      control(cancel.signal)
    );
    await held.reached;
    cancel.abort();
    held.release();
    const result = await running;
    expect(result.stopReason).toBe("cancelled");
    expect(spawned).toEqual([]);
    // 시작한 링크 작업은 끝났다. 조직 자리는 원본을 가리키고 원본은 그대로다.
    expect(await readlink(env.loginAt(a))).toBe(env.original);
    expect(await readFile(env.original, "utf8")).toBe('{"synthetic-login":1}');
    expect(
      (await readdir(path.dirname(env.loginAt(a)))).filter((name) =>
        name.endsWith(".link")
      )
    ).toEqual([]);
    // 다음 조직의 준비는 막히지 않는다.
    const b = crypto.randomUUID();
    await env.provider.adapter.execute(await env.requestFor(b), control());
    expect(spawned).toHaveLength(1);
    expect((await env.dumps()).map((one) => one.HOME)).toEqual([
      env.organization(b),
    ]);
  });

  it.skipIf(noIsolation)(
    "does not start the container when cancelled while the run's own login file is being written, takes the grant back and deletes the run's folder",
    async () => {
      const env = await setup(connection);
      const a = crypto.randomUUID();
      const held = holdAt("writeFile", (file) =>
        path.basename(path.dirname(file)).startsWith("babojubot-attempt-")
      );
      const cancel = new AbortController();
      const running = env.provider.adapter.execute(
        await env.requestFor(a, "container"),
        control(cancel.signal)
      );
      const attemptFile = await held.reached;
      expect(env.grants).toHaveLength(1);
      // 살아 있는 권한은 경로 밖 요청에서 거절(403)될 뿐 권한 오류가 아니다.
      expect(await env.relayStatus(env.grants[0]!)).toBe(403);
      cancel.abort();
      held.release();
      const result = await running;
      expect(result.stopReason).toBe("cancelled");
      expect(spawned).toEqual([]);
      expect(await env.relayStatus(env.grants[0]!)).toBe(401);
      await expect(stat(path.dirname(attemptFile))).rejects.toThrow();
      // 조직 폴더에는 권한이 남지 않고, 원본은 그대로다.
      const left = await readFile(env.loginAt(a), "utf8").catch(() => "");
      expect(left).not.toContain(env.grants[0]!);
      expect(await readFile(env.original, "utf8")).toBe(
        '{"synthetic-login":1}'
      );
      // 다음 조직의 준비는 막히지 않는다.
      await env.provider.adapter.execute(
        await env.requestFor(crypto.randomUUID(), "container"),
        control()
      );
      expect(spawned).toHaveLength(1);
    }
  );

  it.skipIf(noIsolation)(
    "runs an isolated attempt in the organization's product folder on a machine that cannot create links, with no connection folder, login folder or login in any mount",
    async () => {
      const env = await setup(connection);
      refusal = "EPERM";
      const a = crypto.randomUUID();
      await env.provider.adapter.execute(
        await env.requestFor(a, "container"),
        control()
      );
      const [mounts] = await env.runMounts();
      const sources = (mounts ?? []).map(
        (mount) => /source=([^,]+)/.exec(mount)![1]!
      );
      expect(sources.filter((source) => inside(env.folder, source))).toEqual([
        env.organization(a),
      ]);
      const holding: string[] = [];
      const look = async (at: string): Promise<void> => {
        const info = await lstat(at).catch(() => undefined);
        if (info?.isDirectory())
          for (const name of await readdir(at)) await look(path.join(at, name));
        else if (
          info?.isFile() &&
          (await readFile(at, "utf8")).includes("synthetic-login")
        )
          holding.push(at);
      };
      for (const source of sources) await look(source);
      expect(holding).toEqual([]);
      expect((await env.dumps()).map((one) => one.HOME)).toEqual([
        env.organization(a),
      ]);
    }
  );

  // #209: 중계는 이 컴퓨터의 실행이 읽는 연결의 로그인을 읽는다. 로그인을 원본 자리와 연결 폴더 자리 사이에서 옮기는 동안 온 요청은
  // 옮기기가 끝날 때까지 기다리고, 옮긴 자리의 로그인으로 간다.
  /** 중계에 모델 요청 하나를 보낸다. 중계가 요청을 넘겨받으면(원본 읽기를 시작하면) `handed`가 풀린다. */
  const relayRequest = (env: Awaited<ReturnType<typeof setup>>) => {
    const { token } = env.relay.grant({
      signal: new AbortController().signal,
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });
    const handed = new Promise<void>((resolve) => {
      env.handed.then = resolve;
    });
    const answer = fetch(`${env.relayUrl}${connection.route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    return { handed, answer };
  };

  it("sends a relay request that comes while the login is moved back to the login folder with that login, between the two renames of the move as well", async () => {
    const env = await setup(connection);
    // 링크를 만들 수 없던 동안 원본은 연결 폴더 자리의 보통 파일로 옮겨져 있었다. 링크를 만들 수 있게 되면 격리를 끈 실행의 준비가
    // 그 파일을 원본 자리로 옮기고(첫 rename) 그 자리에 원본을 가리키는 링크를 둔다(둘째 rename).
    await rm(env.original, { force: true });
    await mkdir(path.dirname(env.connectionPlace), { recursive: true });
    await writeFile(env.connectionPlace, connection.login("moving-access"), {
      mode: 0o600,
    });
    const first = holdAt("rename", (file) => file === env.connectionPlace);
    let firstDone!: () => void;
    const firstMoved = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    /** 두 rename 사이에 시작한 연결 자리 읽기. 둘째 rename 전에 끝나게 한다. */
    const between: Promise<unknown>[] = [];
    race = {
      // 첫 rename을 한 뒤 둘째 rename을 붙잡는다: 원본 자리에만 로그인이 있고 연결 자리는 비어 있다.
      afterRename: (from) =>
        from === env.connectionPlace ? (firstDone(), second) : undefined,
      onRead(file, result) {
        // 첫 rename 전에 시작한 원본 읽기는 첫 rename 뒤에 결과(없음)를 돌려준다.
        if (file === env.original) return firstMoved;
        if (file === env.connectionPlace)
          between.push(result.catch(() => undefined));
        return undefined;
      },
    };
    const running = env.provider.adapter.execute(
      await env.requestFor(crypto.randomUUID()),
      control()
    );
    await first.reached;
    const request = relayRequest(env);
    await request.handed;
    first.release();
    await firstMoved;
    // 그때까지 받은 읽기 결과가 이어 시작하는 읽기를 모두 시작하게 한 뒤, 그 읽기가 끝나야 둘째 rename을 한다.
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(between);
    releaseSecond();
    const response = await request.answer;
    expect(response.status).toBe(200);
    expect(env.upstreamSeen).toEqual(["Bearer moving-access"]);
    expect(env.relay.failed()).toBe(false);
    await running;
    expect(await readlink(env.connectionPlace)).toBe(env.original);
  });

  it("holds a relay request that comes while the login is moved to the connection folder when links become impossible, then sends it with that login", async () => {
    const env = await setup(connection);
    await writeFile(env.original, connection.login("moving-access"), {
      mode: 0o600,
    });
    refusal = "ENOTSUP";
    const held = holdAt("rename", (file) => file === env.original);
    const running = env.provider.adapter.execute(
      await env.requestFor(crypto.randomUUID()),
      control()
    );
    await held.reached;
    const request = relayRequest(env);
    await request.handed;
    held.release();
    const response = await request.answer;
    expect(response.status).toBe(200);
    expect(env.upstreamSeen).toEqual(["Bearer moving-access"]);
    expect(env.relay.failed()).toBe(false);
    await running;
    expect((await lstat(env.connectionPlace)).isFile()).toBe(true);
    await expect(stat(env.original)).rejects.toThrow();
  });

  it("refuses an organization id that is not one before touching any login file", async () => {
    const env = await setup(connection);
    // 연결 폴더에 바로 있는 예전 로그인. 준비가 시작되면 원본으로 옮겨진다.
    const older = path.join(env.folder, ...connection.place);
    await mkdir(path.dirname(older), { recursive: true });
    await writeFile(older, '{"older":1}');
    const input = await env.requestFor(crypto.randomUUID());
    input.identity.organizationId = "../escape";
    const running = env.provider.adapter.execute(input, control());
    if (connection.invalidOrganization === "throws")
      await expect(running).rejects.toThrow("organization id must be a UUID");
    else expect((await running).stopReason).toBe("failed");
    expect(spawned).toEqual([]);
    expect((await lstat(older)).isFile()).toBe(true);
    expect(await readFile(older, "utf8")).toBe('{"older":1}');
    expect(await readFile(env.original, "utf8")).toBe('{"synthetic-login":1}');
  });
});
