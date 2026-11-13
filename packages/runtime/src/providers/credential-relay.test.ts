import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialRelay,
  credentialResidue,
  type RelayProfile,
} from "./credential-relay.ts";
import { relayIdentityHeaders } from "./relay.ts";

// 인증 중계(#148)를 실제 HTTP로 시험한다. 상류는 이 컴퓨터의 모의 서버이며 받은 요청을 남긴다.

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };
const servers: http.Server[] = [];
const wires: { server: net.Server; sockets: Set<net.Socket> }[] = [];
afterEach(async () => {
  for (const wire of wires.splice(0)) {
    for (const socket of wire.sockets) socket.destroy();
    await new Promise((resolve) => wire.server.close(resolve));
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}
/** 서버에 열린 연결 수. */
const connections = (server: http.Server) =>
  new Promise<number>((resolve, reject) =>
    server.getConnections((error, count) =>
      error ? reject(error) : resolve(count)
    )
  );

/** 모의 상류. `/v1/stream`은 첫 조각을 보낸 뒤 닫힐 때까지 열어 둔다. */
async function upstream() {
  const seen: Seen[] = [];
  const closed: string[] = [];
  const url = await listen((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    req.resume();
    if (req.url?.startsWith("/base/v1/rejected")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid login" }));
      return;
    }
    if (req.url?.startsWith("/base/v1/unchanged")) {
      res.writeHead(304);
      res.end();
      return;
    }
    if (req.url?.startsWith("/base/v1/redirect")) {
      res.writeHead(302, { location: "https://elsewhere.invalid/" });
      res.end();
      return;
    }
    // 상류가 받은 인증을 그대로 돌려주는 경우. 중계가 붙인 원본이 프로그램에 돌아가면 안 된다.
    const echoed = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      ""
    );
    if (req.url?.startsWith("/base/v1/echo-header")) {
      res.writeHead(400, { "x-echo": `Bearer ${echoed}` });
      res.end("{}");
      return;
    }
    if (req.url?.startsWith("/base/v1/echo-error")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `invalid token ${echoed}` }));
      return;
    }
    if (req.url?.startsWith("/base/v1/echo-stream")) {
      // 원본이 두 조각에 걸쳐 온다.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: got ${echoed.slice(0, 6)}`);
      setTimeout(() => res.end(`${echoed.slice(6)} end\n\n`), 50);
      return;
    }
    if (req.url?.startsWith("/base/v1/compressed")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(JSON.stringify({ error: `invalid token ${echoed}` })));
      return;
    }
    if (req.url?.startsWith("/base/v1/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.on("close", () => closed.push(req.url!));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "session=upstream-cookie",
    });
    res.end(JSON.stringify({ ok: true }));
  });
  return { url: `${url}/base`, seen, closed, server: servers.at(-1)! };
}

/** 시험 요청마다 붙이는 이름. 중계는 이 header를 그대로 상류에 넘기므로, 상류가 받은 요청이 어느 요청인지 가린다. */
const requestTag = "x-test-request";
const tag = (name: string) => ({ [requestTag]: name });
/** 권한으로 이름 붙인 요청을 보내고 상태만 돌려준다. */
const statusOf = (url: string, token: string, name: string) =>
  send(url, token, "/v1/messages", tag(name)).then(
    (response) => response.status
  );
/** 상류가 받은 요청의 이름(도착 순서). */
const arrived = (seen: readonly Seen[]) =>
  seen.map((request) => String(request.headers[requestTag]));

/**
 * 중계와 모의 상류 사이의 전송 구간. 연결마다 바이트를 그대로 넘기되, 이름이 `parkedTag`인 요청의 연결은 상류에 넘기지 않고
 * 붙잡아 둔다(`parked`가 풀린다). 중계가 그 연결을 끊어도 `deliver()`로 붙잡아 둔 바이트를 상류에 보낸다:
 * 이미 보낸 요청은 소켓을 끊어도 돌아오지 않고 상류에 늦게 도착할 수 있다.
 */
