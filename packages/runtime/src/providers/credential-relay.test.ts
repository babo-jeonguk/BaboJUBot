import http from "node:http";
import type net from "node:net";
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

// 인증 중계(#148)를 실제 HTTP로 시험한다. 상류는 이 컴퓨터의 모의 서버이며 받은 요청을 남긴다.

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };
const servers: http.Server[] = [];
afterEach(async () => {
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
  authorize: (credential) => ({ authorization: `Bearer ${credential}` }),
});

async function setup(
  options: { credential?: () => Promise<string | undefined> } = {}
) {
  const up = await upstream();
  let reads = 0;
  const relay = createCredentialRelay({
    profile: profile(up.url),
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
    const grant = relay.grant(scope());
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
