import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { CredentialRelayEndpoint } from "@babojubot/contracts";

/**
 * 인증 중계(#148). 격리 실행의 프로그램은 연결의 로그인 원본 대신 실행 시도 하나에 묶인 권한(grant)을 받고, 모델 요청을 이 중계로 보낸다.
 * 중계는 컨테이너 밖(서버)에서 돌며 권한을 확인한 뒤에만 원본을 읽어 정해진 상류에 실제 인증을 붙인다.
 *
 * 공통 경로가 맡는 것: 권한 발급·확인·회수(실행 중단·끝·서버 재시작), 허용 작업(메서드·경로) 확인, 요청 쪽 인증 header 제거와 실제 인증 주입,
 * 상류 고정(redirect 거부), 응답 쿠키 제거, stream 전달과 회수 때 끊기, 원본을 읽지 못하면 연결 실패 처리.
 * 프로바이더마다 다른 것은 `RelayProfile`(상류·허용 작업·주입 형식)과 원본 읽기뿐이다.
 * 같은 연결을 여러 조직이 쓰지만, 권한은 발급할 때 정한 조직·실행 시도에만 묶이며 요청의 어떤 값도 그것을 바꾸지 못한다.
 */

/** 프로바이더별 중계 설정. 공통 확인을 건너뛰는 진입점은 없다. */
export type RelayProfile = {
  /** 고정 상류(origin과 기본 경로). 요청의 Host·경로가 상류를 바꾸지 못한다. */
  upstream: string;
  /** 허용 작업. 경로는 중계 주소 뒤의 경로이며 정확히 같아야 한다(query는 그대로 넘긴다). */
  routes: readonly { method: string; path: string }[];
  /** 실제 인증을 넣을 header. 원본 값을 받아 header를 돌려준다. */
  authorize: (credential: string) => Record<string, string>;
};

/** 실행 시도 하나의 권한. `token`은 그 실행 시도의 프로그램에만 준다. */
export type RelayGrant = {
  token: string;
  /** 중계가 실패해 권한을 거둔 경우에만 끝나는 신호. 어댑터는 이것으로 프로그램을 멈추고 실행 시도를 실패로 끝낸다. */
  failed: AbortSignal;
  /** 권한을 거둔다. 새 요청을 거부하고 진행 중인 요청·stream을 끊는다. 여러 번 불러도 된다. */
  revoke: () => void;
};

export type CredentialRelay = CredentialRelayEndpoint & {
  /**
   * 실행 시도 하나의 권한을 발급한다. `signal`이 끝나면(실행 중단) 바로 거둔다. 중계가 실패 상태면 던진다.
   * 실행 시도가 끝나면 부른 쪽이 `revoke`한다.
   */
  grant: (scope: { signal: AbortSignal }) => RelayGrant;
};

/** 실행 시도 권한의 상태. 권한은 그 실행 시도의 프로그램에만 준 값 자체이며, 요청의 어떤 값도 다른 조직·실행 시도로 바꾸지 못한다. */
type GrantState = {
  expiresAt: number;
  inflight: Set<{ destroy: () => void }>;
  failure: AbortController;
  release: () => void;
};

/** 권한의 최대 수명. 실행 시도가 끝나면 그 전에 거둔다. 거두지 못한 권한이 오래 남지 않게 한다. */
const grantLifetimeMs = 12 * 60 * 60 * 1000;

/** 상류에 넘기지 않는 요청 header. 인증·쿠키·연결 관리·중계 경로 정보다. */
const droppedRequestHeaders = new Set([
  "host",
  "authorization",
  "x-api-key",
  "cookie",
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
/** 프로그램에 돌려주지 않는 응답 header. 쿠키와 연결 관리다. */
const droppedResponseHeaders = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "trailer",
  "upgrade",
  "proxy-authenticate",
]);

/** 상류는 고정이다. 다른 곳으로 보내는 응답은 따라가지도 넘기지도 않는다. */
const redirects = new Set([301, 302, 303, 307, 308]);

function keep(
  headers: http.IncomingHttpHeaders,
  dropped: ReadonlySet<string>
): http.OutgoingHttpHeaders {
  const kept: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !dropped.has(name)) kept[name] = value;
  return kept;
}

const fingerprint = (credential: string) =>
  createHash("sha256").update(credential).digest("hex");

const deny = (res: http.ServerResponse, status: number, code: string): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code } }));
};

/** 요청이 실은 권한 값. `Authorization: Bearer`나 `x-api-key`에 둔다(프로그램마다 인증 header가 다르다). */
function presentedToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match) return match[1];
  }
  const key = req.headers["x-api-key"];
  return typeof key === "string" && key ? key : undefined;
}