async function wire(target: string, parkedTag: string) {
  const to = new URL(target);
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const connect = () => track(net.connect(Number(to.port), to.hostname));
  let held = Buffer.alloc(0);
  let markParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    markParked = resolve;
  });
  const server = net.createServer((inbound) => {
    track(inbound);
    let head = Buffer.alloc(0);
    let route: "parked" | net.Socket | undefined;
    inbound.on("data", (chunk: Buffer) => {
      if (route === "parked") {
        held = Buffer.concat([held, chunk]);
        return;
      }
      if (route) {
        route.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const named = new RegExp(`^${requestTag}:\\s*(.*)$`, "im").exec(
        head.subarray(0, end).toString("latin1")
      )?.[1];
      if (named?.trim() === parkedTag) {
        route = "parked";
        held = head;
        markParked();
        return;
      }
      const outbound = connect();
      route = outbound;
      outbound.pipe(inbound);
      outbound.on("close", () => inbound.destroy());
      inbound.on("close", () => outbound.destroy());
      outbound.write(head);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wires.push({ server, sockets });
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}${to.pathname}`,
    parked,
    /** 붙잡아 둔 요청을 새 연결로 상류에 보낸다. 상류의 답은 버린다. */
    deliver: () => {
      const late = connect();
      late.resume();
      late.write(held);
    },
  };
}

const profile = (url: string): RelayProfile => ({
  upstream: url,
  routes: [
    { method: "POST", path: "/v1/messages" },
    { method: "POST", path: "/v1/stream" },
    { method: "POST", path: "/v1/redirect" },
    { method: "POST", path: "/v1/rejected" },
    { method: "POST", path: "/v1/unchanged" },
    { method: "POST", path: "/v1/echo-header" },
    { method: "POST", path: "/v1/echo-error" },
    { method: "POST", path: "/v1/echo-stream" },
    { method: "POST", path: "/v1/compressed" },
  ],
  authorize: (credential) => ({
    headers: { authorization: `Bearer ${credential}` },
    secrets: [credential],
  }),
});

async function setup(
  options: {
    credential?: () => Promise<string | undefined>;
    profile?: (upstream: string) => RelayProfile;
    /** 중계가 상류 대신 보낼 주소(상류 앞의 전송 구간). */
    through?: (upstream: string) => Promise<string>;
  } = {}
) {
  const up = await upstream();
  let reads = 0;
  const relay = createCredentialRelay({
    profile: (options.profile ?? profile)(
      options.through ? await options.through(up.url) : up.url
    ),
    verified: true,
    credential: async () => {
      reads++;
      return options.credential ? options.credential() : "real-account-secret";
    },
  });
  const url = await listen((req, res) => relay.handle(req, res));
  return { up, relay, url, reads: () => reads };
}

const send = (
  url: string,
  token: string | undefined,
  pathname = "/v1/messages",
  headers: Record<string, string> = {}
) =>
  fetch(`${url}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ hello: "model" }),
  });

const scope = (signal = new AbortController().signal) => ({ signal });

/** 응답 본문을 끝까지 읽는다. 중계가 끊으면 그때까지 받은 것과 끊김을 돌려준다. */
async function received(response: Response) {
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, cut: false };
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { text, cut: true };
  }
}

