import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { destinationSchema, type RunRequest } from "@babojubot/contracts";
import {
  ContainerRefusal,
  createDockerEnvironment,
  placeAttempt,
  type AttemptContainer,
  type ContainerSettings,
  type DockerEnvironment,
} from "./container.ts";
import { startProcess } from "./process.ts";
import { createRelayHub } from "./relay.ts";

// 실제 Docker가 있는 환경에서만 도는 격리 경계 검사(#102, #149). Docker가 없으면 건너뛰고 그 사실을 출력한다.
// 이미지는 Node 공개 이미지(기본 node:24-bookworm-slim, BABOJUBOT_TEST_CONTAINER_BASE로 바꿈)에 제품의 시작 프로그램
// (docker/runner의 entry.sh·relay.mjs)만 얹어 만든다. 네 프로바이더가 든 제품 공통 이미지 검사는 아니다.
const base =
  process.env.BABOJUBOT_TEST_CONTAINER_BASE || "node:24-bookworm-slim";
const runnerDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docker/runner"
);
const docker = (args: string[], timeout = 60_000, input?: string) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout,
    stdio: "pipe",
    ...(input !== undefined ? { input } : {}),
  });
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
    "[docker] Docker를 쓸 수 없어 격리 실행의 Docker 검사(폴더 권한·신뢰된 시작 환경·네트워크 없음·중계·컨테이너 제거)를 건너뜁니다."
  );

