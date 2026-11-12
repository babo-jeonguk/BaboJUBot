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
} from "@babojubot/contracts";
import {
  containerToolsOrigin,
  createCredentialRelay,
  createFakeProviders,
  createRelayHub,
  type DockerEnvironment,
  type IsolationProbe,
} from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { jsonBodyLimitBytes } from "../src/app.ts";
import { goal, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

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
    await expect.poll(() => watcher.settingsSignals()).toBeGreaterThan(0);
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
    t = await startTestServer({ providers: createFakeProviders(1) });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await t.stopServer();
    const db = t.db;
    const { startServer } = await import("../src/index.ts");
    const again = await startServer({
      db,
      port: 0,
      dataDir: await mkdtemp(path.join(tmpdir(), "babojubot-isolation-")),
      providers: createFakeProviders(1),
    });
    try {
      const res = await fetch(again.url + "/api/providers");
      expect(providerSettingsSchema.parse(await res.json()).isolated).toBe(
        true
      );
    } finally {
      await again.close();
    }
  });
});

/** 중계 폴더의 파일 소켓으로 HTTP 요청을 보낸다(컨테이너 안 시작 프로그램이 잇는 길과 같다). */
function overSocket(
  socketPath: string,
  route: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  return new Promise<{ status: number; type: string; body: string }>(
    (resolve, reject) => {
      const req = http.request({
        socketPath,
        path: route,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
      });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body,
          })
        );
      });
      req.on("error", reject);
      req.end(init.body);
    }
  );
}

