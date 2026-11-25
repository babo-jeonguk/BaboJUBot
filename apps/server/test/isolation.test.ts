import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  eventListSchema,
  organizationDetailSchema,
  providerSettingsSchema,
  runSummaryListSchema,
  type ProviderConnection,
  type RunRequest,
  combinedFailure,
  failureCode,
  isDisconnect,
  attemptAll,
} from "@babojubot/contracts";
import {
  containerToolsOrigin,
  createCredentialRelay,
  createFakeProviders,
  createRelayHub,
  type DockerEnvironment,
  type IsolationProbe,
} from "@babojubot/runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { jsonBodyLimitBytes } from "../src/app.ts";

import { goal, scriptedAgents, serverHelpers } from "./scenarios.ts";
import {
  eventually,
  eventuallyMs,
  startTestServer,
  within,
  type TestServer,
  startOnDatabaseOf,
} from "./support.ts";
import {
  folderCleanup,
  ownedClosable,
  ownedListener,
  removeFolderWithin,
  withCleanup,
  ownedConnect,
} from "@babojubot/process/test-cleanup";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const settings = async () => {
  const res = await t!.request("GET", "/api/providers");
  expect(res.status).toBe(200);
  return providerSettingsSchema.parse(res.body);
};

describe("isolation switch", () => {
  it("is off by default and is saved at once when the owner turns it on and off", async () => {
    t = await startTestServer({ providers: createFakeProviders(1) });
    expect((await settings()).isolated).toBe(false);

    const watcher = await t.subscribe({ kind: "all" });
    const on = await t.request("PUT", "/api/providers/isolation", {
      isolated: true,
    });
    expect(on.status).toBe(200);
    expect(providerSettingsSchema.parse(on.body).isolated).toBe(true);
    expect((await settings()).isolated).toBe(true);
    // 다른 탭은 전역 설정 변경 신호로 다시 불러온다.
    expect((await watcher.received()).settingsSignals).toBeGreaterThan(0);
    watcher.close();

    const off = await t.request("PUT", "/api/providers/isolation", {
      isolated: false,
    });
    expect(off.status).toBe(200);
    expect((await settings()).isolated).toBe(false);
  });

  it("refuses a value that is not on or off", async () => {
    t = await startTestServer({ providers: createFakeProviders(1) });
    for (const body of [{ isolated: "yes" }, {}, { isolated: true, extra: 1 }])
      expect(
        (await t.request("PUT", "/api/providers/isolation", body)).status
      ).toBe(422);
    expect((await settings()).isolated).toBe(false);
  });

  it("keeps the saved value across a server restart", async () => {
    // 다시 띄운 서버는 시험 서버의 DB와 이 폴더를 쓴다. 시험 서버(DB)도 이 폴더도 다시 띄운 서버의 끝(한 번만 도는 같은 끝)을 확인한
    // 뒤에만 닫거나 지운다(`startOnDatabaseOf`, `folderCleanup`).
    const dataDir = await mkdtemp(path.join(tmpdir(), "babojubot-isolation-"));
    const folder = folderCleanup(() => removeFolderWithin(dataDir));
    onTestFinished(folder.cleanUp);
    t = await startTestServer({ providers: createFakeProviders(1) });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await t.stopServer();
    const first = t;
    const restarted = startOnDatabaseOf(
      first,
      { dataDir, providers: createFakeProviders(1) },
      "the restarted server"
    );
    t = undefined;
    // 다시 띄운 서버의 폴더도 그 서버의 끝(같은 결과)을 확인한 뒤에만 지운다.
    folder.own(restarted.stop);
    const again = await restarted.started;
    const res = await fetch(again.url + "/api/providers");
    expect(providerSettingsSchema.parse(await res.json()).isolated).toBe(true);
  });
});

/**
 * 중계 소켓으로 보낸 요청 하나의 답을 상한 안에서 기다린다. `answered`가 답을 받는 법을 정하고, 요청 오류·상한은 실패다. 요청은
 * 만든 직후 정리에 맡겨져 있어(`ownedClosable`), 상한이 지나도 그 정리가 끊고 닫힘을 확인한다.
 */
async function untilAnswered<T>(
  request: http.ClientRequest,
  answered: (
    resolve: (value: T) => void,
    reject: (error: unknown) => void
  ) => void,
  what: string
) {
  return within(
    new Promise<T>((resolve, reject) => {
      request.on("error", reject);
      answered(resolve, reject);
    }),
    eventuallyMs,
    `${what} over the relay socket did not answer`
  );
}

