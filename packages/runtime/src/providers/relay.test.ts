import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { destinationSchema, type Destination } from "@babojubot/contracts";
import { createRelayHub, type RelayHooks } from "./relay.ts";

// 격리 실행의 중계(#149). 컨테이너에는 네트워크가 없고, 실행 시도마다 연 파일 소켓으로만 바깥과 조직 도구에 닿는다.
// 여기서는 컨테이너 쪽 대신 시험이 그 소켓에 직접 붙는다. 금지 목적지는 실제 listener가 연결을 받지 않았는지까지 본다.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const destination = (value: unknown): Destination =>
  destinationSchema.parse(value);

/** 연결 수를 세는 loopback listener. echo하거나 HTTP로 답한다. */
async function fixture(kind: "echo" | "http") {
  const accepted: net.Socket[] = [];
  const server =
    kind === "http"
      ? http.createServer((req, res) =>
          res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
        )
      : net.createServer((socket) => socket.pipe(socket));
  server.on("connection", (socket: net.Socket) => accepted.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of accepted) socket.destroy();
        server.close(() => resolve());
      })
  );
  return { port: (server.address() as net.AddressInfo).port, accepted };
}

function hub(overrides: Partial<RelayHooks> = {}) {
  const refused: { host: string; port: number; reason: string }[] = [];
  let research: Destination[] = [];
  const relays = createRelayHub();
  relays.attach({
    research: async () => research,
    tools: (req, res) =>
      res.end(
        JSON.stringify({
          url: req.url,
          run: req.headers["x-babojubot-relay-run"],
          organization: req.headers["x-babojubot-relay-organization"],
        })
      ),
    protectedPorts: () => [],
    refused: (_identity, detail) => refused.push(detail),
    ...overrides,
  });
  cleanups.push(() => relays.close());
  return {
    relays,
    refused,
    setResearch: (value: Destination[]) => {
      research = value;
    },
  };
}

const identity = {
  organizationId: "00000000-0000-4000-8000-00000000000a",
  agentId: "00000000-0000-4000-8000-00000000000b",
  runId: "00000000-0000-4000-8000-00000000000c",
};

/** 컨테이너 쪽처럼 egress.sock에 CONNECT를 보내고 응답 머리를 받는다. */
function connectVia(directory: string, target: string) {
  return new Promise<{ head: string; socket: net.Socket }>(
    (resolve, reject) => {
      const socket = net.connect(path.join(directory, "egress.sock"));
      let buffer = "";
      socket.once("error", reject);
      socket.on("connect", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      );
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        resolve({
          head: buffer.slice(0, end + 4) + buffer.slice(end + 4),
          socket,
        });
      };
      socket.on("data", onData);
    }
  );
}

const roundTrip = (socket: net.Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString()));
    socket.write(text);
  });

const closed = (socket: net.Socket) =>
  new Promise<void>((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once("close", () => resolve());
  });

