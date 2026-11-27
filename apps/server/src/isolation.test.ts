import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAntigravityProvider,
  createCodexProvider,
  createRelayHub,
  type CredentialRelay,
  type DockerEnvironment,
} from "@babojubot/runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { CredentialRelayEndpoint } from "@babojubot/contracts";
import { containerOwner, IsolationGate } from "./isolation.ts";
import {
  folderCleanup,
  ownedListener,
  releaseAcquired,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
import { insideFolder } from "@babojubot/process/test-support";

/**
 * 링크 만들기 거절(링크를 모르는 파일 시스템). 그 시험의 폴더(`in`, 시험이 만든 dataDir. 제품은 그 이름으로 경로를 만든다) 안에 링크를
 * 만들면 그 오류 코드로 거절하고, 거절한 링크 경로를 `failedAt`에 남긴다. 비어 있거나 다른 폴더의 링크는 실제로 만든다(#286).
 */
let refusal: { in: string; code: string; failedAt: string[] } | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: (...args: Parameters<typeof actual.symlink>) => {
      const fault = refusal;
      const [, link] = args;
      if (fault?.in === undefined || !insideFolder(fault.in, String(link)))
        return actual.symlink(...args);
      fault.failedAt.push(String(link));
      return Promise.reject(
        Object.assign(new Error(`${fault.code}: cannot link`), {
          code: fault.code,
        })
      );
    },
  };
});

let gate: IsolationGate | undefined;
afterEach(() => {
  refusal = null;
  const closing = gate;
  gate = undefined;
  return closing?.close();
});

/** Docker가 응답하지 않는 환경. 받은 중단 신호도 따르지 않는다(끝난 시험 컨테이너를 지우는 중 등). */
const unresponsive: DockerEnvironment = {
  settings: {
    docker: ["docker"],
    image: "babojubot-runner-test",
    owner: "owner-test",
    relay: createRelayHub(),
  },
  checkDaemon: () => new Promise(() => {}),
  probe: () => new Promise(() => {}),
  async removeOrphans() {},
};

/** 인증 중계를 흉내 낸다. 상태만 바꿀 수 있다. */
function relay(state: {
  verified: boolean;
  failed: boolean;
  readable?: boolean;
}) {
  const endpoint: CredentialRelayEndpoint & { recovered: number } = {
    recovered: 0,
    get verified() {
      return state.verified;
    },
    failed: () => state.failed,
    async recover() {
      endpoint.recovered++;
      if (state.readable) state.failed = false;
    },
    onFailure: () => () => {},
    handle: () => {},
  };
  return endpoint;
}
/** 검증된 인증 중계가 있는 실제 연결. */
const verified = {
  isolatable: true,
  credentialRelay: relay({ verified: true, failed: false }),
};