/**
 * 중계 폴더의 파일 소켓으로 HTTP 요청을 보낸다(컨테이너 안 시작 프로그램이 잇는 길과 같다). 답을 끝까지 받는다(`untilAnswered`). 응답 도중
 * 끊기면 `end` 대신 오류가 오므로 받은 데까지의 본문을 답으로 내주지 않는다.
 */
function overSocket(
  own: (step: () => Promise<void>) => void,
  socketPath: string,
  route: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  const method = init.method ?? "GET";
  // 연결을 다시 쓰지 않는다(`agent: false`). 답을 받으면 연결도 닫혀 중계 소켓에 남지 않는다.
  const request = ownedClosable(
    own,
    http.request({
      socketPath,
      path: route,
      method,
      headers: init.headers ?? {},
      agent: false,
    }),
    `${method} ${route} over the relay socket`
  );
  return untilAnswered<{ status: number; type: string; body: string }>(
    request,
    (resolve, reject) => {
      request.on("response", (res) => {
        let body = "";
        res.on("error", reject);
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            type: String(res.headers["content-type"] ?? ""),
            body,
          })
        );
      });
      request.end(init.body);
    },
    `${method} ${route}`
  );
}

/**
 * 컨테이너 쪽처럼 egress.sock에 CONNECT를 보내고 중계의 답을 판정하지 않고 그대로 돌려준다: node:http가 읽은 상태와 거부 이유
 * 머리(`x-babojubot-refusal`), 그 연결(`tunnel`). 연결은 만든 직후 `own`에 맡기고 CONNECT는 그 위에 탄다(`ownedConnect`, 터널은 그
 * 연결이다). `tunnel.closed`는 연결을 만든 순간부터 들은 닫힘이다(거절하지 않음). 답 머리를 다 읽기 전에 끊기거나 형식이 틀리면
 * 그 실패다.
 */
async function connectOver(
  own: (step: () => Promise<void>) => void,
  directory: string,
  target: string
) {
  const { response, socket, closed } = await ownedConnect(
    own,
    path.join(directory, "egress.sock"),
    target,
    { answerMs: eventuallyMs, what: `CONNECT ${target} over the relay socket` }
  );
  return {
    status: response.statusCode!,
    refusal: response.headers["x-babojubot-refusal"],
    tunnel: { socket, closed },
  };
}

/** 중계가 한 요청에 답한 것. 답 머리를 받았으면 상태(CONNECT는 거부 이유 머리도), 받기 전에 끝났으면 그 오류의 원인 코드다. */
type RelayAnswer =
  { status: number; refusal?: string | string[] } | { failed: string };

/**
 * 실제 Docker 없이 쓰는 격리 환경. 중계는 실제 것(서버가 정책·조직 도구를 붙임)이다. 확인마다 받은 목표를 남기고, 시험 컨테이너 대신
 * 그 중계 소켓으로 조직 도구와 금지 목적지를 실제로 불러 중계의 답을 판정하지 않고 그대로 `answers`에 남긴다.
 * 서버에 돌려주는 확인 결과는 중계의 답에서 판정한 것이 아니라 시험이 정한 값이다: 금지 목적지는 열리지 않았고(`proxied` 빈 목록)
 * 조직 도구에는 닿았으며(`toolsReached`), 직접 닿은 곳·네트워크 장치·확인 불가는 옵션으로 정한다(기본 없음). 중계 답의 판정은 제품의
 * 확인 스크립트가 맡고(runtime 시험), 중계가 실제로 어떻게 답했는지는 시험이 `answers`를 기대값과 직접 비교한다.
 */
function fakeDocker(
  options: {
    reached?: { host: string; port: number }[];
    interfaces?: string[];
    unverified?: string[];
    broken?: boolean;
  } = {}
) {
  const probes: IsolationProbe[] = [];
  const answers: {
    tools: RelayAnswer;
    forbidden: {
      target: { host: string; port: number };
      answer: RelayAnswer;
    }[];
  }[] = [];
  const relay = createRelayHub();
  const docker: DockerEnvironment = {
    settings: {
      docker: ["docker"],
      image: "babojubot-runner-test",
      owner: "owner-test",
      relay,
    },
    async checkDaemon() {
      if (options.broken)
        throw new Error("Cannot connect to the Docker daemon");
    },
    async probe(input) {
      probes.push(input);
      return withCleanup(async (defer) => {
        const opened = relay.open({
          identity: { organizationId: "isolation-probe" },
          required: input.forbidden.map(({ host, port }) => ({ host, port })),
        });
        defer(() => opened.close());
        await opened.ready;
        // 답 전에 끝난 오류는 접지 않고 원인 코드로 남긴다.
        const failed = (error: unknown): RelayAnswer => ({
          failed: failureCode(error),
        });
        const tools = await overSocket(
          defer,
          path.join(opened.directory, "tools.sock"),
          "/api/tools/mcp",
          { method: "POST" }
        ).then(({ status }): RelayAnswer => ({ status }), failed);
        const forbidden: (typeof answers)[number]["forbidden"] = [];
        for (const target of input.forbidden)
          forbidden.push({
            target,
            answer: await connectOver(
              defer,
              opened.directory,
              `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`
            ).then(({ status, refusal, tunnel }): RelayAnswer => {
              tunnel.socket.destroy();
              return { status, refusal };
            }, failed),
          });
        answers.push({ tools, forbidden });
        // 시험이 정한 값이다. 위의 답에서 판정하지 않는다.
        return {
          interfaces: options.interfaces ?? [],
          reached: options.reached ?? [],
          proxied: [],
          toolsReached: true,
          unverified: options.unverified ?? [],
        };
      });
    },
    async removeOrphans() {},
  };
  return { docker, probes, answers, relay };
}