describe.skipIf(!available)("isolated runs on a real Docker engine", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const image = `babojubot-runner-test-${suffix}`;
  const relays = createRelayHub();
  let research: unknown[] = [];
  let protectedPorts: number[] = [];
  relays.attach({
    research: async () =>
      research.map((entry) => destinationSchema.parse(entry)),
    tools: (_req, res) => {
      res.statusCode = 404;
      res.end();
    },
    protectedPorts: () => protectedPorts,
  });
  const settings: ContainerSettings = {
    docker: ["docker"],
    image,
    owner: `test-${suffix}`,
    relay: relays,
  };
  let environment: DockerEnvironment;
  let root: string;
  beforeAll(async () => {
    try {
      docker(["image", "inspect", base]);
    } catch {
      docker(["pull", base], 600_000);
    }
    docker(
      ["build", "-q", "-t", image, "-f", "-", runnerDir],
      600_000,
      [
        `FROM ${base}`,
        "COPY entry.sh /usr/local/bin/babojubot-entry",
        "COPY relay.mjs /usr/local/lib/babojubot/relay.mjs",
        "RUN chmod 0755 /usr/local/bin/babojubot-entry",
        'LABEL babojubot.runner="2"',
        'ENTRYPOINT ["/usr/local/bin/babojubot-entry"]',
      ].join("\n")
    );
    environment = createDockerEnvironment(settings);
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "babojubot-docker-"))
    );
  }, 660_000);
  afterAll(async () => {
    await environment?.removeOrphans();
    await relays.close();
    try {
      docker(["image", "rm", "-f", image]);
    } catch {
      /* 만들지 못했다. */
    }
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  const containersOf = (owner: string) =>
    docker(["ps", "-aq", "--filter", `label=babojubot.owner=${owner}`]).trim();

  /** 서버의 폴더 배치와 같은 조직 하나. */
  async function organization() {
    const id = crypto.randomUUID(),
      agent = crypto.randomUUID(),
      peer = crypto.randomUUID();
    const orgRoot = path.join(root, "organizations", id);
    const shared = path.join(orgRoot, "shared");
    const personal = path.join(orgRoot, "agents", agent);
    const peerFolder = path.join(orgRoot, "agents", peer);
    const home = path.join(root, "providers/claude/organizations", id);
    for (const folder of [shared, personal, peerFolder, home])
      await mkdir(folder, { recursive: true });
    const workspace: NonNullable<RunRequest["workspace"]> = {
      cwd: shared,
      organization: shared,
      personal,
      peers: [{ agentId: peer, path: peerFolder, access: "read" }],
    };
    const identity = {
      organizationId: id,
      agentId: agent,
      runId: crypto.randomUUID(),
    };
    return { id, shared, personal, peerFolder, home, workspace, identity };
  }
  type Organization = Awaited<ReturnType<typeof organization>>;

  const launchFor = (
    org: Organization,
    extra: Partial<AttemptContainer> = {}
  ) =>
    placeAttempt(settings, org.home, {
      execution: "container",
      workspace: org.workspace,
      identity: org.identity,
    })!.container!({ cwd: org.shared, program: "node", ...extra });

  /** 컨테이너 안에서 node 스크립트를 돌려 마지막 JSON 줄을 받는다. */
  async function inContainer(
    org: Organization,
    script: string,
    extra: Partial<AttemptContainer> = {},
    env: NodeJS.ProcessEnv = {}
  ) {
    const frames: unknown[] = [];
    const child = startProcess({
      command: ["unused"],
      args: ["-e", script],
      cwd: org.shared,
      env: { HOME: org.home, ...env },
      container: launchFor(org, extra),
      onFrame: async (frame) => {
        frames.push(frame);
      },
    });
    child.endInput();
    const done = await child.done;
    return { done, frame: frames.at(-1) as Record<string, unknown> };
  }

  it("lets an agent write only the organization folder, its own folder and its product folder, and read peers", async () => {
    const org = await organization();
    const other = await organization();
    await writeFile(path.join(other.shared, "sentinel.txt"), "other org");
    await writeFile(path.join(org.peerFolder, "note.md"), "peer note");
    const script = `
      const fs = require("node:fs");
      const os = require("node:os");
      const attempt = (fn) => { try { fn(); return "ok"; } catch (e) { return e.code ?? String(e); } };
      console.log(JSON.stringify({
        org: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(org.shared, "a.txt"))}, "org")),
        self: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(org.personal, "a.txt"))}, "self")),
        home: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(org.home, "a.txt"))}, "home")),
        peerWrite: attempt(() => fs.writeFileSync(${JSON.stringify(path.join(org.peerFolder, "a.txt"))}, "x")),
        peerRead: attempt(() => fs.readFileSync(${JSON.stringify(path.join(org.peerFolder, "note.md"))}, "utf8")),
        otherOrg: attempt(() => fs.readFileSync(${JSON.stringify(path.join(other.shared, "sentinel.txt"))}, "utf8")),
        relayWrite: attempt(() => fs.writeFileSync("/run/babojubot/x", "x")),
        etc: attempt(() => fs.writeFileSync("/etc/babojubot", "x")),
        socket: fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock"),
        uid: process.getuid(),
        venv: process.env.BABOJUBOT_VENV ?? null,
        personal: process.env.BABOJUBOT_PERSONAL,
        interfaces: Object.keys(os.networkInterfaces()),
        github: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
      }));
    `;
    const { done, frame } = await inContainer(org, script);
    expect(done.code).toBe(0);
    expect(frame).toMatchObject({
      org: "ok",
      self: "ok",
      home: "ok",
      peerWrite: "EROFS",
      peerRead: "ok",
      otherOrg: "ENOENT",
      relayWrite: "EROFS",
      socket: false,
      uid: process.getuid!(),
      venv: null,
      personal: org.personal,
      interfaces: ["lo"],
      github: false,
    });
    expect(frame.etc).not.toBe("ok");
    expect(await readFile(path.join(org.shared, "a.txt"), "utf8")).toBe("org");
    expect(containersOf(settings.owner)).toBe("");
  }, 120_000);

  it("starts the program and its child commands from the image, not from programs planted in shared folders, and runs a personal tool chosen explicitly", async () => {
    const org = await organization();
    const marker = path.join(org.shared, "planted-ran");
    const plant = async (file: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `#!/bin/sh\necho planted >> ${marker}\nexit 0\n`);
      await chmod(file, 0o755);
    };
    // 옛 시작 스크립트가 PATH 앞에 넣던 조직 폴더 가상환경, 제품 폴더(HOME)의 사용자 실행 파일 자리.
    for (const name of ["node", "python3", "python", "sh", "git"]) {
      await plant(path.join(org.shared, ".venv/bin", name));
      await plant(path.join(org.home, ".local/bin", name));
    }
    await mkdir(path.join(org.personal, "bin"), { recursive: true });
    await writeFile(
      path.join(org.personal, "bin/tool"),
      `#!/bin/sh\necho personal-tool\n`
    );
    await chmod(path.join(org.personal, "bin/tool"), 0o755);
    const script = `
      const { execSync } = require("node:child_process");
      console.log(JSON.stringify({
        node: process.execPath,
        child: execSync("node -e 'console.log(process.execPath)'").toString().trim(),
        shell: execSync("command -v sh").toString().trim(),
        personal: execSync('"$BABOJUBOT_PERSONAL/bin/tool"').toString().trim(),
        options: process.env.NODE_OPTIONS ?? null,
        preload: process.env.LD_PRELOAD ?? null,
        path: process.env.PATH,
      }));
    `;
    const { done, frame } = await inContainer(
      org,
      script,
      {},
      // 이 컴퓨터 환경에 끼어든 시작 설정도 넘기지 않는다.
      {
        NODE_OPTIONS: `--require ${path.join(org.shared, "x.js")}`,
        LD_PRELOAD: "/x.so",
      }
    );
    expect(done.code).toBe(0);
    expect(frame).toEqual({
      node: "/usr/local/bin/node",
      child: "/usr/local/bin/node",
      shell: "/usr/bin/sh",
      personal: "personal-tool",
      options: null,
      preload: null,
      path: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    });
    expect(existsSync(marker)).toBe(false);
    // 기존 공유 환경은 지우거나 옮기지 않는다.
    expect(existsSync(path.join(org.shared, ".venv/bin/node"))).toBe(true);
  }, 120_000);

  it("refuses a pre-planted link to another organization before any container starts", async () => {
    const org = await organization();
    const other = await organization();
    await rm(org.shared, { recursive: true });
    await symlink(other.shared, org.shared);
    const before = docker(["ps", "-aq"]).trim();
    expect(() => launchFor(org)).toThrow(ContainerRefusal);
    expect(docker(["ps", "-aq"]).trim()).toBe(before);
  }, 60_000);

  it("finds no network and no direct path to this computer, the relay refusing the user API and DB, and the tools relay reachable", async () => {
    await environment.checkDaemon(AbortSignal.timeout(60_000));
    const servers: net.Server[] = [];
    const accepted: number[] = [];
    const listen = async (host: string) => {
      const server = net.createServer((socket) => {
        accepted.push((server.address() as net.AddressInfo).port);
        socket.end();
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      return (server.address() as net.AddressInfo).port;
    };
    try {
      const api = await listen("127.0.0.1");
      const db = await listen("127.0.0.1");
      const everywhere = await listen("0.0.0.0");
      protectedPorts = [api, db];
      const hostAddresses = Object.values(os.networkInterfaces())
        .flatMap((list) => list ?? [])
        .filter((entry) => !entry.internal && entry.family === "IPv4")
        .map((entry) => entry.address);
      const targets = ["127.0.0.1", ...hostAddresses].flatMap((host) =>
        [api, db, everywhere].map((port) => ({ host, port }))
      );
      const result = await environment.probe(
        { blocked: targets, forbidden: targets },
        AbortSignal.timeout(90_000)
      );
      expect(result).toEqual({
        interfaces: [],
        reached: [],
        proxied: [],
        toolsReached: true,
      });
      // 금지 목적지의 listener는 연결을 한 번도 받지 않았다.
      expect(accepted).toEqual([]);
      expect(containersOf(settings.owner)).toBe("");
    } finally {
      protectedPorts = [];
      for (const server of servers) server.close();
    }
  }, 150_000);

  it("reaches an allowed destination only through the relay, and fails every bypass", async () => {
    const org = await organization();
    const hits: string[] = [];
    const allowed = http.createServer((req, res) => {
      hits.push(`allowed ${req.url}`);
      res.end("allowed-body");
    });
    const forbidden = http.createServer((req, res) => {
      hits.push(`forbidden ${req.url}`);
      res.end("x");
    });
    for (const server of [allowed, forbidden])
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
    const allowedPort = (allowed.address() as net.AddressInfo).port;
    const forbiddenPort = (forbidden.address() as net.AddressInfo).port;
    research = [
      { host: "localhost", port: allowedPort, addresses: ["127.0.0.1", "::1"] },
    ];
    const script = `
      const net = require("node:net");
      const dgram = require("node:dgram");
      const dns = require("node:dns");
      const viaProxy = (target, path) => new Promise((resolve) => {
        const s = net.connect(39280, "127.0.0.1");
        let text = "", sent = false;
        s.on("connect", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\n\\r\\n"));
        s.on("data", (d) => {
          text += d;
          if (!sent && /^HTTP\\/1\\.1 200[^]*\\r\\n\\r\\n/.test(text)) {
            sent = true;
            s.write("GET " + path + " HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n");
          }
        });
        s.on("close", () => resolve(text));
        s.on("error", (e) => resolve("error " + e.code));
        setTimeout(() => s.destroy(), 8000);
      });
      const direct = (host, port) => new Promise((resolve) => {
        const s = net.connect({ host, port });
        s.on("connect", () => { s.destroy(); resolve("connected"); });
        s.on("error", (e) => resolve(e.code));
        setTimeout(() => { s.destroy(); resolve("timeout"); }, 4000);
      });
      const udp = () => new Promise((resolve) => {
        const s = dgram.createSocket("udp4");
        s.send("x", 53, "8.8.8.8", (e) => { s.close(); resolve(e ? e.code : "sent"); });
      });
      (async () => {
        console.log(JSON.stringify({
          proxyEnv: process.env.HTTPS_PROXY,
          allowed: await viaProxy("localhost:${allowedPort}", "/ok"),
          otherPort: await viaProxy("localhost:${forbiddenPort}", "/no"),
          literal: await viaProxy("127.0.0.1:${allowedPort}", "/no"),
          directV4: await direct("127.0.0.1", ${allowedPort}),
          directLan: await direct("10.0.0.1", 80),
          directV6: await direct("::1", ${allowedPort}),
          udp: await udp(),
          dns: await new Promise((r) => dns.lookup("example.com", (e) => r(e ? e.code : "resolved"))),
        }));
      })();
    `;
    try {
      const { done, frame } = await inContainer(org, script);
      expect(done.code).toBe(0);
      expect(frame.proxyEnv).toBe("http://127.0.0.1:39280");
      expect(frame.allowed).toMatch(/^HTTP\/1\.1 200[^]*allowed-body/);
      expect(frame.otherPort).toMatch(
        /^HTTP\/1\.1 403[^]*destination_not_allowed/i
      );
      expect(frame.literal).toMatch(/^HTTP\/1\.1 403/);
      for (const key of ["directV4", "directLan", "directV6"])
        expect(frame[key], key).not.toBe("connected");
      expect(frame.udp).not.toBe("sent");
      expect(frame.dns).not.toBe("resolved");
      expect(hits).toEqual(["allowed /ok"]);
    } finally {
      research = [];
      allowed.close();
      forbidden.close();
    }
  }, 120_000);

  it("lets this computer call a server inside the container through the relay, the way OpenCode is controlled", async () => {
    const org = await organization();
    const results: string[] = [];
    const child = startProcess({
      command: ["unused"],
      args: [
        "-e",
        `require("node:http").createServer((q, s) => s.end("inside " + q.url)).listen(4096, "0.0.0.0", () => console.log(JSON.stringify({ url: "http://0.0.0.0:4096" })));`,
      ],
      cwd: org.shared,
      env: { HOME: org.home },
      container: launchFor(org, { inbound: 4096 }),
      onFrame: async () => {
        try {
          const origin = await child.inboundOrigin();
          results.push(await (await fetch(`${origin}/hello`)).text());
        } finally {
          child.end();
        }
      },
    });
    await child.done;
    expect(results).toEqual(["inside /hello"]);
    expect(containersOf(settings.owner)).toBe("");
  }, 120_000);

  it("removes a container that ignores the stop signals as the last step of cancellation", async () => {
    const org = await organization();
    const started = Date.now();
    const child = startProcess({
      command: ["unused"],
      args: [
        "-e",
        `process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); console.log(JSON.stringify({ ready: true })); setInterval(() => {}, 1000);`,
      ],
      cwd: org.shared,
      env: { HOME: org.home },
      container: launchFor(org),
      onFrame: async () => {
        child.end();
      },
    });
    const done = await child.done;
    expect(done.broken).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(containersOf(settings.owner)).toBe("");
  }, 120_000);

  it("shows an attempt's own file over the organization folder's file only inside that attempt's container", async () => {
    const org = await organization();
    await mkdir(path.join(org.shared, ".agents"), { recursive: true });
    const attempt = await mkdtemp(path.join(tmpdir(), "babojubot-attempt-"));
    const target = path.join(org.shared, ".agents/mcp_config.json");
    await writeFile(target, "placeholder");
    await writeFile(path.join(attempt, "mcp_config.json"), "attempt secret");
    const script = `const fs = require("node:fs");
      const file = ${JSON.stringify(target)};
      const content = fs.readFileSync(file, "utf8");
      let write;
      try { fs.writeFileSync(file, "changed"); write = "ok"; } catch (e) { write = e.code; }
      console.log(JSON.stringify({ content, write }));`;
    try {
      const own = await inContainer(org, script, {
        files: [{ source: path.join(attempt, "mcp_config.json"), target }],
      });
      expect(own.frame).toEqual({ content: "attempt secret", write: "EROFS" });
      expect(await readFile(target, "utf8")).toBe("placeholder");
      expect((await inContainer(org, script)).frame).toMatchObject({
        content: "placeholder",
      });
    } finally {
      await rm(attempt, { recursive: true, force: true });
    }
  }, 120_000);

  it("removes only this product folder's leftover containers", async () => {
    const run = (owner: string) =>
      docker([
        "run",
        "-d",
        "--network",
        "none",
        "--entrypoint",
        "sleep",
        "--label",
        `babojubot.owner=${owner}`,
        image,
        "300",
      ]).trim();
    const mine = run(settings.owner);
    const othersOwner = `${settings.owner}-other`;
    const theirs = run(othersOwner);
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