describe("IsolationGate", () => {
  // #148: 로그인 원본을 컨테이너에 넣지 않는다. 중계가 없거나 검증되지 않았거나 실패 상태면 Docker 확인 전에 막고 이 컴퓨터로도 돌리지 않는다.
  it("refuses an isolated run whose connection has no verified credential relay, or whose relay failed until a different login can be read", async () => {
    const asked: string[] = [];
    const docker: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {
        asked.push("checkDaemon");
      },
    };
    gate = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      // 복구 뒤에는 안전 확인으로 간다. 이 시험은 그 결과를 보지 않으므로 짧게 끝낸다.
      timeoutMs: 50,
    });
    for (const target of [
      { isolatable: true },
      {
        isolatable: true,
        credentialRelay: relay({ verified: false, failed: false }),
      },
    ]) {
      await expect(gate.readiness(target)).resolves.toEqual({
        status: "not_ready",
        reason: "credential_relay_unverified",
      });
      await expect(gate.place(target)).rejects.toThrow("검증되지 않아");
    }
    const state = { verified: true, failed: true, readable: false };
    const broken = { isolatable: true, credentialRelay: relay(state) };
    await expect(gate.place(broken)).rejects.toThrow("로그인을 쓰지 못해");
    await expect(gate.readiness(broken)).resolves.toEqual({
      status: "not_ready",
      reason: "credential_relay_failed",
    });
    expect(broken.credentialRelay.recovered).toBe(1);
    expect(asked).toEqual([]);
    // 사용자가 로그인을 고치고 다시 확인하면 풀린다(그 뒤로는 안전 확인으로 간다).
    state.readable = true;
    await gate.readiness(broken);
    expect(state.failed).toBe(false);
    expect(asked).toEqual(["checkDaemon"]);
    // 격리를 끄면 중계와 상관없이 지금처럼 이 컴퓨터에서 돈다.
    const off = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => false,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(off.place({ isolatable: true })).resolves.toEqual({
      toolsBaseUrl: "http://127.0.0.1:1",
    });
    await off.close();
  });

  // Windows에서는 격리 실행이 컨테이너를 띄우지 않으므로 지울 남은 컨테이너도 없다. 시작 정리도 Docker를 부르지 않는다
  // (docs/providers.md 격리 실행, 안전 확인과 같은 규칙). Docker가 없는 Windows에서 시작마다 정리 실패를 남기던 일이 있었다.
  it.each([
    ["win32", 0],
    ["linux", 1],
  ] as const)(
    "on %s asks Docker to remove leftover containers %i time(s) at start",
    async (platform, times) => {
      const removeOrphans = vi.fn(async () => {});
      gate = new IsolationGate({
        docker: { ...unresponsive, removeOrphans },
        protectedPorts: () => [5432],
        readIsolated: async () => true,
        hostUrl: () => "http://127.0.0.1:1",
        platform,
      });
      await gate.removeOrphans();
      expect(removeOrphans).toHaveBeenCalledTimes(times);
    }
  );

  // Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행). 격리를 켜면 Docker를 부르지 않고
  // 격리 환경 없음으로 두며, 이 컴퓨터로 대신 돌리지 않는다(PR #131 리뷰 3회차 P6).
  it("treats isolation as unavailable on Windows without asking Docker, and starts no run", async () => {
    const asked: string[] = [];
    const docker: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {
        asked.push("checkDaemon");
      },
      async probe() {
        asked.push("probe");
        return {
          interfaces: [],
          reached: [],
          proxied: [],
          toolsReached: true,
          unverified: [],
        };
      },
    };
    gate = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      platform: "win32",
    });
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    await expect(gate.place(verified)).rejects.toThrow(
      "격리 실행 환경이 안전한지 확인하지 못해 실행하지 않았습니다."
    );
    expect(asked).toEqual([]);
    // 격리가 꺼져 있으면 Windows에서도 지금처럼 이 컴퓨터에서 돈다.
    const off = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => false,
      hostUrl: () => "http://127.0.0.1:1",
      platform: "win32",
    });
    await expect(off.place(verified)).resolves.toEqual({
      toolsBaseUrl: "http://127.0.0.1:1",
    });
    await off.close();
  });

  it("tells a run that waits for an unfinished safety check, and not one whose result is already decided", async () => {
    gate = new IsolationGate({
      docker: unresponsive,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    const waiting = vi.fn();
    const placing = gate.place(verified, waiting);
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledTimes(1));
    // 닫으면 확인이 끝나 격리 환경 없음이 된다.
    await gate.close();
    await expect(placing).rejects.toThrow(
      "격리 실행 환경이 안전한지 확인하지 못해 실행하지 않았습니다."
    );
    // Windows는 Docker를 부르지 않고 바로 정하므로 기다림이 없다.
    const windows = new IsolationGate({
      docker: unresponsive,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      platform: "win32",
    });
    const immediate = vi.fn();
    await expect(windows.place(verified, immediate)).rejects.toThrow(
      "확인하지 못해"
    );
    expect(immediate).not.toHaveBeenCalled();
    await windows.close();
  });

  it("decides that the environment is unavailable when the safety check does not finish within its time", async () => {
    gate = new IsolationGate({
      docker: unresponsive,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      timeoutMs: 50,
    });
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    await expect(gate.place(verified)).rejects.toThrow(
      "격리 실행 환경이 안전한지 확인하지 못해 실행하지 않았습니다."
    );
  });

  it("ends a safety check still running when it closes and checks nothing afterwards", async () => {
    let asked = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let called!: () => void;
    const calledCheck = new Promise<void>((resolve) => {
      called = resolve;
    });
    // 받은 중단 신호를 따르지 않고 늦게 끝나는 Docker.
    const slow: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {
        asked++;
        called();
        await finished;
      },
      async probe() {
        return {
          interfaces: [],
          reached: [],
          proxied: [],
          toolsReached: true,
          unverified: [],
        };
      },
    };
    gate = new IsolationGate({
      docker: slow,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    const pending = gate.readiness(verified);
    await calledCheck;
    await gate.close();
    // 닫으면 진행 중인 확인은 결과를 기다리지 않고 끝난다.
    await expect(pending).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    finish();
    // 닫은 관문은 새 확인을 하지 않는다.
    gate.invalidate();
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    expect(asked).toBe(1);
  });

  it.each([
    [
      "the relay opened the user API",
      { proxied: [{ host: "127.0.0.1", port: 5432 }] },
    ],
    ["the container has a network device", { interfaces: ["eth0"] }],
    [
      "the container reached this computer directly",
      { reached: [{ host: "127.0.0.1", port: 5432 }] },
    ],
  ])("finds the environment unsafe when %s", async (_case, found) => {
    gate = new IsolationGate({
      docker: {
        ...unresponsive,
        async checkDaemon() {},
        async probe() {
          return {
            interfaces: [],
            reached: [],
            proxied: [],
            toolsReached: true,
            unverified: [],
            ...found,
          };
        },
      },
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unsafe",
    });
  });

  // 끝까지 확인하지 못한 검사가 있으면 결과를 모르는 것이다. 모를 때 안전한 쪽은 "안전"이 아니라 "확인 불가"다
  // (OWASP Fail Securely, #264 외부 리뷰 4회차 SPEC-3).
  it("finds the environment unavailable when a check could not be completed, even with nothing reached and the tools relay reached", async () => {
    gate = new IsolationGate({
      docker: {
        ...unresponsive,
        async checkDaemon() {},
        async probe() {
          return {
            interfaces: [],
            reached: [],
            proxied: [],
            toolsReached: true,
            unverified: ["proxied"],
          };
        },
      },
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
  });

  it("finds the environment unavailable when the tools relay is not reached (positive control)", async () => {
    gate = new IsolationGate({
      docker: {
        ...unresponsive,
        async checkDaemon() {},
        async probe() {
          return {
            interfaces: [],
            reached: [],
            proxied: [],
            toolsReached: false,
            unverified: [],
          };
        },
      },
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
  });
});

// #209: 링크를 만들 수 없는 컴퓨터에서도 로그인을 고친 뒤의 준비 확인이 중계 실패를 푼다. 중계는 이 컴퓨터의 실행이 읽는 로그인을 읽는다.
describe.each([
  {
    name: "Codex",
    id: "codex",
    create: createCodexProvider,
    place: ["auth.json"],
    login: JSON.stringify({
      tokens: { access_token: "fixed-access", account_id: "fixed-account" },
    }),
    route: "/responses",
  },
  {
    name: "Antigravity",
    id: "antigravity",
    create: createAntigravityProvider,
    place: [".gemini", "antigravity-cli", "antigravity-oauth-token"],
    login: JSON.stringify({
      token: {
        access_token: "fixed-access",
        expiry: new Date(Date.now() + 3_600_000).toISOString(),
      },
    }),
    route: "/v1internal:streamGenerateContent",
  },
])(
  "readiness of a $name connection on a machine that cannot create links",
  (connection) => {
    /** 안전 확인을 통과하는 Docker. */
    const safe: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {},
      async probe() {
        return {
          interfaces: [],
          reached: [],
          proxied: [],
          toolsReached: true,
          unverified: [],
        };
      },
    };
    async function failedRelay() {
      // 폴더는 만들기를 시작한 순간 정리에 맡기고, 그것을 쓰는 서버가 모두 닫힌 뒤에 지운다. 닫지 못한 서버가 있으면 폴더를 남기고 알린다.
      const making = mkdtemp(path.join(tmpdir(), "babojubot-gate-"));
      const cleanup = folderCleanup(() =>
        releaseAcquired(making, (folder) => removeFolderWithin(folder))
      );
      onTestFinished(cleanup.cleanUp);
      const dataDir = await making;
      // 서버의 닫기는 듣기 전에 폴더 정리에 맡긴다.
      const { server } = await ownedListener(
        http.createServer((_req, res) => res.writeHead(200).end()),
        { port: 0, host: "127.0.0.1" },
        (close) => cleanup.own(close),
        "the upstream server"
      );
      const provider = connection.create({
        dataDir,
        // 연결 확인은 프로그램을 띄우지 못하고(없는 프로그램) 끝난다. 로그인 자리 준비는 그 앞에서 한다.
        command: [path.join(dataDir, "no-such-program")],
        relay: {
          upstream: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
          verified: true,
        },
      });
      const relay = provider.credentialRelay as CredentialRelay;
      const target = { isolatable: true, credentialRelay: relay };
      gate = new IsolationGate({
        docker: safe,
        protectedPorts: () => [5432],
        readIsolated: async () => true,
        hostUrl: () => "http://127.0.0.1:1",
      });
      const fault = {
        in: dataDir,
        code: "EOPNOTSUPP",
        failedAt: [] as string[],
      };
      refusal = fault;
      const folder = path.join(dataDir, "providers", connection.id);
      // 이 컴퓨터가 링크를 만들 수 없다는 것은 연결 확인이 로그인 자리를 준비할 때 드러난다(서버의 준비 확인이 격리 관문 다음에 부르는
      // 그 확인. 아래 중계·관문·배치는 링크를 시도하지 않는다). 확인은 링크를 시도해 거절당하고, 링크 대신 연결 폴더의 자리를 쓰기로
      // 한다. 옮길 로그인이 아직 없어 그 자리는 빈 채로 남는다(링크로 바뀌지 않는다). 그래서 뒤에 그 자리에 쓰는 로그인은 보통 파일이다.
      // 거절이 실제로 그 자리 옆(그 자리의 폴더)의 링크에서 났는지, 대역이 받은 정확한 경로의 폴더로 본다.
      await provider.adapter.checkReadiness(AbortSignal.timeout(10_000));
      expect([
        ...new Set(fault.failedAt.map((link) => path.dirname(link))),
      ]).toEqual([path.dirname(path.join(folder, ...connection.place))]);
      // 로그인이 어디에도 없다. 격리 실행의 모델 요청이 중계 실패로 끝난다. 아래 세 단언(중계 503, 관문의 credential_relay_failed,
      // 배치 거절)은 이 로그인 없음을 본다. 링크 거절 때문에 나는 것이 아니다(거절은 옮길 로그인이 없어 바꾼 것이 없다). 서버의 닫기는
      // 듣기 전에 폴더 정리에 맡긴다(받은 연결을 먼저 끊는다).
      const { server: relayServer } = await ownedListener(
        http.createServer((req, res) => relay.handle(req, res)),
        { port: 0, host: "127.0.0.1" },
        (close) => cleanup.own(close),
        "the relay server"
      );
      const { token } = relay.grant({
        signal: new AbortController().signal,
        organizationId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
      });
      const port = (relayServer.address() as net.AddressInfo).port;
      const refused = await fetch(
        `http://127.0.0.1:${port}${connection.route}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "{}",
        }
      );
      expect(refused.status).toBe(503);
      await expect(gate.readiness(target)).resolves.toEqual({
        status: "not_ready",
        reason: "credential_relay_failed",
      });
      await expect(gate.place(target)).rejects.toThrow("로그인을 쓰지 못해");
      /** 연결 폴더의 로그인 자리. */
      const place = path.join(folder, ...connection.place);
      /** 다시 로그인한다. 로그인 명령은 연결 폴더에서 돌아 그 자리에 보통 파일로 쓴다(앞의 거절로 그 자리는 링크가 아니다). */
      const logIn = async () => {
        await mkdir(path.dirname(place), { recursive: true });
        await writeFile(place, connection.login, { mode: 0o600 });
      };
      const original = path.join(folder, "login", connection.place.at(-1)!);
      return { target, logIn, provider, original, place };
    }

    it("clears the relay failure on the check after logging in again at the connection folder's place, which stays a regular file with no login at the login folder, and lets the next isolated run start", async () => {
      const { target, logIn, original, place } = await failedRelay();
      // 링크 거절의 결과: 그 자리는 링크가 아니어서 다시 로그인한 파일이 그 자리의 보통 파일로 남고 원본으로 흘러가지 않는다. 링크를
      // 만들 수 있었다면 연결 확인이 그 자리를 원본을 가리키는 링크로 두어 로그인이 원본에 쓰인다. 원본이 없으므로 중계는 연결 폴더의
      // 자리를 읽어 회복하고, 회복과 배치 뒤에도 로그인은 그 자리에만 있다.
      await logIn();
      await expect(gate!.readiness(target)).resolves.toBeNull();
      await expect(gate!.place(target)).resolves.toMatchObject({
        execution: "container",
      });
      expect((await lstat(place)).isFile()).toBe(true);
      await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("clears the relay failure on the first check after links become possible, and keeps it clear once the check moves the login from the connection folder's place to the login folder", async () => {
      const { target, logIn, provider, original } = await failedRelay();
      await logIn();
      refusal = null;
      // 준비 확인은 격리 관문(중계 복구)을 먼저 보고 그다음 연결을 확인한다. 링크를 만들 수 있게 된 연결 확인이 연결 폴더 자리의 보통
      // 파일(링크를 만들 수 없던 동안 쓴 로그인)을 원본 자리로 옮기고 그 자리를 원본을 가리키는 링크로 둔다.
      await expect(gate!.readiness(target)).resolves.toBeNull();
      await provider.adapter.checkReadiness(AbortSignal.timeout(10_000));
      expect(await readFile(original, "utf8")).toBe(connection.login);
      await expect(gate!.readiness(target)).resolves.toBeNull();
      await expect(gate!.place(target)).resolves.toMatchObject({
        execution: "container",
      });
    });
  }
);

// 주인 표식은 제품 폴더 절대 경로의 SHA-256 앞 16자다. 기대값은 같은 함수가 아니라 셸에서 따로 계산했다:
// `printf '%s' '/srv/babojubot' | sha256sum`, `printf '%s' 'C:\Users\research\.babojubot' | sha256sum`.
// 서버 시작 시험(test/main.test.ts)은 이렇게 고정한 이 함수로 그 서버의 주인을 정한다.
it("names a product folder's containers by the first 16 characters of the SHA-256 of its path", () => {
  expect(containerOwner("/srv/babojubot")).toBe("dd9c37f4a36a85b3");
  expect(containerOwner("C:\\Users\\research\\.babojubot")).toBe(
    "acc4f2ce6e6d3f88"
  );
});