/**
 * 프로그램을 띄우는 실제 연결 자리(`isolatable`). 받은 요청을 남기고 가짜 프로바이더 시나리오로 끝낸다.
 * 격리 실행이면 가짜 프로바이더가 컨테이너 안 프로그램 자리이므로, 그 조직 도구 호출도 이 실행 시도의 중계를 거친다
 * (컨테이너 안 시작 프로그램처럼 loopback 포트를 tools.sock에 잇는다).
 */
function realConnection(
  onRequest?: (request: RunRequest) => Promise<void>,
  relay?: () => ReturnType<typeof createRelayHub>,
  credential: { verified: boolean } = { verified: true }
): {
  connection: ProviderConnection;
  received: RunRequest[];
} {
  const [fake] = createFakeProviders(1);
  // 이 연결의 인증 중계(#148). 시험의 상류는 닿지 않는 주소이며, 권한 없는 요청은 상류 전에 거부된다.
  const credentialRelay = createCredentialRelay({
    profile: {
      upstream: "http://127.0.0.1:1",
      routes: [{ method: "POST", path: "/v1/messages" }],
      authorize: (credential) => ({
        headers: { authorization: `Bearer ${credential}` },
        secrets: [credential],
      }),
    },
    verified: credential.verified,
    credential: async () => "real-account-secret",
  });
  const received: RunRequest[] = [];
  return {
    received,
    connection: {
      ...fake!,
      id: "real",
      label: "실제 연결",
      isolatable: true,
      credentialRelay,
      adapter: {
        ...fake!.adapter,
        async execute(request, control) {
          received.push(request);
          await onRequest?.(request);
          if (request.execution !== "container" || !relay)
            return fake!.adapter.execute(request, control);
          return withCleanup(async (defer) => {
            const own = relay().open({
              identity: request.identity,
              required: [],
            });
            defer(() => own.close());
            await own.ready;
            // 컨테이너 안 시작 프로그램처럼 loopback 포트를 tools.sock에 잇는다. 이 실행 시도의 정리가 소유한다.
            // 다리가 받은 오류 가운데 상대가 떠난 끊김(`isDisconnect`)이 아닌 것은 기록해 두고, 다리를 닫는 같은 정리 단계가 그것들을
            // 원인으로 실패한다. 다리는 오류에 반대쪽을 끊으므로 연결을 쓰는 쪽에는 끊김만 보이고 원인은 여기에만 남는다.
            const unexpected = vi.fn<(error: Error) => void>();
            const noted = (error: Error) => {
              if (!isDisconnect(error)) unexpected(error);
            };
            const { server: bridge } = await ownedListener(
              net.createServer((client) => {
                const upstream = net.connect(
                  path.join(own.directory, "tools.sock")
                );
                // 한쪽이 끝나면 다른 쪽도 끊는다. 다리를 닫을 때 받은 연결(`client`)을 끊으면 그 상류도 함께 끝난다.
                client.once("close", () => upstream.destroy());
                upstream.once("close", () => client.destroy());
                client.on("error", (error) => {
                  noted(error);
                  upstream.destroy();
                });
                upstream.on("error", (error) => {
                  noted(error);
                  client.destroy();
                });
                client.pipe(upstream).pipe(client);
              }),
              { port: 0, host: "127.0.0.1" },
              (close) =>
                // 다리 닫기와 기록한 오류 알리기는 서로 무관하다. 닫기가 실패해도 기록한 오류를 함께 알린다.
                defer(() =>
                  attemptAll([
                    close,
                    () => {
                      const errors = unexpected.mock.calls.map(
                        ([error]) => error
                      );
                      if (errors.length)
                        throw new Error(
                          "the tools bridge got connection errors",
                          {
                            cause: combinedFailure(
                              errors,
                              "the tools bridge got connection errors"
                            ),
                          }
                        );
                    },
                  ])
                ),
              "the tools bridge"
            );
            const port = (bridge.address() as net.AddressInfo).port;
            return await fake!.adapter.execute(
              {
                ...request,
                access: {
                  ...request.access,
                  toolsBaseUrl: `http://127.0.0.1:${port}`,
                },
              },
              control
            );
          });
        },
      },
    },
  };
}

