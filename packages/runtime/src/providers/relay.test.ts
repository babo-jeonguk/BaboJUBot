import http from "node:http";
import type net from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialRelay,
  credentialResidue,
  type RelayProfile,
} from "./relay.ts";

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

/** 모의 상류. `/v1/stream`은 첫 조각을 보낸 뒤 닫힐 때까지 열어 둔다. */
async function upstream() {
  const seen: Seen[] = [];
  const closed: string[] = [];
  const url = await listen((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    req.resume();
    if (req.url?.startsWith("/base/v1/redirect")) {
      res.writeHead(302, { location: "https://elsewhere.invalid/" });
      res.end();
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
  return { url: `${url}/base`, seen, closed };
}

const profile = (url: string): RelayProfile => ({
  upstream: url,
  routes: [
    { method: "POST", path: "/v1/messages" },
    { method: "POST", path: "/v1/stream" },
    { method: "POST", path: "/v1/redirect" },
  ],
  authorize: (credential) => ({ authorization: `Bearer ${credential}` }),
});

async function setup(options: { credential?: () => Promise<string> } = {}) {
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

const scope = (signal = new AbortController().signal) => ({
  organizationId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  signal,
});

describe("the credential relay", () => {
  it("sends an allowed request to the fixed upstream with the real credential in place of the run's grant, and returns no cookie", async () => {
    const { up, relay, url } = await setup();
    const grant = relay.grant(scope());
    const response = await send(url, grant.token, "/v1/messages?beta=true", {
      cookie: "client=1",
      host: "attacker.invalid",
      "x-forwarded-host": "attacker.invalid",
      "anthropic-beta": "oauth-2025-04-20",
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

  it("does not follow or pass on a redirect from the upstream", async () => {
    const { relay, url } = await setup();
    const grant = relay.grant(scope());
    const response = await send(url, grant.token, "/v1/redirect");
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
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
  it("counts a regular file or folder as residue but not a link to the connection's login", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "babojubot-relay-"));
    try {
      expect(await credentialResidue(root, ["auth.json"])).toBe(false);
      await symlink(path.join(root, "elsewhere"), path.join(root, "auth.json"));
      expect(await credentialResidue(root, ["auth.json"])).toBe(false);
      await mkdir(path.join(root, "config"));
      await writeFile(path.join(root, "config/.credentials.json"), "{}");
      expect(
        await credentialResidue(root, ["auth.json", "config/.credentials.json"])
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
