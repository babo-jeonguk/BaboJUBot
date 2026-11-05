import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  containerLaunch,
  createDockerEnvironment,
  type ContainerSettings,
  type DockerEnvironment,
} from "./container.ts";
import { startProcess } from "./process.ts";

// 실제 Docker가 있는 환경에서만 도는 격리 경계 검사(#102). Docker가 없으면 건너뛰고 그 사실을 출력한다.
// 이미지는 Node가 든 공개 이미지(기본 node:24-bookworm-slim, BABOJUBOT_TEST_CONTAINER_IMAGE로 바꿈)를 쓴다. 제품 공통 이미지 검사는 아니다.
const image =
  process.env.BABOJUBOT_TEST_CONTAINER_IMAGE || "node:24-bookworm-slim";
const docker = (args: string[], timeout = 60_000) =>
  execFileSync("docker", args, { encoding: "utf8", timeout, stdio: "pipe" });
const available = (() => {
  if (process.platform !== "linux") return false;
  try {
    docker(["info", "--format", "{{.ServerVersion}}"], 20_000);
    return true;
  } catch {
    return false;
  }
})();
if (!available)
  console.log(
    "[docker] Docker를 쓸 수 없어 격리 실행의 Docker 검사(폴더 권한·사용자 API·DB 차단·조직 도구 연결·컨테이너 제거)를 건너뜁니다."
  );