const createOrganization = async (provider: string) => {
  const res = await t!.request("POST", "/api/organizations", {
    name: `격리 ${crypto.randomUUID().slice(0, 8)}`,
    ...goal,
    lead: { provider, model: null },
  });
  expect(res.status).toBe(201);
  return organizationDetailSchema.parse(res.body);
};
const runsOf = async (orgId: string) =>
  runSummaryListSchema.parse(
    (await t!.request("GET", `/api/organizations/${orgId}/runs`)).body
  );
const readinessOf = async (id: string) =>
  (await settings()).providers.find((p) => p.id === id)!.readiness;

// 중계의 CONNECT 답은 손으로 읽거나 정규식으로 접지 않고 node:http가 읽은 그대로(상태·거부 이유 머리) 돌려준다(#298 외부 리뷰 3회차
// SPEC-4). 실제 로컬 서버가 중계 소켓 자리에서 제품 중계와 같은 답을 보낸다. 200만 열림으로 읽으면 502(정책은 열었지만 목적지 연결 실패)와
// 주소 확인이 아닌 이유의 403이 "막힘"으로 접혔다.
describe("a CONNECT over the relay socket", () => {
  /**
   * `egress.sock` 자리에서 CONNECT마다 `answer`를 보내는 로컬 서버의 폴더. 폴더는 만든 직후, 서버 닫기는 서버를 만든 직후 시험 정리에
   * 맡긴다. 폴더는 그 안의 소켓 서버가 닫힌 것을 확인한 뒤에만 지운다(`folderCleanup`). 닫지 못하면 폴더를 남기고 그 실패를 알린다.
   */
  async function answering(answer: string) {
    const directory = await mkdtemp(path.join(tmpdir(), "babojubot-egress-"));
    const folder = folderCleanup(() => removeFolderWithin(directory));
    onTestFinished(folder.cleanUp);
    const server = http.createServer();
    server.on("connect", (_req, socket: net.Socket) => socket.end(answer));
    await ownedListener(
      server,
      { path: path.join(directory, "egress.sock") },
      folder.own,
      "the stand-in relay socket"
    );
    return directory;
  }

  it.each([
    {
      answered: "502 after the policy opened the destination",
      answer:
        "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      expected: { status: 502, refusal: undefined },
    },
    {
      answered: "403 for a reason other than the address check",
      answer:
        "HTTP/1.1 403 Forbidden\r\nX-BaboJUBot-Refusal: policy_unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      expected: { status: 403, refusal: "policy_unavailable" },
    },
  ])(
    "hands back the relay's answer as it was when it answered $answered",
    async ({ answer, expected }) => {
      const directory = await answering(answer);
      const { tunnel, ...answered } = await connectOver(
        onTestFinished,
        directory,
        "example.invalid:443"
      );
      tunnel.socket.destroy();
      expect(answered).toEqual(expected);
    }
  );
});