describe("the credential relay", () => {
  it("sends an allowed request to the fixed upstream with the real credential in place of the run's grant, and returns no cookie", async () => {
    const { up, relay, url } = await setup();
    const grant = relay.grant({
      ...scope(),
      organizationId: "organization-id",
      runId: "run-id",
    });
    const response = await send(url, grant.token, "/v1/messages?beta=true", {
      cookie: "client=1",
      host: "attacker.invalid",
      "x-forwarded-host": "attacker.invalid",
      "anthropic-beta": "oauth-2025-04-20",
      // #149의 실행 시도 중계가 덧붙이는 내부 신원. 상류로 내보내지 않는다.
      "x-babojubot-relay-organization": "organization-id",
      "x-babojubot-relay-run": "run-id",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(up.seen).toHaveLength(1);
    const [request] = up.seen;
    expect(request!.url).toBe("/base/v1/messages?beta=true");
    expect(request!.headers.authorization).toBe("Bearer real-account-secret");
    expect(request!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(request!.headers.cookie).toBeUndefined();
    expect(request!.headers["x-forwarded-host"]).toBeUndefined();
    expect(JSON.stringify(request!.headers)).not.toMatch(
      /x-babojubot|organization-id|run-id/
    );
    expect(request!.headers.host).not.toBe("attacker.invalid");
    expect(JSON.stringify(request!.headers)).not.toContain(grant.token);
  });

  it("refuses a missing, unknown or other connection's grant and an operation outside the profile before reading the credential or reaching the upstream", async () => {
    const one = await setup();
    const other = await setup();
    const otherGrant = other.relay.grant(scope());
    const grant = one.relay.grant(scope());
    expect((await send(one.url, undefined)).status).toBe(401);
    expect((await send(one.url, "made-up")).status).toBe(401);
    expect((await send(one.url, otherGrant.token)).status).toBe(401);
    // 실제 인증 header 대신 API 키 header에 실어도 같은 확인을 거친다.
    expect(
      (
        await send(one.url, undefined, "/v1/messages", {
          "x-api-key": "made-up",
        })
      ).status
    ).toBe(401);
    expect((await send(one.url, grant.token, "/v1/oauth/token")).status).toBe(
      403
    );
    expect(
      (await send(one.url, grant.token, "/v1/messages/../oauth")).status
    ).toBe(403);
    const get = await fetch(`${one.url}/v1/messages`, {
      headers: { authorization: `Bearer ${grant.token}` },
    });
    expect(get.status).toBe(403);
    expect(one.up.seen).toHaveLength(0);
    expect(one.reads()).toBe(0);
  });

  it("refuses new requests and cuts an open stream as soon as the run is cancelled", async () => {
    const { up, relay, url } = await setup();
    const cancel = new AbortController();
    const grant = relay.grant(scope(cancel.signal));
    const stream = await send(url, grant.token, "/v1/stream");
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "first"
    );
    cancel.abort();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return "ended";
      })()
    ).rejects.toThrow();
    expect((await send(url, grant.token)).status).toBe(401);
    expect(up.seen).toHaveLength(1);
    await expect.poll(() => up.closed).toEqual(["/base/v1/stream"]);
    expect(grant.failed.aborted).toBe(false);
  });

  it("refuses a grant after the run ends and a grant from before a server restart", async () => {
    const before = await setup();
    const ended = before.relay.grant(scope());
    const kept = before.relay.grant(scope());
    ended.revoke();
    expect((await send(before.url, ended.token)).status).toBe(401);
    expect((await send(before.url, kept.token)).status).toBe(200);
    // 서버를 다시 시작하면 같은 연결의 중계를 새로 만든다. 이전 권한은 없다.
    const after = createCredentialRelay({
      profile: profile(before.up.url),
      verified: true,
      credential: async () => "real-account-secret",
    });
    const url = await listen((req, res) => after.handle(req, res));
    expect((await send(url, kept.token)).status).toBe(401);
  });

  it("refuses an expired grant", async () => {
    const up = await upstream();
    let time = 0;
    const relay = createCredentialRelay({
      profile: profile(up.url),
      verified: true,
      credential: async () => "real-account-secret",
      now: () => time,
    });
    const url = await listen((req, res) => relay.handle(req, res));
    const grant = relay.grant(scope());
    time = 13 * 60 * 60 * 1000;
    expect((await send(url, grant.token)).status).toBe(401);
    expect(up.seen).toHaveLength(0);
  });

  it("does not follow or pass on a redirect from the upstream, but passes other 3xx answers", async () => {
    const { relay, url } = await setup();
    const grant = relay.grant(scope());
    const response = await send(url, grant.token, "/v1/redirect");
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect((await send(url, grant.token, "/v1/unchanged")).status).toBe(304);
  });

  it("never returns the injected credential to the program when the upstream echoes it in a header, an error body or across stream chunks", async () => {
    const { up, relay, url } = await setup();
    const grant = relay.grant(scope());
    const header = await send(url, grant.token, "/v1/echo-header");
    expect(header.status).toBe(502);
    expect(JSON.stringify([...header.headers])).not.toContain("real-account");
    expect((await received(header)).text).not.toContain("real-account");
    const error = await received(
      await send(url, grant.token, "/v1/echo-error")
    );
    expect(error.text).not.toContain("real-account");
    expect(error.cut).toBe(true);
    // 원본의 앞부분이 한 조각 끝에 오면, 원본인지 알 수 있을 때까지 그 부분을 내보내지 않는다.
    const stream = await received(
      await send(url, grant.token, "/v1/echo-stream")
    );
    expect(stream.text).not.toContain("real-a");
    expect(stream.cut).toBe(true);
    // 상류의 반향은 로그인 거부가 아니다. 연결은 그대로 쓴다.
    expect(relay.failed()).toBe(false);
    expect((await send(url, grant.token)).status).toBe(200);
    expect(up.seen).toHaveLength(4);
  });

  it("asks the upstream for an uncompressed answer and refuses one it cannot check for the credential", async () => {
    const { up, relay, url } = await setup();
    const grant = relay.grant(scope());
    const plain = await send(url, grant.token, "/v1/messages", {
      "accept-encoding": "gzip, br",
    });
    expect(plain.status).toBe(200);
    expect(up.seen[0]!.headers["accept-encoding"]).toBe("identity");
    const compressed = await send(url, grant.token, "/v1/compressed");
    expect(compressed.status).toBe(502);
    expect(compressed.headers.get("content-encoding")).toBeNull();
  });

  it("fails the connection when the login cannot be put into a request, and keeps it failed until the login changes", async () => {
    // 줄바꿈이 낀 로그인은 HTTP header에 넣을 수 없다. 요청을 만들다 던진다.
    let login = "real-account\nsecret";
    const { up, relay, url } = await setup({ credential: async () => login });
    const one = relay.grant(scope());
    const two = relay.grant(scope());
    const response = await send(url, one.token);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("real-account");
    expect(relay.failed()).toBe(true);
    expect(one.failed.aborted).toBe(true);
    expect(two.failed.aborted).toBe(true);
    expect((await send(url, two.token)).status).toBe(401);
    expect(() => relay.grant(scope())).toThrow();
    await relay.recover();
    expect(relay.failed()).toBe(true);
    login = "real-account-secret";
    await relay.recover();
    expect(relay.failed()).toBe(false);
    expect(up.seen).toHaveLength(0);
  });

  it("fails the connection when the upstream rejects its login, and keeps it failed until a different login can be read", async () => {
    let login = "expired-login";
    const { up, relay, url } = await setup({ credential: async () => login });
    const one = relay.grant(scope());
    const two = relay.grant(scope());
    const response = await send(url, one.token, "/v1/rejected");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("invalid login");
    expect(relay.failed()).toBe(true);
    expect(two.failed.aborted).toBe(true);
    expect((await send(url, two.token, "/v1/messages")).status).toBe(401);
    // 같은 로그인이 다시 읽혀도 풀지 않는다. 사용자가 로그인을 고쳐야 풀린다.
    await relay.recover();
    expect(relay.failed()).toBe(true);
    login = "new-login";
    await relay.recover();
    expect(relay.failed()).toBe(false);
    expect(up.seen.map((request) => request.url)).toEqual([
      "/base/v1/rejected",
    ]);
  });

  it("does not reach the upstream for a request whose program hung up while the credential was being read", async () => {
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedReading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { up, relay, url } = await setup({
      credential: async () => {
        started();
        await reading;
        return "real-account-secret";
      },
    });
    const grant = relay.grant(scope());
    const controller = new AbortController();
    const request = fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}` },
      body: "{}",
      signal: controller.signal,
    }).catch(() => "aborted");
    await startedReading;
    controller.abort();
    expect(await request).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(up.seen).toHaveLength(0);
    // 상류에 연결도 열지 않는다(열린 채 남지 않는다).
    expect(await connections(up.server)).toBe(0);
  });

  it("fails the connection when the credential cannot be read: every run's grant is withdrawn first, new runs are refused until it can be read again", async () => {
    let available = false;
    const { up, relay, url } = await setup({
      credential: async () => {
        if (!available) throw new Error("missing");
        return "real-account-secret";
      },
    });
    const notified: boolean[] = [];
    relay.onFailure(() => notified.push(relay.failed()));
    const one = relay.grant(scope());
    const two = relay.grant(scope());
    const response = await send(url, one.token);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("missing");
    expect(relay.failed()).toBe(true);
    expect(notified).toEqual([true]);
    expect(one.failed.aborted).toBe(true);
    expect(two.failed.aborted).toBe(true);
    // 프로그램이 스스로 다시 시도해도 거둔 권한으로는 상류에 닿지 못한다.
    expect((await send(url, two.token)).status).toBe(401);
    expect(() => relay.grant(scope())).toThrow();
    await relay.recover();
    expect(relay.failed()).toBe(true);
    available = true;
    await relay.recover();
    expect(relay.failed()).toBe(false);
    expect((await send(url, relay.grant(scope()).token)).status).toBe(200);
    expect(up.seen).toHaveLength(1);
  });
});

describe("the credential relay's per-connection differences (#148)", () => {
  /**
   * Codex처럼 원본이 여러 값을 담은 문서인 연결. 상류에 붙이는 값 중 비밀은 접근 토큰뿐이고, 계정 ID는 비밀이 아니다.
   * OpenCode처럼 경로마다 상류 경로·인증 header가 다르고, 무료 모델처럼 원본 없이 고정 값만 붙이는 경로도 있다.
   */
  const documentProfile = (url: string): RelayProfile => ({
    upstream: url,
    routes: [
      { method: "POST", path: "/v1/messages" },
      { method: "POST", path: "/v1/rejected" },
      { method: "POST", path: "/v1/echo-header" },
      { method: "POST", path: "/v1/echo-error" },
      { method: "POST", path: "/v1/echo-stream" },
      {
        method: "POST",
        path: "/family/messages",
        upstreamPath: "/anthropic/v1/messages",
        authorize: (credential) => {
          const login = JSON.parse(credential) as { access: string };
          return {
            headers: { "x-api-key": login.access },
            secrets: [login.access],
          };
        },
      },
      {
        method: "POST",
        path: "/free/responses",
        upstreamPath: "/zen/v1/responses",
        fixed: { authorization: "Bearer public" },
      },
      {
        method: "POST",
        path: "/free/rejected",
        upstreamPath: "/v1/rejected",
        fixed: { authorization: "Bearer public" },
      },
    ],
    authorize: (credential) => {
      const login = JSON.parse(credential) as {
        access: string;
        account: string;
      };
      return {
        headers: {
          authorization: `Bearer ${login.access}`,
          "chatgpt-account-id": login.account,
        },
        secrets: [login.access],
      };
    },
    droppedHeaders: ["chatgpt-account-id", "x-openai-account-routing-override"],
  });
  const document = (fields: Record<string, string> = {}) =>
    JSON.stringify({
      access: "real-access-token",
      refresh: "real-refresh-token",
      account: "real-account",
      refreshedAt: "2026-11-12T00:00:00Z",
      ...fields,
    });

  it("sends a route to its own upstream path with that route's header, keeping the query", async () => {
    const { up, relay, url } = await setup({
      profile: documentProfile,
      credential: async () => document(),
    });
    const grant = relay.grant(scope());
    const response = await send(url, grant.token, "/family/messages?beta=1");
    expect(response.status).toBe(200);
    expect(up.seen.map((request) => request.url)).toEqual([
      "/base/anthropic/v1/messages?beta=1",
    ]);
    expect(up.seen[0]!.headers["x-api-key"]).toBe("real-access-token");
    expect(up.seen[0]!.headers.authorization).toBeUndefined();
    // 중계 주소의 경로 그대로는 허용하지 않는다(상류 경로를 직접 고르지 못한다).
    expect(
      (await send(url, grant.token, "/anthropic/v1/messages")).status
    ).toBe(403);
    expect(up.seen).toHaveLength(1);
  });

  it("injects only the real credential's values, and drops account headers the program chose", async () => {
    const { up, relay, url } = await setup({
      profile: (upstreamUrl) => ({
        ...documentProfile(upstreamUrl),
        // 계정 ID를 붙이지 않는 프로필이어도 프로그램이 고른 계정이 상류에 가지 않는다.
        authorize: (credential) => {
          const login = JSON.parse(credential) as { access: string };
          return {
            headers: { authorization: `Bearer ${login.access}` },
            secrets: [login.access],
          };
        },
      }),
      credential: async () => document(),
    });
    const grant = relay.grant(scope());
    const response = await send(url, grant.token, "/v1/messages", {
      "chatgpt-account-id": "other-account",
      "x-openai-account-routing-override": "other-workspace",
      "x-goog-api-key": grant.token,
    });
    expect(response.status).toBe(200);
    const [request] = up.seen;
    expect(request!.headers.authorization).toBe("Bearer real-access-token");
    expect(request!.headers["chatgpt-account-id"]).toBeUndefined();
    expect(
      request!.headers["x-openai-account-routing-override"]
    ).toBeUndefined();
    expect(request!.headers["x-goog-api-key"]).toBeUndefined();
    expect(JSON.stringify(request!.headers)).not.toContain(grant.token);
  });

  it("never returns an injected secret taken from a credential document, in a header, an error body or across stream chunks", async () => {
    const { relay, url } = await setup({
      profile: documentProfile,
      credential: async () => document(),
    });
    const grant = relay.grant(scope());
    const header = await send(url, grant.token, "/v1/echo-header");
    expect(header.status).toBe(502);
    expect(await header.text()).not.toContain("real-access-token");
    const error = await received(
      await send(url, grant.token, "/v1/echo-error")
    );
    expect(error.text).not.toContain("real-access-token");
    const stream = await received(
      await send(url, grant.token, "/v1/echo-stream")
    );
    expect(stream.text).not.toContain("real-access-token");
    expect(stream.text).not.toContain("access-token");
    expect(stream.cut).toBe(true);
    expect(relay.failed()).toBe(false);
  });

  it("judges 'the same login' by the injected secrets: a rejected login stays failed when only other fields change", async () => {
    let login = document({ access: "expired-access" });
    const { relay, url } = await setup({
      profile: documentProfile,
      credential: async () => login,
    });
    const grant = relay.grant(scope());
    expect((await send(url, grant.token, "/v1/rejected")).status).toBe(503);
    expect(relay.failed()).toBe(true);
    login = document({
      access: "expired-access",
      refreshedAt: "2026-11-13T00:00:00Z",
    });
    await relay.recover();
    expect(relay.failed()).toBe(true);
    login = document({ access: "new-access" });
    await relay.recover();
    expect(relay.failed()).toBe(false);
  });

  it("fails the connection without reaching the upstream when the credential cannot be turned into a request", async () => {
    const { up, relay, url } = await setup({
      profile: documentProfile,
      credential: async () => "not a credential document",
    });
    const grant = relay.grant(scope());
    const response = await send(url, grant.token);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("not a credential");
    expect(relay.failed()).toBe(true);
    expect(grant.failed.aborted).toBe(true);
    expect(up.seen).toHaveLength(0);
  });

  it("a fixed-value route still needs the run's grant, never reads the connection's credential, and an upstream refusal there does not fail the connection", async () => {
    const { up, relay, url, reads } = await setup({
      profile: documentProfile,
      credential: async () => document(),
    });
    expect((await send(url, undefined, "/free/responses")).status).toBe(401);
    expect((await send(url, "forged", "/free/responses")).status).toBe(401);
    expect(up.seen).toHaveLength(0);
    const grant = relay.grant(scope());
    const response = await send(url, grant.token, "/free/responses");
    expect(response.status).toBe(200);
    expect(up.seen.map((request) => request.url)).toEqual([
      "/base/zen/v1/responses",
    ]);
    expect(up.seen[0]!.headers.authorization).toBe("Bearer public");
    expect(JSON.stringify(up.seen[0]!.headers)).not.toContain(grant.token);
    const refused = await send(url, grant.token, "/free/rejected");
    expect(refused.status).toBe(401);
    expect(relay.failed()).toBe(false);
    expect(grant.failed.aborted).toBe(false);
    expect(reads()).toBe(0);
    // 실행이 끝나면 고정 값 경로도 거부한다.
    grant.revoke();
    expect((await send(url, grant.token, "/free/responses")).status).toBe(401);
    expect(up.seen).toHaveLength(2);
  });

  it("finds the run's grant in x-api-key when the program keeps a public key in Authorization, and sends neither upstream", async () => {
    // OpenCode의 무료 모델은 `Authorization: Bearer public`을 그대로 보내고, 권한은 `x-api-key`로만 실을 수 있다.
    const { up, relay, url } = await setup({
      profile: documentProfile,
      credential: async () => document(),
    });
    const grant = relay.grant(scope());
    const response = await send(url, undefined, "/free/responses", {
      authorization: "Bearer public",
      "x-api-key": grant.token,
    });
    expect(response.status).toBe(200);
    expect(up.seen[0]!.headers.authorization).toBe("Bearer public");
    expect(JSON.stringify(up.seen[0]!.headers)).not.toContain(grant.token);
    // 원본을 쓰는 경로도 같다.
    expect(
      (
        await send(url, undefined, "/v1/messages", {
          authorization: "Bearer public",
          "x-api-key": grant.token,
        })
      ).status
    ).toBe(200);
    expect(up.seen[1]!.headers.authorization).toBe("Bearer real-access-token");
  });

  it("refuses a request that carries two different runs' grants", async () => {
    const { up, relay, url } = await setup({
      profile: documentProfile,
      credential: async () => document(),
    });
    const one = relay.grant(scope());
    const two = relay.grant(scope());
    const response = await send(url, one.token, "/v1/messages", {
      "x-api-key": two.token,
    });
    expect(response.status).toBe(401);
    expect(up.seen).toHaveLength(0);
  });
});

describe("the credential relay and the run identity the #149 relay adds (#148)", () => {
  const identity = (organization: string, run: string) => ({
    [relayIdentityHeaders.organization]: organization,
    [relayIdentityHeaders.run]: run,
  });

  it("refuses a grant whose request comes through another organization's or run's relay, before reading the credential", async () => {
    const { up, relay, url, reads } = await setup();
    const grant = relay.grant({
      ...scope(),
      organizationId: "org-a",
      runId: "run-1",
    });
    for (const headers of [
      identity("org-b", "run-1"),
      identity("org-a", "run-2"),
      { [relayIdentityHeaders.organization]: "org-a" },
    ])
      expect(
        (await send(url, grant.token, "/v1/messages", headers)).status
      ).toBe(401);
    expect(reads()).toBe(0);
    expect(up.seen).toHaveLength(0);
    // 같은 실행 시도의 중계로 온 요청은 받고, 신원 header는 상류에 넘기지 않는다.
    const response = await send(
      url,
      grant.token,
      "/v1/messages",
      identity("org-a", "run-1")
    );
    expect(response.status).toBe(200);
    expect(
      up.seen[0]!.headers[relayIdentityHeaders.organization]
    ).toBeUndefined();
    expect(up.seen[0]!.headers[relayIdentityHeaders.run]).toBeUndefined();
  });

  it("keeps the organization and run a grant was issued for", () => {
    const relay = createCredentialRelay({
      profile: profile("http://127.0.0.1:1"),
      verified: true,
      credential: async () => "real-account-secret",
    });
    const grant = relay.grant({
      ...scope(),
      organizationId: "org-a",
      runId: "run-1",
    });
    expect(grant.organizationId).toBe("org-a");
    expect(grant.runId).toBe("run-1");
  });
});

describe("the credential relay with runs that overlap (#148)", () => {
  /** 원본 읽기를 하나씩 붙잡아 둔다. 읽기마다 `started[n]`이 풀리고, `release(n)`으로 끝낸다. */
  function heldReads(count: number, login = "real-account-secret") {
    const releases: (() => void)[] = [];
    const holds = Array.from(
      { length: count },
      (_, n) =>
        new Promise<void>((resolve) => {
          releases[n] = resolve;
        })
    );
    const starts: (() => void)[] = [];
    const started = Array.from(
      { length: count },
      (_, n) =>
        new Promise<void>((resolve) => {
          starts[n] = resolve;
        })
    );
    let reads = 0;
    return {
      credential: async () => {
        const n = reads++;
        starts[n]?.();
        await holds[n];
        return login;
      },
      started,
      release: (n: number) => releases[n]!(),
    };
  }
  /** stream이 끝나지도 끊기지도 않고 열려 있는가. 잠깐 기다려 본다. */
  async function stillOpen(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const outcome = await Promise.race([
      reader.read().then(
        ({ done }) => (done ? "ended" : "data"),
        () => "cut"
      ),
      new Promise((resolve) => setTimeout(() => resolve("open"), 100)),
    ]);
    return outcome === "open";
  }
  const cutOff = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })();

  it("does not reach the upstream for a request whose run is cancelled while the credential is being read", async () => {
    const held = heldReads(1);
    const { up, relay, url } = await setup({ credential: held.credential });
    const cancel = new AbortController();
    const grant = relay.grant(scope(cancel.signal));
    const request = send(url, grant.token).then(
      (response) => response.status,
      () => "cut"
    );
    await held.started[0];
    cancel.abort();
    held.release(0);
    expect(await request).not.toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(up.seen).toHaveLength(0);
    expect(await connections(up.server)).toBe(0);
    expect(relay.failed()).toBe(false);
  });

  it("cancelling one organization's run cuts only that run's stream; another organization's run on the same connection keeps going", async () => {
    const { up, relay, url } = await setup();
    const cancelA = new AbortController();
    const a = relay.grant(scope(cancelA.signal));
    const b = relay.grant(scope());
    const streamA = (await send(url, a.token, "/v1/stream")).body!.getReader();
    const streamB = (await send(url, b.token, "/v1/stream")).body!.getReader();
    await streamA.read();
    await streamB.read();
    cancelA.abort();
    await expect(cutOff(streamA)).rejects.toThrow();
    expect(await stillOpen(streamB)).toBe(true);
    expect((await send(url, a.token)).status).toBe(401);
    expect((await send(url, b.token)).status).toBe(200);
    expect(b.failed.aborted).toBe(false);
    await expect.poll(() => up.closed).toEqual(["/base/v1/stream"]);
    await streamB.cancel();
  });

  it("when the upstream rejects the login for one run, another run's open stream is cut and its program's retries never reach the upstream", async () => {
    const { up, relay, url } = await setup({
      credential: async () => "expired-login",
    });
    const streaming = relay.grant(scope());
    const rejected = relay.grant(scope());
    const stream = (
      await send(url, streaming.token, "/v1/stream")
    ).body!.getReader();
    await stream.read();
    expect((await send(url, rejected.token, "/v1/rejected")).status).toBe(503);
    await expect(cutOff(stream)).rejects.toThrow();
    expect(streaming.failed.aborted).toBe(true);
    expect(rejected.failed.aborted).toBe(true);
    const before = up.seen.length;
    for (const grant of [streaming, rejected])
      expect((await send(url, grant.token)).status).toBe(401);
    expect(up.seen).toHaveLength(before);
    await expect.poll(() => up.closed).toEqual(["/base/v1/stream"]);
  });

  it("when several runs' requests are rejected at the same time, the connection fails for all of them and no retry reaches the upstream afterwards", async () => {
    let login = "expired-login";
    const { up, relay, url } = await setup({ credential: async () => login });
    const grants = [
      relay.grant(scope()),
      relay.grant(scope()),
      relay.grant(scope()),
    ];
    const notified: boolean[] = [];
    relay.onFailure(() => notified.push(relay.failed()));
    const statuses = await Promise.all(
      grants.map((grant, n) =>
        send(url, grant.token, "/v1/rejected", tag(`initial-${n}`)).then(
          (response) => response.status,
          () => 0
        )
      )
    );
    expect(statuses).not.toContain(200);
    expect(relay.failed()).toBe(true);
    expect(notified.length).toBeGreaterThanOrEqual(1);
    expect(notified.every(Boolean)).toBe(true);
    expect(grants.every((grant) => grant.failed.aborted)).toBe(true);
    for (const [n, grant] of grants.entries())
      expect(
        (await send(url, grant.token, "/v1/messages", tag(`retry-${n}`))).status
      ).toBe(401);
    expect(() => relay.grant(scope())).toThrow();
    // 처음 보낸 요청은 중계가 끊기 전에 이미 상류로 나갔을 수 있어 늦게 도착할 수 있다(아래 시험이 그 순서를 강제한다).
    // 상류가 받은 요청은 처음 보낸 것뿐이고, 실패 뒤의 재시도는 하나도 없다.
    const initials = grants.map((_, n) => `initial-${n}`);
    const reached = arrived(up.seen);
    for (const name of reached) expect(initials).toContain(name);
    expect(new Set(reached).size).toBe(reached.length);
    // 같은 로그인으로는 풀리지 않는다.
    await relay.recover();
    expect(relay.failed()).toBe(true);
    login = "new-login";
    await relay.recover();
    expect(relay.failed()).toBe(false);
  });

  it("a run's first request that reaches the upstream only after the login was rejected is not a retry: every run's retry is refused and none reaches the upstream (#184)", async () => {
    // A와 B가 같은 원본을 쓴다. B의 요청은 중계가 상류로 보냈지만 전송 구간에 붙잡혀 있다. 그 사이 A의 요청이 거부돼 연결이 실패하고
    // 중계는 B의 요청을 끊는다. 이미 보낸 B의 바이트는 실패 확정과 재시도가 끝난 뒤에야 상류에 도착한다.
    const held = heldReads(2, "expired-login");
    let between!: Awaited<ReturnType<typeof wire>>;
    const { up, relay, url } = await setup({
      credential: held.credential,
      through: async (target) =>
        (between = await wire(target, "initial-b")).url,
    });
    const notified: boolean[] = [];
    relay.onFailure(() => notified.push(relay.failed()));
    const a = relay.grant(scope());
    const b = relay.grant(scope());
    const first = send(url, a.token, "/v1/rejected", tag("initial-a"));
    await held.started[0];
    const second = send(url, b.token, "/v1/rejected", tag("initial-b")).then(
      (response) => response.status,
      () => "cut"
    );
    await held.started[1];
    held.release(1);
    await between.parked;
    held.release(0);
    expect((await first).status).toBe(503);
    // 중계가 실패를 확정하며 B의 진행 중 요청을 끊는다.
    expect(await second).toBe("cut");

    expect(relay.failed()).toBe(true);
    expect(notified).toEqual([true]);
    expect(a.failed.aborted).toBe(true);
    expect(b.failed.aborted).toBe(true);
    expect(() => relay.grant(scope())).toThrow();
    expect(await statusOf(url, a.token, "retry-a")).toBe(401);
    expect(await statusOf(url, b.token, "retry-b")).toBe(401);
    expect(arrived(up.seen)).toEqual(["initial-a"]);

    between.deliver();
    await expect
      .poll(() => arrived(up.seen))
      .toEqual(["initial-a", "initial-b"]);
    // 늦게 도착한 B의 첫 요청 뒤에도 재시도는 여전히 거부되고 상류에 닿지 않는다.
    expect(await statusOf(url, a.token, "retry-a-again")).toBe(401);
    expect(await statusOf(url, b.token, "retry-b-again")).toBe(401);
    expect(arrived(up.seen)).toEqual(["initial-a", "initial-b"]);
  });

  it("a request still reading the credential when another run's login is rejected does not reach the upstream", async () => {
    // 두 실행이 같은 원본을 쓴다. B가 원본을 읽는 동안 A의 요청이 거부되면, B의 요청은 거둔 권한으로 상류에 가지 않는다.
    const held = heldReads(2, "expired-login");
    const { up, relay, url } = await setup({ credential: held.credential });
    const a = relay.grant(scope());
    const b = relay.grant(scope());
    const first = send(url, a.token, "/v1/rejected");
    await held.started[0];
    const second = send(url, b.token).then(
      (response) => response.status,
      () => "cut"
    );
    await held.started[1];
    held.release(0);
    expect((await first).status).toBe(503);
    held.release(1);
    expect(await second).not.toBe(200);
    expect(up.seen.map((request) => request.url)).toEqual([
      "/base/v1/rejected",
    ]);
  });
});

describe("login residue in an organization's product folder", () => {
  it("counts a regular file or folder as residue, and a link as residue unless it is the known link to the connection's login", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "babojubot-relay-"));
    try {
      const login = path.join(root, "connection/login/auth.json");
      expect(await credentialResidue(root, ["auth.json"], login)).toBe(false);
      // 연결의 로그인 원본을 가리키는 링크는 컨테이너 안에서 비어 있다.
      await symlink(login, path.join(root, "auth.json"));
      expect(await credentialResidue(root, ["auth.json"], login)).toBe(false);
      // 알려진 원본이 없는 프로그램에서는 어떤 링크도 안전하다고 볼 수 없다.
      expect(await credentialResidue(root, ["auth.json"])).toBe(true);
      // 컨테이너 안에서 닿을 수 있는 다른 곳을 가리키는 링크는 남은 로그인이다.
      await mkdir(path.join(root, "copy"));
      await symlink(
        path.join(root, "copy/auth.json"),
        path.join(root, "other.json")
      );
      expect(await credentialResidue(root, ["other.json"], login)).toBe(true);
      await mkdir(path.join(root, "config"));
      await writeFile(path.join(root, "config/.credentials.json"), "{}");
      expect(
        await credentialResidue(root, ["auth.json", "config/.credentials.json"])
      ).toBe(true);
      // 상위가 파일이면 그 아래 로그인은 없다.
      await writeFile(path.join(root, "file"), "");
      expect(await credentialResidue(root, ["file/auth.json"], login)).toBe(
        false
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 폴더 권한으로 읽기를 막는다. root는 권한을 넘고, Windows는 POSIX 권한 비트로 읽기를 막지 않는다.
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "counts a path it cannot inspect as residue",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "babojubot-relay-"));
      try {
        await mkdir(path.join(root, "locked"));
        await chmod(path.join(root, "locked"), 0o000);
        expect(await credentialResidue(root, ["locked/auth.json"])).toBe(true);
      } finally {
        await chmod(path.join(root, "locked"), 0o700);
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
