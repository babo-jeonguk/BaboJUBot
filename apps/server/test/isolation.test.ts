import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  organizationDetailSchema,
  providerSettingsSchema,
  runSummaryListSchema,
  type ProviderConnection,
  type RunRequest,
} from "@babojubot/contracts";
import {
  createFakeProviders,
  type DockerEnvironment,
  type IsolationProbe,
} from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { goal } from "./scenarios.ts";
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

/**
 * 실제 Docker 없이 쓰는 격리 환경. 전용 네트워크의 gateway는 127.0.0.2(이 컴퓨터의 다른 loopback 주소)로 두어
 * 조직 도구 전용 listener가 사용자 API(127.0.0.1)와 다른 주소·포트에 열리게 한다. 시험 컨테이너 대신 받은 목표를 남기고,
 * 조직 도구는 실제로 HTTP로 불러 닿는지 본다. 사용자 API·DB에 닿았는지는 `reached`로 정한다.
 */
function fakeDocker(
  options: {
    reached?: { host: string; port: number }[];
    broken?: boolean;
  } = {}
) {
  const probes: IsolationProbe[] = [];
  const docker: DockerEnvironment = {
    settings: {
      docker: ["docker"],
      image: "babojubot-runner-test",
      network: "babojubot-test",
      owner: "owner-test",
    },
    async prepareNetwork() {
      if (options.broken)
        throw new Error("Cannot connect to the Docker daemon");
      return { gateway: "127.0.0.2" };
    },
    async probe(input) {
      probes.push(input);
      const tools = await fetch(new URL("/api/tools/mcp", input.tools), {
        method: "POST",
      }).then(
        () => true,
        () => false
      );
      return { reached: options.reached ?? [], toolsReached: tools };
    },
    async removeOrphans() {},
  };
  return { docker, probes };
}

/** 프로그램을 띄우는 실제 연결 자리(`isolatable`). 받은 요청을 남기고 가짜 프로바이더 시나리오로 끝낸다. */
function realConnection(onRequest?: (request: RunRequest) => Promise<void>): {
  connection: ProviderConnection;
  received: RunRequest[];
} {
  const [fake] = createFakeProviders(1);
  const received: RunRequest[] = [];
  return {
    received,
    connection: {
      ...fake!,
      id: "real",
      label: "실제 연결",
      isolatable: true,
      adapter: {
        ...fake!.adapter,
        async execute(request, control) {
          received.push(request);
          await onRequest?.(request);
          return fake!.adapter.execute(request, control);
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
  it("run real connections in a container whose organization tools go through a dedicated listener, not the user API", async () => {
    const checks: { health: number; settings: number; tools: number }[] = [];
    const { connection, received } = realConnection(async (request) => {
      if (request.execution !== "container") return;
      const base = request.access.toolsBaseUrl;
      const auth = { authorization: `Bearer ${request.access.token}` };
      checks.push({
        health: (await fetch(new URL("/api/health", base))).status,
        settings: (await fetch(new URL("/api/providers", base))).status,
        tools: (
          await fetch(new URL("/api/tools/mcp", base), {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
            }),
          })
        ).status,
      });
    });
    const { docker, probes } = fakeDocker();
    t = await startTestServer({
      providers: [...createFakeProviders(1), connection],
      isolation: { docker, protectedPorts: [54329] },
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
    const tools = new URL(isolated.access.toolsBaseUrl);
    expect(tools.hostname).toBe("127.0.0.2");
    expect(tools.origin).not.toBe(t.baseUrl);
    // 전용 listener에는 조직 도구만 있다. 사용자 경로는 없다.
    expect(checks).toEqual([{ health: 404, settings: 404, tools: 200 }]);
    expect((await runsOf(org.id))[0]!.status).toBe("completed");

    // 안전 확인은 사용자 API와 DB 포트를 막혀야 할 곳으로, 전용 listener를 닿아야 할 곳으로 시험했다.
    expect(probes.length).toBeGreaterThan(0);
    const probe = probes.at(-1)!;
    const apiPort = Number(new URL(t.baseUrl).port);
    expect(probe.blocked).toEqual(
      expect.arrayContaining([
        { host: "127.0.0.2", port: apiPort },
        { host: "127.0.0.2", port: 54329 },
        { host: "host.docker.internal", port: apiPort },
        { host: "host.docker.internal", port: 54329 },
      ])
    );
    expect(new URL(probe.tools).origin).toBe(tools.origin);
  });

  it.each([
    {
      name: "the test container reached the user API",
      docker: () =>
        fakeDocker({ reached: [{ host: "127.0.0.2", port: 1 }] }).docker,
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