describe("isolated runs", () => {
  it("runs real connections in a container whose organization tools go only through that run's relay, not the user API", async () => {
    const fake = fakeDocker();
    const checks: Record<string, number>[] = [];
    const { connection, received } = realConnection(
      async (request) => {
        if (request.execution !== "container") return;
        // 컨테이너 안 시작 프로그램처럼 이 실행 시도의 중계 소켓으로 조직 도구를 부른다.
        await withCleanup(async (defer) => {
          const own = fake.relay.open({
            identity: request.identity,
            required: [],
          });
          defer(() => own.close());
          const other = fake.relay.open({
            identity: {
              organizationId: crypto.randomUUID(),
              agentId: crypto.randomUUID(),
              runId: crypto.randomUUID(),
            },
            required: [],
          });
          defer(() => other.close());
          await Promise.all([own.ready, other.ready]);
          const auth = { authorization: `Bearer ${request.access.token}` };
          const mcp = (directory: string) =>
            overSocket(
              defer,
              path.join(directory, "tools.sock"),
              "/api/tools/mcp",
              {
                method: "POST",
                headers: { ...auth, "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/list",
                }),
              }
            );
          const tools = path.join(own.directory, "tools.sock");
          checks.push({
            health: (await overSocket(defer, tools, "/api/health")).status,
            settings: (await overSocket(defer, tools, "/api/providers")).status,
            tools: (await mcp(own.directory)).status,
            // 다른 조직·실행 시도의 중계로는 이 실행 시도의 토큰을 쓰지 못한다.
            otherRelay: (await mcp(other.directory)).status,
            // 인증 중계도 이 경로에 있고, 실행 시도 권한이 없는 요청은 상류 전에 거부한다(#148).
            credentialRelay: (
              await overSocket(defer, tools, "/api/relay/real/v1/messages", {
                method: "POST",
                headers: auth,
              })
            ).status,
          });
        });
      },
      () => fake.relay
    );
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker: fake.docker, protectedPorts: [54329] },
    });

    // 꺼져 있으면 지금처럼 이 컴퓨터에서 돌고 조직 도구는 사용자 API 주소다.
    const before = await createOrganization("real");
    await t.drain();
    expect(received).toHaveLength(1);
    expect(received[0]!.execution ?? "host").toBe("host");
    expect(new URL(received[0]!.access.toolsBaseUrl).origin).toBe(t.baseUrl);
    expect((await runsOf(before.id))[0]!.status).toBe("completed");

    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"), eventually)
      .toMatchObject({ checking: false });
    expect((await readinessOf("real")).reason ?? "").not.toMatch(/^isolation_/);

    const org = await createOrganization("real");
    await t.drain();
    expect(received).toHaveLength(2);
    const isolated = received[1]!;
    expect(isolated.execution).toBe("container");
    // 컨테이너 안에서 본 주소다. 이 컴퓨터에는 조직 도구 listener가 따로 없다.
    expect(isolated.access.toolsBaseUrl).toBe(containerToolsOrigin);
    // 중계에는 조직 도구만 있다. 사용자 경로는 없다.
    expect(checks).toEqual([
      {
        health: 404,
        settings: 404,
        tools: 200,
        otherRelay: 401,
        credentialRelay: 401,
      },
    ]);
    // 사용자 API에는 인증 중계가 없다.
    expect(
      (
        await fetch(new URL("/api/relay/real/v1/messages", t.baseUrl), {
          method: "POST",
        })
      ).status
    ).toBe(404);
    expect((await runsOf(org.id))[0]!.status).toBe("completed");

    // 안전 확인은 사용자 API와 DB 포트를 직접·중계 양쪽에서 막혀야 할 곳으로 시험했다.
    expect(fake.probes.length).toBeGreaterThan(0);
    // 그때 서버가 붙인 중계는 금지 목적지마다 주소 확인으로 거부했고(502·다른 이유의 거부가 아님), 조직 도구는 HTTP로 답했다.
    // 가짜 Docker가 서버에 돌려준 확인 결과는 시험이 정한 값이라, 중계의 실제 답은 여기서 기대값과 직접 비교한다.
    expect(fake.answers).toHaveLength(fake.probes.length);
    for (const [index, { tools, forbidden }] of fake.answers.entries()) {
      expect(tools).toEqual({ status: 401 });
      expect(forbidden).toEqual(
        fake.probes[index]!.forbidden.map((target) => ({
          target,
          answer: { status: 403, refusal: "address_not_allowed" },
        }))
      );
    }
    const probe = fake.probes.at(-1)!;
    const apiPort = Number(new URL(t.baseUrl).port);
    for (const list of [probe.blocked, probe.forbidden])
      expect(list).toEqual(
        expect.arrayContaining([
          { host: "127.0.0.1", port: apiPort },
          { host: "127.0.0.1", port: 54329 },
        ])
      );
  });

  // #148: 로그인 원본을 컨테이너에 넣지 않으므로, 기존 구독으로 검증된 인증 중계가 없는 연결은 격리를 켜면 준비안됨이고 실행 시도를 시작하지 않는다.
  it("shows a real connection without a verified credential relay as not ready under isolation and starts none of its runs", async () => {
    const fake = fakeDocker();
    const { connection, received } = realConnection(
      undefined,
      () => fake.relay,
      { verified: false }
    );
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker: fake.docker, protectedPorts: [54329] },
    });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"), eventually)
      .toMatchObject({
        status: "not_ready",
        reason: "credential_relay_unverified",
        checking: false,
      });
    const org = await createOrganization("real");
    await t.drain();
    expect(received).toEqual([]);
    const [run] = await runsOf(org.id);
    expect(run!.status).toBe("failed");
  });

  // 중계의 조직 도구도 사용자 API와 같은 서버 오류 처리를 거쳐 JSON 오류 계약으로 답한다(PR #131 리뷰 2회차 P4).
  it("answers a broken request through the relay with the same JSON error as the user API", async () => {
    const fake = fakeDocker();
    const answers: Record<
      string,
      { status: number; type: string; body: string }[]
    > = {};
    const { connection } = realConnection(async (request) => {
      const { token, toolsBaseUrl } = request.access;
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const bodies = [
        "{",
        JSON.stringify({ x: "가".repeat(jsonBodyLimitBytes) }),
      ];
      if (request.execution !== "container") {
        answers.host = [];
        for (const body of bodies) {
          const res = await fetch(
            new URL("/api/tools/artifacts", toolsBaseUrl),
            {
              method: "POST",
              headers,
              body,
            }
          );
          answers.host.push({
            status: res.status,
            type: res.headers.get("content-type") ?? "",
            body: await res.text(),
          });
        }
        return;
      }
      await withCleanup(async (defer) => {
        const own = fake.relay.open({
          identity: request.identity,
          required: [],
        });
        defer(() => own.close());
        await own.ready;
        answers.container = [];
        for (const body of bodies)
          answers.container.push(
            await overSocket(
              defer,
              path.join(own.directory, "tools.sock"),
              "/api/tools/artifacts",
              {
                method: "POST",
                headers,
                body,
              }
            )
          );
      });
    });
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker: fake.docker, protectedPorts: [54329] },
    });
    await createOrganization("real");
    await t.drain();
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"), eventually)
      .toMatchObject({ checking: false });
    await createOrganization("real");
    await t.drain();

    const json = expect.stringContaining("application/json");
    expect(answers.host).toEqual([
      {
        status: 400,
        type: json,
        body: JSON.stringify({ error: { code: "invalid_json" } }),
      },
      {
        status: 413,
        type: json,
        body: JSON.stringify({ error: { code: "body_too_large" } }),
      },
    ]);
    expect(answers.container).toEqual(answers.host);
  });

  it.each([
    {
      name: "the test container reached the user API directly",
      docker: () =>
        fakeDocker({ reached: [{ host: "127.0.0.1", port: 1 }] }).docker,
      reason: "isolation_unsafe",
    },
    {
      name: "the test container has a network device",
      docker: () => fakeDocker({ interfaces: ["eth0"] }).docker,
      reason: "isolation_unsafe",
    },
    {
      // 확인하지 못한 검사가 있으면 안전하다고 보지 않는다(fail closed, #264 외부 리뷰 4회차 SPEC-3).
      name: "the test container could not complete a check",
      docker: () => fakeDocker({ unverified: ["proxied"] }).docker,
      reason: "isolation_unavailable",
    },
    {
      name: "Docker does not answer",
      docker: () => fakeDocker({ broken: true }).docker,
      reason: "isolation_unavailable",
    },
    {
      name: "no Docker environment is set up",
      docker: () => undefined,
      reason: "isolation_unavailable",
    },
  ])(
    "marks every real connection not ready and starts no isolated run when $name",
    async ({ docker, reason }) => {
      const { connection, received } = realConnection();
      const environment = docker();
      t = await startTestServer({
        providers: [...createFakeProviders(1), connection],
        ...(environment && {
          isolation: { docker: environment, protectedPorts: [] },
        }),
      });
      await t.request("PUT", "/api/providers/isolation", { isolated: true });
      await expect
        .poll(() => readinessOf("real"), eventually)
        .toMatchObject({ status: "not_ready", reason, checking: false });
      // 가짜 연결은 프로그램을 띄우지 않으므로 격리와 상관없다.
      await expect
        .poll(() => readinessOf("fake"), eventually)
        .toMatchObject({ status: "ready", reason: null, checking: false });

      // 준비안됨이어도 고를 수 있지만, 안전하지 않은 구성으로는 컨테이너도 이 컴퓨터도 실행하지 않는다.
      const org = await createOrganization("real");
      await t.drain();
      expect(received).toEqual([]);
      const [run] = await runsOf(org.id);
      expect(run!.status).toBe("failed");
    }
  );

  it("turning isolation off runs on this machine again without a safety check", async () => {
    const { connection, received } = realConnection();
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: {
        docker: fakeDocker({ broken: true }).docker,
        protectedPorts: [],
      },
    });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"), eventually)
      .toMatchObject({ reason: "isolation_unavailable", checking: false });
    await t.request("PUT", "/api/providers/isolation", { isolated: false });
    await expect
      .poll(async () => (await readinessOf("real")).reason ?? "", eventually)
      .not.toMatch(/^isolation_/);
    const org = await createOrganization("real");
    await t.drain();
    expect(received).toHaveLength(1);
    expect(received[0]!.execution ?? "host").toBe("host");
    expect((await runsOf(org.id))[0]!.status).toBe("completed");
  });
});