describe.skipIf(!available)("isolated runs on a real Docker engine", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const settings: ContainerSettings = {
    docker: ["docker"],
    image,
    network: `babojubot-test-${suffix}`,
    owner: `test-${suffix}`,
  };
  let environment: DockerEnvironment;
  let root: string;
  beforeAll(async () => {
    try {
      docker(["image", "inspect", image]);
    } catch {
      docker(["pull", image], 600_000);
    }
    environment = createDockerEnvironment(settings);
    root = await mkdtemp(path.join(tmpdir(), "babojubot-docker-"));
  }, 660_000);
  afterAll(async () => {
    await environment?.removeOrphans();
    try {
      docker(["network", "rm", settings.network]);
    } catch {
      /* 만들지 못했거나 이미 없다. */
    }
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  const containersOf = (owner: string) =>
    docker(["ps", "-aq", "--filter", `label=babojubot.owner=${owner}`]).trim();

  /** 컨테이너 안에서 node 스크립트를 돌려 마지막 JSON 줄을 받는다. */
  async function inContainer(
    script: string,
    options: {
      cwd: string;
      workspace?: Parameters<typeof containerLaunch>[1]["workspace"];
      home: string;
    }
  ) {
    const frames: unknown[] = [];
    const child = startProcess({
      command: ["unused"],
      args: ["-e", script],
      cwd: options.cwd,
      env: { HOME: options.home },
      container: containerLaunch(settings, {
        home: options.home,
        cwd: options.cwd,
        program: "node",
        workspace: options.workspace,
        identity: {
          runId: crypto.randomUUID(),
          organizationId: crypto.randomUUID(),
        },
      }),
      onFrame: async (frame) => {
        frames.push(frame);
      },
    });
    child.endInput();
    const done = await child.done;
    return { done, frame: frames.at(-1) as Record<string, unknown> };
  }

  it("lets an agent write only the organization folder, its own folder and its product folder, and read peers", async () => {
    await environment.prepareNetwork(AbortSignal.timeout(60_000));
    const org = path.join(root, "organizations/o/shared");
    const self = path.join(root, "organizations/o/agents/self");
    const peer = path.join(root, "organizations/o/agents/peer");
    const home = path.join(root, "providers/claude");
    const other = path.join(root, "organizations/other/shared");
    for (const folder of [org, self, peer, home, other])
      await mkdir(folder, { recursive: true });
    await writeFile(path.join(peer, "note.md"), "peer note");
    const script = `
      const fs = require("node:fs");
      const attempt = (fn) => { try { fn(); return "ok"; } catch (e) { return e.code ?? String(e); } };
      const result = {
        org: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(org, "a.txt"))}, "org")),
        self: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(self, "a.txt"))}, "self")),
        home: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(home, "a.txt"))}, "home")),
        peerWrite: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(peer, "a.txt"))}, "x")),
        peerRead: attempt(() => fs.readFileSync(${JSON.stringify(path.join(peer, "note.md"))}, "utf8")),
        otherOrg: attempt(() => fs.readdirSync(${JSON.stringify(other)})),
        etc: attempt(() => fs.writeFileSync("/etc/babojubot", "x")),
        socket: fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock"),
        uid: process.getuid(),
        venv: process.env.BABOJUBOT_VENV,
        github: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
      };
      console.log(JSON.stringify(result));
    `;
    const { done, frame } = await inContainer(script, {
      cwd: org,
      home,
      workspace: {
        cwd: org,
        organization: org,
        personal: self,
        peers: [{ agentId: crypto.randomUUID(), path: peer, access: "read" }],
      },
    });
    expect(done.code).toBe(0);
    expect(frame).toMatchObject({
      org: "ok",
      self: "ok",
      home: "ok",
      peerWrite: "EROFS",
      peerRead: "ok",
      otherOrg: "ENOENT",
      socket: false,
      uid: process.getuid!(),
      venv: path.join(org, ".venv"),
      github: false,
    });
    expect(frame.etc).not.toBe("ok");
    // 컨테이너가 쓴 파일은 이 컴퓨터의 조직 폴더에 남는다. 컨테이너는 끝나면 지워졌다.
    expect(await readFile(path.join(org, "a.txt"), "utf8")).toBe("org");
    expect(containersOf(settings.owner)).toBe("");
  }, 120_000);

  it("finds the user API and DB unreachable and the tools listener reachable, and catches a port opened to the network", async () => {
    const { gateway } = await environment.prepareNetwork(
      AbortSignal.timeout(60_000)
    );
    const servers: (http.Server | net.Server)[] = [];
    const listen = async (server: http.Server | net.Server, host: string) => {
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      return (server.address() as net.AddressInfo).port;
    };
    try {
      const api = await listen(
        http.createServer((_req, res) => res.end("{}")),
        "127.0.0.1"
      );
      const db = await listen(
        net.createServer((s) => s.end()),
        "127.0.0.1"
      );
      const tools = await listen(
        http.createServer((_req, res) => {
          res.statusCode = 404;
          res.end();
        }),
        gateway
      );
      // 양성 대조: 네트워크 쪽 주소에 연 포트와 모든 주소에 연 포트는 컨테이너에서 닿아야 한다(검사가 헛돌지 않음).
      // 모든 주소에 연 포트는 이 컴퓨터를 가리키는 별칭(host.docker.internal)으로도 닿는다.
      const exposed = await listen(
        http.createServer((_req, res) => res.end("{}")),
        gateway
      );
      const everywhere = await listen(
        http.createServer((_req, res) => res.end("{}")),
        "0.0.0.0"
      );
      const blocked = [gateway, "host.docker.internal"].flatMap((host) =>
        [api, db].map((port) => ({ host, port }))
      );
      const result = await environment.probe(
        {
          blocked: [
            ...blocked,
            { host: gateway, port: exposed },
            { host: "host.docker.internal", port: everywhere },
          ],
          tools: `http://${gateway}:${tools}`,
        },
        AbortSignal.timeout(90_000)
      );
      expect(result.toolsReached).toBe(true);
      expect(result.reached).toEqual(
        expect.arrayContaining([
          { host: gateway, port: exposed },
          { host: "host.docker.internal", port: everywhere },
        ])
      );
      expect(result.reached).toHaveLength(2);
      // 실행 시도 컨테이너끼리는 서로 닿지 않는 전용 bridge 네트워크다.
      expect(
        docker([
          "network",
          "inspect",
          settings.network,
          "--format",
          '{{.Driver}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{index .Labels "babojubot.owner"}}',
        ]).trim()
      ).toBe(`bridge false ${settings.owner}`);
      expect(containersOf(settings.owner)).toBe("");
    } finally {
      for (const server of servers) server.close();
    }
  }, 150_000);

  it("removes a container that ignores the stop signals as the last step of cancellation", async () => {
    const home = path.join(root, "providers/stubborn");
    await mkdir(home, { recursive: true });
    const started = Date.now();
    const child = startProcess({
      command: ["unused"],
      args: [
        "-e",
        `process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); console.log(JSON.stringify({ ready: true })); setInterval(() => {}, 1000);`,
      ],
      cwd: home,
      env: { HOME: home },
      container: containerLaunch(settings, {
        home,
        cwd: home,
        program: "node",
      }),
      onFrame: async () => {
        child.end();
      },
    });
    const done = await child.done;
    expect(done.broken).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(containersOf(settings.owner)).toBe("");
  }, 120_000);

  it("removes only this product folder's leftover containers", async () => {
    const mine = docker([
      "run",
      "-d",
      "--label",
      `babojubot.owner=${settings.owner}`,
      image,
      "sleep",
      "300",
    ]).trim();
    const othersOwner = `${settings.owner}-other`;
    const theirs = docker([
      "run",
      "-d",
      "--label",
      `babojubot.owner=${othersOwner}`,
      image,
      "sleep",
      "300",
    ]).trim();
    try {
      await environment.removeOrphans();
      expect(containersOf(settings.owner)).toBe("");
      expect(containersOf(othersOwner)).toBe(theirs.slice(0, 12));
    } finally {
      for (const id of [mine, theirs])
        try {
          docker(["rm", "-f", id]);
        } catch {
          /* already removed */
        }
    }
  }, 120_000);
});