/** 컨테이너 쪽처럼 egress.sock에 CONNECT를 보낸다. 열리면 소켓을 돌려준다. */
function connectOver(directory: string, target: string) {
  return new Promise<{ head: string; socket: net.Socket }>(
    (resolve, reject) => {
      const socket = net.connect(path.join(directory, "egress.sock"));
      let text = "";
      socket.once("error", reject);
      socket.on("connect", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`)
      );
      const onData = (chunk: Buffer) => {
        text += chunk.toString("latin1");
        if (!text.includes("\r\n\r\n")) return;
        socket.off("data", onData);
        resolve({ head: text, socket });
      };
      socket.on("data", onData);
    }
  );
}

/**
 * 실제 Docker 없이 쓰는 격리 환경. 중계는 실제 것(서버가 정책·조직 도구를 붙임)이고, 시험 컨테이너 대신
 * 받은 목표를 남기며 중계 소켓으로 조직 도구와 금지 목적지를 실제로 불러 본다. 직접 닿았는지·네트워크 장치는 옵션으로 정한다.
 */
function fakeDocker(
  options: {
    reached?: { host: string; port: number }[];
    interfaces?: string[];
    broken?: boolean;
  } = {}
) {
  const probes: IsolationProbe[] = [];
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
      const opened = relay.open({
        identity: { organizationId: "isolation-probe" },
        required: input.forbidden.map(({ host, port }) => ({ host, port })),
      });
      try {
        await opened.ready;
        const tools = await overSocket(
          path.join(opened.directory, "tools.sock"),
          "/api/tools/mcp",
          { method: "POST" }
        ).then(
          () => true,
          () => false
        );
        const proxied: { host: string; port: number }[] = [];
        for (const target of input.forbidden) {
          const { head, socket } = await connectOver(
            opened.directory,
            `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`
          );
          socket.destroy();
          if (/^HTTP\/1\.1 200/.test(head)) proxied.push(target);
        }
        return {
          interfaces: options.interfaces ?? [],
          reached: options.reached ?? [],
          proxied,
          toolsReached: tools,
        };
      } finally {
        await opened.close();
      }
    },
    async removeOrphans() {},
  };
  return { docker, probes, relay };
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
      authorize: (value) => ({ authorization: `Bearer ${value}` }),
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
          const own = relay().open({
            identity: request.identity,
            required: [],
          });
          const bridge = net.createServer((client) => {
            const upstream = net.connect(
              path.join(own.directory, "tools.sock")
            );
            client.on("error", () => upstream.destroy());
            upstream.on("error", () => client.destroy());
            client.pipe(upstream).pipe(client);
          });
          try {
            await own.ready;
            await new Promise<void>((resolve) =>
              bridge.listen(0, "127.0.0.1", resolve)
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
          } finally {
            bridge.close();
            await own.close();
          }
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

describe("isolated runs", () => {
  it("runs real connections in a container whose organization tools go only through that run's relay, not the user API", async () => {
    const fake = fakeDocker();
    const checks: Record<string, number>[] = [];
    const { connection, received } = realConnection(
      async (request) => {
        if (request.execution !== "container") return;
        // 컨테이너 안 시작 프로그램처럼 이 실행 시도의 중계 소켓으로 조직 도구를 부른다.
        const own = fake.relay.open({
          identity: request.identity,
          required: [],
        });
        const other = fake.relay.open({
          identity: {
            organizationId: crypto.randomUUID(),
            agentId: crypto.randomUUID(),
            runId: crypto.randomUUID(),
          },
          required: [],
        });
        try {
          await Promise.all([own.ready, other.ready]);
          const auth = { authorization: `Bearer ${request.access.token}` };
          const mcp = (directory: string) =>
            overSocket(path.join(directory, "tools.sock"), "/api/tools/mcp", {
              method: "POST",
              headers: { ...auth, "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
              }),
            });
          const tools = path.join(own.directory, "tools.sock");
          checks.push({
            health: (await overSocket(tools, "/api/health")).status,
            settings: (await overSocket(tools, "/api/providers")).status,
            tools: (await mcp(own.directory)).status,
            // 다른 조직·실행 시도의 중계로는 이 실행 시도의 토큰을 쓰지 못한다.
            otherRelay: (await mcp(other.directory)).status,
            // 인증 중계도 이 경로에 있고, 실행 시도 권한이 없는 요청은 상류 전에 거부한다(#148).
            credentialRelay: (
              await overSocket(tools, "/api/relay/real/v1/messages", {
                method: "POST",
                headers: auth,
              })
            ).status,
          });
        } finally {
          await Promise.all([own.close(), other.close()]);
        }
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
      .poll(() => readinessOf("real"))
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
      .poll(() => readinessOf("real"))
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
      const own = fake.relay.open({ identity: request.identity, required: [] });
      try {
        await own.ready;
        answers.container = [];
        for (const body of bodies)
          answers.container.push(
            await overSocket(
              path.join(own.directory, "tools.sock"),
              "/api/tools/artifacts",
              {
                method: "POST",
                headers,
                body,
              }
            )
          );
      } finally {
        await own.close();
      }
    });
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker: fake.docker, protectedPorts: [54329] },
    });
    await createOrganization("real");
    await t.drain();
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"))
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
        .poll(() => readinessOf("real"))
        .toMatchObject({ status: "not_ready", reason, checking: false });
      // 가짜 연결은 프로그램을 띄우지 않으므로 격리와 상관없다.
      await expect
        .poll(() => readinessOf("fake"))
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
      .poll(() => readinessOf("real"))
      .toMatchObject({ reason: "isolation_unavailable", checking: false });
    await t.request("PUT", "/api/providers/isolation", { isolated: false });
    await expect
      .poll(async () => (await readinessOf("real")).reason ?? "")
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

  /** 연결 수를 세는 loopback echo listener. */
  async function echo() {
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    return {
      port: (server.address() as net.AddressInfo).port,
      accepted,
      close: () => {
        for (const socket of accepted) socket.destroy();
        server.close();
      },
    };
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
    try {
      const entry = {
        host: "localhost",
        port: target.port,
        addresses: ["127.0.0.1", "::1"],
      };
      const relayFor = (organizationId: string, agentId: string) =>
        fake.relay.open({
          identity: { organizationId, agentId, runId: crypto.randomUUID() },
          required: [],
        });

      // 계획 수립 중에는 목록에 있어도 연구 목적지를 열지 않는다.
      const planning = await create("승인 전 조직");
      await t.request(
        "PUT",
        `/api/organizations/${planning.id}/network-policy`,
        {
          destinations: [entry],
        }
      );
      const early = relayFor(planning.id, planning.agents[0]!.id);
      await early.ready;
      expect(
        (await connectOver(early.directory, `localhost:${target.port}`)).head
      ).toMatch(/403[^]*destination_not_allowed/);
      await early.close();

      const org = await researching(agents, "연구 조직");
      await t.request("PUT", `/api/organizations/${org.id}/network-policy`, {
        destinations: [entry],
      });
      const relay = relayFor(org.id, org.lead.id);
      await relay.ready;
      const open = await connectOver(
        relay.directory,
        `localhost:${target.port}`
      );
      expect(open.head).toMatch(/^HTTP\/1\.1 200/);
      // 다른 조직의 목록은 이 조직의 중계에 쓰이지 않는다.
      const other = relayFor(planning.id, planning.agents[0]!.id);
      await other.ready;
      expect(
        (await connectOver(other.directory, `localhost:${target.port}`)).head
      ).toMatch(/403/);
      await other.close();

      const closed = new Promise<void>((resolve) =>
        open.socket.once("close", () => resolve())
      );
      expect(
        (
          await t.request(
            "PUT",
            `/api/organizations/${org.id}/network-policy`,
            {
              destinations: [],
            }
          )
        ).status
      ).toBe(200);
      await closed;
      expect(
        (await connectOver(relay.directory, `localhost:${target.port}`)).head
      ).toMatch(/403/);
      expect(target.accepted).toHaveLength(1);

      // 단계가 바뀌어 연구 목적지가 닫혀도(중단) 열린 연결을 끊는다.
      await t.request("PUT", `/api/organizations/${org.id}/network-policy`, {
        destinations: [entry],
      });
      const again = await connectOver(
        relay.directory,
        `localhost:${target.port}`
      );
      expect(again.head).toMatch(/^HTTP\/1\.1 200/);
      const stopped = new Promise<void>((resolve) =>
        again.socket.once("close", () => resolve())
      );
      expect(
        (await t.request("POST", `/api/organizations/${org.id}/stop`, {}))
          .status
      ).toBe(200);
      await stopped;
      expect(
        (await connectOver(relay.directory, `localhost:${target.port}`)).head
      ).toMatch(/403/);
      await relay.close();
    } finally {
      target.close();
    }
  });

  it("shows a refused destination in the run's activity with the reason and how to allow it", async () => {
    const fake = fakeDocker();
    const heads: string[] = [];
    const { connection } = realConnection(
      async (request) => {
        if (request.execution !== "container") return;
        const own = fake.relay.open({
          identity: request.identity,
          required: [],
        });
        try {
          await own.ready;
          const { head, socket } = await connectOver(
            own.directory,
            "example.invalid:443"
          );
          socket.destroy();
          heads.push(head);
          await new Promise((resolve) => setTimeout(resolve, 300));
        } finally {
          await own.close();
        }
      },
      () => fake.relay
    );
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker: fake.docker, protectedPorts: [] },
    });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await expect
      .poll(() => readinessOf("real"))
      .toMatchObject({ checking: false });
    const org = await createOrganization("real");
    await t.drain();
    expect(heads).toEqual([expect.stringMatching(/^HTTP\/1\.1 403/)]);
    const activities = eventListSchema
      .parse(await get(`/api/organizations/${org.id}/events`))
      .flatMap((event) =>
        event.type === "run.activity" &&
        event.payload.activity.source === "runtime" &&
        event.payload.activity.activity.type === "progress"
          ? [event.payload.activity.activity.text]
          : []
      );
    expect(activities).toContainEqual(
      expect.stringMatching(
        /^외부 연결 거부: example\.invalid:443\. .*네트워크 허용 목록/
      )
    );
  });
});