export function createCredentialRelay(options: {
  profile: RelayProfile;
  /** 연결의 원본 인증을 읽는다. 던지거나 빈 값이면 중계 실패다. 권한을 확인한 요청에서만 부른다. */
  credential: () => Promise<string | null | undefined>;
  /** 이 연결의 기존 구독으로 격리 실행을 검증했는가. 아니면 서버가 격리 실행을 준비안됨으로 막는다. */
  verified: boolean;
  now?: () => number;
}): CredentialRelay {
  const { profile } = options;
  const now = options.now ?? Date.now;
  const upstream = new URL(profile.upstream);
  const client = upstream.protocol === "https:" ? https : http;
  const grants = new Map<string, GrantState>();
  const listeners = new Set<() => void>();
  let failed = false;
  /** 실패할 때의 원본 지문(읽지 못했으면 null). 같은 원본이 다시 읽혀도 풀지 않는다: 로그인을 고쳐야 풀린다. */
  let failedWith: string | null = null;

  const revoke = (token: string, failure: boolean) => {
    const state = grants.get(token);
    if (!state) return;
    grants.delete(token);
    state.release();
    if (failure) state.failure.abort(new Error("credential relay failed"));
    for (const request of state.inflight) request.destroy();
    state.inflight.clear();
  };
  /** 원본을 읽지 못했거나(`rejected` 없음) 상류가 원본을 거부했다(`rejected`). */
  const fail = (rejected?: string) => {
    if (!failed) {
      failed = true;
      failedWith = rejected ? fingerprint(rejected) : null;
      console.error(
        rejected
          ? "[relay] the upstream rejected the connection's login; isolated runs on it stop"
          : "[relay] the connection's credential could not be read; isolated runs on it stop"
      );
    }
    // 권한을 먼저 거둬 프로그램이 다시 시도해도 상류에 닿지 못하게 한 뒤 알린다.
    for (const token of [...grants.keys()]) revoke(token, true);
    for (const listener of listeners) listener();
  };
  const read = async () => {
    try {
      const value = (await options.credential())?.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  };

  return {
    verified: options.verified,
    failed: () => failed,
    async recover() {
      if (!failed) return;
      const credential = await read();
      if (credential && fingerprint(credential) !== failedWith) {
        failed = false;
        failedWith = null;
      }
    },
    onFailure(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    grant({ signal }) {
      if (failed) throw new Error("credential relay is not available");
      // 거두지 못하고 만료된 권한을 정리한다.
      for (const [token, state] of grants)
        if (state.expiresAt <= now()) revoke(token, false);
      const token = randomBytes(32).toString("base64url");
      const failure = new AbortController();
      const stop = () => revoke(token, false);
      grants.set(token, {
        expiresAt: now() + grantLifetimeMs,
        inflight: new Set(),
        failure,
        release: () => signal.removeEventListener("abort", stop),
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      return { token, failed: failure.signal, revoke: stop };
    },
    handle(req, res) {
      void (async () => {
        const token = presentedToken(req);
        const state = token ? grants.get(token) : undefined;
        if (!token || !state) return deny(res, 401, "relay_grant_invalid");
        if (state.expiresAt <= now()) {
          revoke(token, false);
          return deny(res, 401, "relay_grant_invalid");
        }
        const target = new URL(req.url ?? "/", "http://relay.invalid");
        const method = (req.method ?? "GET").toUpperCase();
        if (
          !profile.routes.some(
            (route) => route.method === method && route.path === target.pathname
          )
        )
          return deny(res, 403, "relay_route_refused");
        // 거둔 뒤나 프로그램이 연결을 끊은 뒤 끝난 원본 읽기는 쓰지 않는다.
        let gone = false;
        res.once("close", () => {
          gone = true;
        });
        const pending = { destroy: () => res.destroy() };
        state.inflight.add(pending);
        const credential = await read();
        state.inflight.delete(pending);
        if (gone) return;
        if (grants.get(token) !== state)
          return deny(res, 401, "relay_grant_invalid");
        if (!credential) {
          fail();
          return deny(res, 503, "relay_unavailable");
        }
        const headers = {
          ...keep(req.headers, droppedRequestHeaders),
          ...profile.authorize(credential),
        };
        const base = upstream.pathname.replace(/\/$/, "");
        const outgoing = client.request({
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method,
          path: `${base}${target.pathname}${target.search}`,
          headers,
        });
        const inflight = {
          destroy: () => {
            outgoing.destroy();
            res.destroy();
          },
        };
        state.inflight.add(inflight);
        const done = () => state.inflight.delete(inflight);
        res.on("close", () => {
          done();
          outgoing.destroy();
        });
        outgoing.on("error", () => {
          done();
          deny(res, 502, "relay_upstream_failed");
        });
        outgoing.on("response", (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (redirects.has(status)) {
            incoming.resume();
            done();
            return deny(res, 502, "relay_redirect_refused");
          }
          // 권한을 확인한 요청이 거부됐으면 원본 로그인이 거부된 것이다. 연결을 실패로 두고 모든 권한을 거둬, 프로그램의 재시도가 상류에 닿지 않게 한다.
          if (status === 401) {
            incoming.resume();
            done();
            fail(credential);
            return deny(res, 503, "relay_login_rejected");
          }
          res.writeHead(status, keep(incoming.headers, droppedResponseHeaders));
          incoming.pipe(res);
          incoming.on("end", done);
          incoming.on("error", () => res.destroy());
        });
        req.pipe(outgoing);
        req.on("error", () => outgoing.destroy());
      })().catch(() => deny(res, 500, "relay_failed"));
    },
  };
}

/** 조직 제품 폴더에 로그인이 남아 격리 실행을 시작하지 않은 실행 시도의 실패 문장. */
export const residueRefusal =
  "조직 제품 폴더에 로그인 기록이 남아 있어 격리 실행을 시작하지 않았습니다.";

/**
 * 격리 실행에 넣으면 안 되는 로그인 흔적이 조직 제품 폴더에 남아 있는가. 링크는 원본 폴더를 컨테이너에 넣지 않으므로 비어 있어 괜찮고,
 * 보통 파일·폴더면 남은 로그인이다. 비밀값은 읽지 않는다.
 */
export async function credentialResidue(
  home: string,
  paths: readonly string[]
): Promise<boolean> {
  for (const relative of paths) {
    const found = await lstat(path.join(home, relative)).catch(() => undefined);
    if (found && !found.isSymbolicLink()) return true;
  }
  return false;
}