describe("organization network allow list", () => {
  const { get, create, researching } = serverHelpers(() => t!);

  /** 연결 수를 세는 loopback echo listener. 시험 정리가 소유한다. */
  async function echo() {
    const accepted: net.Socket[] = [];
    const { server } = await ownedListener(
      net.createServer((socket) => {
        accepted.push(socket);
        socket.pipe(socket);
      }),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the echo listener"
    );
    return { port: (server.address() as net.AddressInfo).port, accepted };
  }

  it("is empty for a new organization and only the owner replaces it, normalized, leaving an Event", async () => {
    t = await startTestServer({ runtime: scriptedAgents().runtime });
    const org = await create("허용 목록 조직");
    expect(await get(`/api/organizations/${org.id}/network-policy`)).toEqual({
      destinations: [],
    });
    const put = (body: unknown) =>
      t!.request("PUT", `/api/organizations/${org.id}/network-policy`, body);
    const saved = await put({
      destinations: [
        { host: "API.Example.com.", port: 443 },
        { host: "api.example.com", port: 443 },
        { host: "models.lan", port: 8000, addresses: ["10.0.0.5", "10.0.0.5"] },
      ],
    });
    expect(saved.status).toBe(200);
    const expected = {
      destinations: [
        { host: "api.example.com", port: 443 },
        { host: "models.lan", port: 8000, addresses: ["10.0.0.5"] },
      ],
    };
    expect(saved.body).toEqual(expected);
    expect(await get(`/api/organizations/${org.id}/network-policy`)).toEqual(
      expected
    );
    // 그대로인 명령은 Event를 남기지 않는다.
    expect((await put(expected)).status).toBe(200);
    const changes = eventListSchema
      .parse(await get(`/api/organizations/${org.id}/events`))
      .filter((event) => event.type === "organization.network_policy_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toEqual({
      by: "owner",
      previous: [],
      ...expected,
    });

    for (const body of [
      { destinations: [{ host: "*.com", port: 443 }] },
      { destinations: [{ host: "a.com", port: 0 }] },
      {
        destinations: [
          { host: "a.com", port: 443, addresses: ["10.0.0.0/33"] },
        ],
      },
      {
        destinations: [{ host: "a.com", port: 443, addresses: ["0.0.0.0/0"] }],
      },
      {
        destinations: [{ host: "a.com", port: 443, addresses: ["10.0.0.0/8"] }],
      },
      { destinations: [{ host: "a.com" }] },
      {},
    ])
      expect((await put(body)).status, JSON.stringify(body)).toBe(422);
    expect(
      (
        await t.request(
          "PUT",
          `/api/organizations/${crypto.randomUUID()}/network-policy`,
          {
            destinations: [],
          }
        )
      ).status
    ).toBe(404);
    // 조직 도구에는 허용 목록을 바꾸는 길이 없다.
    expect(
      (await t.tool("no-token", "PUT", `/network-policy`, { destinations: [] }))
        .status
    ).not.toBe(200);
  });

  it("opens research destinations only after initial research approval, and closes connections the owner removes or the stage no longer allows", async () => {
    const agents = scriptedAgents();
    const fake = fakeDocker();
    t = await startTestServer({
      runtime: agents.runtime,
      isolation: { docker: fake.docker, protectedPorts: [] },
    });
    const target = await echo();
    const entry = {
      host: "localhost",
      port: target.port,
      addresses: ["127.0.0.1", "::1"],
    };
    // 연 중계는 바로 시험 정리에 맡긴다. 시험 안에서 먼저 닫아도 된다(닫기는 한 번만 돈다).
    const relayFor = (organizationId: string, agentId: string) => {
      const opened = fake.relay.open({
        identity: { organizationId, agentId, runId: crypto.randomUUID() },
        required: [],
      });
      onTestFinished(() => opened.close());
      return opened;
    };

    // 계획 수립 중에는 목록에 있어도 연구 목적지를 열지 않는다.
    const planning = await create("승인 전 조직");
    await t.request("PUT", `/api/organizations/${planning.id}/network-policy`, {
      destinations: [entry],
    });
    const early = relayFor(planning.id, planning.agents[0]!.id);
    await early.ready;
    const { tunnel: beforeApprovalTunnel, ...beforeApproval } =
      await connectOver(
        onTestFinished,
        early.directory,
        `localhost:${target.port}`
      );
    beforeApprovalTunnel.socket.destroy();
    expect(beforeApproval).toEqual({
      status: 403,
      refusal: "destination_not_allowed",
    });
    await early.close();

    const org = await researching(agents, "연구 조직");
    await t.request("PUT", `/api/organizations/${org.id}/network-policy`, {
      destinations: [entry],
    });
    const relay = relayFor(org.id, org.lead.id);
    await relay.ready;
    // 열린 터널은 이 시험의 정리가 소유한다(`connectOver`). 중계가 끊기를 기다리다 시험이 끝나도 남지 않는다.
    const open = await connectOver(
      onTestFinished,
      relay.directory,
      `localhost:${target.port}`
    );
    expect(open.status).toBe(200);
    // 다른 조직의 목록은 이 조직의 중계에 쓰이지 않는다.
    const other = relayFor(planning.id, planning.agents[0]!.id);
    await other.ready;
    const { tunnel: otherListTunnel, ...otherList } = await connectOver(
      onTestFinished,
      other.directory,
      `localhost:${target.port}`
    );
    otherListTunnel.socket.destroy();
    expect(otherList).toEqual({
      status: 403,
      refusal: "destination_not_allowed",
    });
    await other.close();

    // 목적지를 지우기 전에는 터널이 아직 열려 있다. 중계가 일찍 닫았으면 그 이유로 실패한다.
    expect(open.tunnel.socket.closed).toBe(false);
    expect(
      (
        await t.request("PUT", `/api/organizations/${org.id}/network-policy`, {
          destinations: [],
        })
      ).status
    ).toBe(200);
    await within(
      open.tunnel.closed,
      eventuallyMs,
      "the relay did not close the connection the owner removed"
    );
    const { tunnel: removedTunnel, ...removed } = await connectOver(
      onTestFinished,
      relay.directory,
      `localhost:${target.port}`
    );
    removedTunnel.socket.destroy();
    expect(removed).toEqual({
      status: 403,
      refusal: "destination_not_allowed",
    });
    expect(target.accepted).toHaveLength(1);

    // 단계가 바뀌어 연구 목적지가 닫혀도(중단) 열린 연결을 끊는다.
    await t.request("PUT", `/api/organizations/${org.id}/network-policy`, {
      destinations: [entry],
    });
    const again = await connectOver(
      onTestFinished,
      relay.directory,
      `localhost:${target.port}`
    );
    expect(again.status).toBe(200);
    // 멈추기 전에는 터널이 아직 열려 있다.
    expect(again.tunnel.socket.closed).toBe(false);
    expect(
      (await t.request("POST", `/api/organizations/${org.id}/stop`, {})).status
    ).toBe(200);
    await within(
      again.tunnel.closed,
      eventuallyMs,
      "the relay did not close the connection after the stop"
    );
    const { tunnel: afterStopTunnel, ...afterStop } = await connectOver(
      onTestFinished,
      relay.directory,
      `localhost:${target.port}`
    );
    afterStopTunnel.socket.destroy();
    expect(afterStop).toEqual({
      status: 403,
      refusal: "destination_not_allowed",
    });
    await relay.close();
  });

  it("shows a refused destination in the run's activity with the reason and how to allow it", async () => {
    const fake = fakeDocker();
    const answers: { status: number; refusal?: string | string[] }[] = [];
    const progressOf = async (orgId: string) =>
      eventListSchema
        .parse(await get(`/api/organizations/${orgId}/events`))
        .flatMap((event) =>
          event.type === "run.activity" &&
          event.payload.activity.source === "runtime" &&
          event.payload.activity.activity.type === "progress"
            ? [event.payload.activity.activity.text]
            : []
        );
    const refusal = expect.stringMatching(
      /^외부 연결 거부: example\.invalid:443\. .*네트워크 허용 목록/
    );
    const { connection } = realConnection(
      async (request) => {
        if (request.execution !== "container") return;
        await withCleanup(async (defer) => {
          const own = fake.relay.open({
            identity: request.identity,
            required: [],
          });
          defer(() => own.close());
          await own.ready;
          const { tunnel, ...answer } = await connectOver(
            defer,
            own.directory,
            "example.invalid:443"
          );
          tunnel.socket.destroy();
          answers.push(answer);
          // 거부 기록은 끝나지 않은 실행 시도에만 남는다. 기록이 실행 활동에 저장된 뒤에 실행을 끝낸다.
          await expect
            .poll(() => progressOf(request.identity.organizationId), eventually)
            .toContainEqual(refusal);
        });
      },
      () => fake.relay
    );
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker: fake.docker, protectedPorts: [] },
    });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"), eventually)
      .toMatchObject({ checking: false });
    const org = await createOrganization("real");
    await t.drain();
    expect(answers).toEqual([
      { status: 403, refusal: "destination_not_allowed" },
    ]);
    expect(await progressOf(org.id)).toContainEqual(refusal);
  });
});