describe("isolated run relay", () => {
  it("tunnels an allowed destination and refuses others before any connection reaches them", async () => {
    const target = await fixture("echo");
    const { relays, refused } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const ok = await connectVia(relay.directory, `localhost:${target.port}`);
    expect(ok.head).toMatch(/^HTTP\/1\.1 200/);
    expect(await roundTrip(ok.socket, "ping")).toBe("ping");
    ok.socket.destroy();

    const before = target.accepted.length;
    const denied = await connectVia(
      relay.directory,
      `127.0.0.1:${target.port}`
    );
    expect(denied.head).toMatch(/^HTTP\/1\.1 403/);
    expect(denied.head).toMatch(
      /x-babojubot-refusal: destination_not_allowed/i
    );
    const otherPort = await connectVia(
      relay.directory,
      `localhost:${target.port + 1}`
    );
    expect(otherPort.head).toMatch(/destination_not_allowed/);
    expect(target.accepted.length).toBe(before);
    expect(refused).toEqual([
      {
        host: "127.0.0.1",
        port: target.port,
        reason: "destination_not_allowed",
      },
      {
        host: "localhost",
        port: target.port + 1,
        reason: "destination_not_allowed",
      },
    ]);
  });

  it("refuses an allowed name that resolves to this computer unless that address is listed", async () => {
    const target = await fixture("echo");
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [destination({ host: "localhost", port: target.port })],
    });
    await relay.ready;
    const denied = await connectVia(
      relay.directory,
      `localhost:${target.port}`
    );
    expect(denied.head).toMatch(/address_not_allowed/);
    expect(target.accepted.length).toBe(0);
  });

  it("never opens the user API or DB port, even when the user listed this computer", async () => {
    const target = await fixture("echo");
    const { relays } = hub({ protectedPorts: () => [target.port] });
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.0/8", "::1"],
        }),
      ],
    });
    await relay.ready;
    const denied = await connectVia(
      relay.directory,
      `localhost:${target.port}`
    );
    expect(denied.head).toMatch(/address_not_allowed/);
    expect(target.accepted.length).toBe(0);
  });

  it("forwards a plain HTTP proxy request to the checked address and keeps its Host", async () => {
    const target = await fixture("http");
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: `http://localhost:${target.port}/page?x=1`,
        headers: { host: `localhost:${target.port}` },
      });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({
      url: "/page?x=1",
      host: `localhost:${target.port}`,
    });
  });

  it("uses the organization's research list only as the policy hook gives it, and closes tunnels the user removes", async () => {
    const target = await fixture("echo");
    const { relays, refused, setResearch } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const entry = destination({
      host: "localhost",
      port: target.port,
      addresses: ["127.0.0.1", "::1"],
    });
    expect(
      (await connectVia(relay.directory, `localhost:${target.port}`)).head
    ).toMatch(/403/);
    setResearch([entry]);
    const open = await connectVia(relay.directory, `localhost:${target.port}`);
    expect(open.head).toMatch(/^HTTP\/1\.1 200/);
    setResearch([]);
    await relays.revalidate(identity.organizationId);
    await closed(open.socket);
    expect(refused.at(-1)).toEqual({
      host: "localhost",
      port: target.port,
      reason: "policy_changed",
    });
  });

  it("refuses when the policy cannot be read", async () => {
    const target = await fixture("echo");
    const { relays } = hub({
      research: async () => {
        throw new Error("db down");
      },
    });
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    expect(
      (await connectVia(relay.directory, `localhost:${target.port}`)).head
    ).toMatch(/policy_unavailable/);
    expect(target.accepted.length).toBe(0);
  });

  it("refuses requests that are not an HTTP proxy request", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "egress.sock"),
        path: "/relative",
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it("closes its tunnels and sockets when the run ends, so nothing can reuse them", async () => {
    const target = await fixture("echo");
    const { relays } = hub();
    const relay = relays.open({
      identity,
      required: [
        destination({
          host: "localhost",
          port: target.port,
          addresses: ["127.0.0.1", "::1"],
        }),
      ],
    });
    await relay.ready;
    const open = await connectVia(relay.directory, `localhost:${target.port}`);
    await relay.close();
    await closed(open.socket);
    expect(existsSync(path.join(relay.directory, "egress.sock"))).toBe(false);
    await expect(
      connectVia(relay.directory, `localhost:${target.port}`)
    ).rejects.toThrow();
  });

  it("passes organization tool requests to the tools handler with this run's identity, overriding what the container claims", async () => {
    const { relays } = hub();
    const relay = relays.open({ identity, required: [] });
    await relay.ready;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        socketPath: path.join(relay.directory, "tools.sock"),
        path: "/api/tools/mcp",
        headers: { "x-babojubot-relay-run": "someone-else" },
      });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({
      url: "/api/tools/mcp",
      run: identity.runId,
      organization: identity.organizationId,
    });
  });

  it("lets this computer reach a server inside the container through connections the container opened", async () => {
    const service = await fixture("http");
    const { relays } = hub();
    const relay = relays.open({ identity, required: [], inbound: true });
    await relay.ready;
    // 컨테이너 쪽: inbound.sock에 미리 붙어 있다가 첫 바이트가 오면 컨테이너 안 서버에 잇는다.
    const reverse = () => {
      const socket = net.connect(path.join(relay.directory, "inbound.sock"));
      socket.once("data", (first) => {
        const local = net.connect(service.port, "127.0.0.1", () => {
          local.write(first);
          socket.pipe(local).pipe(socket);
        });
        reverse();
      });
      cleanups.push(() => void socket.destroy());
    };
    reverse();
    const origin = await relay.inboundOrigin();
    const first = (await (await fetch(`${origin}/one`)).json()) as {
      url: string;
    };
    const second = (await (await fetch(`${origin}/two`)).json()) as {
      url: string;
    };
    expect([first.url, second.url]).toEqual(["/one", "/two"]);
  });

  it("does not open a relay before the server attached its policy", () => {
    const relays = createRelayHub();
    expect(() => relays.open({ identity, required: [] })).toThrow();
  });
});
