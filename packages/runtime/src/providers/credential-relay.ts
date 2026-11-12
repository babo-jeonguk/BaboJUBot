import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import type { CredentialRelayEndpoint } from "@babojubot/contracts";
import { relayIdentityHeaders } from "./relay.ts";

/**
 * 인증 중계(#148). 격리 실행의 프로그램은 연결의 로그인 원본 대신 실행 시도 하나에 묶인 권한(grant)을 받고, 모델 요청을 이 중계로 보낸다.
 * 중계는 컨테이너 밖(서버)에서 돌며 권한을 확인한 뒤에만 원본을 읽어 정해진 상류에 실제 인증을 붙인다.
 *
 * 공통 경로가 맡는 것: 권한 발급·확인·회수(실행 중단·끝·서버 재시작), 허용 작업(메서드·경로) 확인, 요청 쪽 인증 header 제거와 실제 인증 주입,
 * 상류 고정(redirect 거부), 응답 쿠키 제거, stream 전달과 회수 때 끊기, 응답 header·본문에 원본이 그대로 나오면 막기, 압축 응답 거부,
 * 원본을 읽지 못하면 연결 실패 처리.
 * 연결마다 다른 것은 `RelayProfile`의 경로·주입·버리는 header와 원본 읽기뿐이다.
 * 같은 연결을 여러 조직이 쓰지만, 권한은 발급할 때 정한 조직·실행 시도에만 묶이며 요청의 어떤 값도 그것을 바꾸지 못한다.
 */

/** 경로 하나가 프로그램의 권한 대신 상류 요청에 넣는 값. */
export type RelayInjection = {
  /** 상류 요청에 더하는 header. */
  headers: Record<string, string>;
  /** 프로그램에 돌아가면 안 되는 값(header·본문). 계정 ID처럼 비밀이 아닌 값은 넣지 않는다. */
  secrets: readonly string[];
};

/** 중계가 허용하는 작업 하나. */
export type RelayRoute = {
  method: string;
  /** 중계 주소 뒤의 경로. 정확히 같아야 한다(query는 그대로 넘긴다). */
  path: string;
  /** 이 경로가 상류 기본 경로 뒤에 붙는 경로. 기본값은 `path`. */
  upstreamPath?: string;
  /** 연결의 원본으로 이 경로의 주입을 만든다. 기본값은 프로필의 `authorize`. */
  authorize?: (credential: string) => RelayInjection;
  /**
   * 연결의 로그인을 쓰지 않는 경로의 고정 header(예: 공개 키를 쓰는 프로바이더의 무료 모델). 비밀이 아니다.
   * 있으면 중계는 이 경로에서 연결의 원본을 읽지 않는다.
   */
  fixed?: Record<string, string>;
};

/** 프로바이더별 중계 설정. 공통 확인을 건너뛰는 진입점은 없다. */
export type RelayProfile = {
  /** 고정 상류(origin과 기본 경로). 요청의 Host·경로가 상류를 바꾸지 못한다. */
  upstream: string;
  /** 허용 작업. */
  routes: readonly RelayRoute[];
  /** 연결의 원본으로 주입을 만든다. 던지면 그 원본을 쓸 수 없다. */
  authorize: (credential: string) => RelayInjection;
  /** 이 연결에서 상류로 넘기지 않는 추가 요청 header(예: 계정을 고르는 header). 소문자 이름. */
  droppedHeaders?: readonly string[];
};

/** 실행 시도 하나의 권한. `token`은 그 실행 시도의 프로그램에만 준다. */
export type RelayGrant = {
  token: string;
  /** 발급할 때 정한 조직·실행. 기록과 시험에서 권한의 범위를 확인한다. */
  organizationId?: string;
  runId?: string;
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
  grant: (scope: RelayGrantScope) => RelayGrant;
};

/**
 * 권한을 묶을 범위. `signal`은 그 실행 시도의 중단 신호다. 조직·실행을 주면, #149의 실행 시도 중계가 요청에 덮어쓴 신원
 * (`x-babojubot-relay-*`)이 있을 때 그것과 맞는 요청만 받는다(조직 도구와 같은 규칙).
 */
export type RelayGrantScope = {
  signal: AbortSignal;
  organizationId?: string;
  runId?: string;
};

/** 실행 시도 권한의 상태. 권한은 그 실행 시도의 프로그램에만 준 값 자체이며, 요청의 어떤 값도 다른 조직·실행 시도로 바꾸지 못한다. */
type GrantState = {
  organizationId?: string;
  runId?: string;
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
  "x-goog-api-key",
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
  // 격리 실행의 실행 시도 중계(#149)가 덧붙이는 내부 신원. 상류에 조직·실행 시도 ID를 보내지 않는다.
  relayIdentityHeaders.organization,
  relayIdentityHeaders.run,
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

const secretsFingerprint = (secrets: readonly string[]) =>
  createHash("sha256")
    .update([...secrets].sort().join("\n"))
    .digest("hex");

const deny = (res: http.ServerResponse, status: number, code: string): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code } }));
};

/**
 * 원본이 응답에 그대로 나오면 그 앞에서 끊는다. 원본의 앞부분일 수 있는 끝 조각만 다음 조각이 올 때까지 잡아 둔다.
 * 변형된 반향(인코딩·잘린 값)은 막지 못한다.
 */
function echoGuard(secrets: readonly string[]): Transform {
  const secretBytes = secrets
    .filter((secret) => secret.length > 0)
    .map((secret) => Buffer.from(secret));
  let held = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.concat([held, chunk]);
      if (secretBytes.some((secret) => buffer.includes(secret))) {
        callback(new Error("credential echoed"));
        return;
      }
      let keep = 0;
      for (const secret of secretBytes)
        for (let k = Math.min(secret.length - 1, buffer.length); k > keep; k--)
          if (
            buffer.subarray(buffer.length - k).equals(secret.subarray(0, k))
          ) {
            keep = k;
            break;
          }
      held = Buffer.from(buffer.subarray(buffer.length - keep));
      callback(null, buffer.subarray(0, buffer.length - keep));
    },
    flush(callback) {
      callback(null, held);
    },
  });
}

/**
 * 요청이 실은 권한 값 후보. `Authorization: Bearer`와 `x-api-key`, `x-goog-api-key`에 둔다(프로그램마다 인증 header가 다르다).
 * OpenCode의 무료 모델처럼 `Authorization`에 공개 키를 그대로 두고 권한은 `x-api-key`에만 싣는 프로그램도 있다.
 * OpenCode의 Google 프로토콜 Go 모델은 키를 `x-goog-api-key`에 싣는데 그 경로는 중계에 없으므로, 로그인 문제("권한 없음")가 아니라
 * "경로 거부"가 된다. 그래도 이미 `droppedRequestHeaders`에 있어 상류에는 닿지 않는다.
 */
function presentedTokens(req: http.IncomingMessage): string[] {
  const found: string[] = [];
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match) found.push(match[1]!);
  }
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key) found.push(key);
  const google = req.headers["x-goog-api-key"];
  if (typeof google === "string" && google) found.push(google);
  return found;
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
  /** 이 연결에서 상류로 넘기지 않는 요청 header. 공통 목록에 프로필이 정한 이름을 더한다. */
  const dropped = new Set([
    ...droppedRequestHeaders,
    ...(profile.droppedHeaders ?? []).map((name) => name.toLowerCase()),
  ]);
  const grants = new Map<string, GrantState>();
  const listeners = new Set<() => void>();
  let failed = false;
  /** 실패할 때의 주입 비밀 지문(쓸 수 있는 비밀이 없었으면 null). 같은 로그인이 다시 읽혀도 풀지 않는다: 로그인을 고쳐야 풀린다. */
  let failedWith: string | null = null;

  /** 프로필의 `authorize`로 얻는 주입 비밀. 던지거나 비어 있으면 그 원본을 쓸 수 없다. */
  const secretsOf = (credential: string): string[] | undefined => {
    try {
      const secrets = profile
        .authorize(credential)
        .secrets.filter((secret) => secret.length > 0);
      return secrets.length > 0 ? secrets : undefined;
    } catch {
      return undefined;
    }
  };

  const revoke = (token: string, failure: boolean) => {
    const state = grants.get(token);
    if (!state) return;
    grants.delete(token);
    state.release();
    if (failure) state.failure.abort(new Error("credential relay failed"));
    for (const request of state.inflight) request.destroy();
    state.inflight.clear();
  };
  /** 원본을 읽지 못했거나(`unreadable`), 상류가 원본을 거부했거나(`rejected`), 요청에 넣을 수 없다(`unusable`). */
  const fail = (
    cause: "unreadable" | "rejected" | "unusable",
    credential?: string
  ) => {
    if (!failed) {
      failed = true;
      const secrets =
        credential === undefined ? undefined : secretsOf(credential);
      failedWith = secrets ? secretsFingerprint(secrets) : null;
      console.error(
        cause === "rejected"
          ? "[relay] the upstream rejected the connection's login; isolated runs on it stop"
          : cause === "unusable"
            ? "[relay] the connection's login could not be put into a request; isolated runs on it stop"
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
      const secrets = credential ? secretsOf(credential) : undefined;
      if (secrets && secretsFingerprint(secrets) !== failedWith) {
        failed = false;
        failedWith = null;
      }
    },
    onFailure(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    grant({ signal, organizationId, runId }) {
      if (failed) throw new Error("credential relay is not available");
      // 거두지 못하고 만료된 권한을 정리한다.
      for (const [token, state] of grants)
        if (state.expiresAt <= now()) revoke(token, false);
      const token = randomBytes(32).toString("base64url");
      const failure = new AbortController();
      const stop = () => revoke(token, false);
      grants.set(token, {
        organizationId,
        runId,
        expiresAt: now() + grantLifetimeMs,
        inflight: new Set(),
        failure,
        release: () => signal.removeEventListener("abort", stop),
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      return {
        token,
        organizationId,
        runId,
        failed: failure.signal,
        revoke: stop,
      };
    },
    handle(req, res) {
      void (async () => {
        // 이 중계가 발급한 권한인 값만 본다. 서로 다른 권한 둘을 실은 요청은 어느 실행인지 정할 수 없어 거부한다.
        const known = [
          ...new Set(presentedTokens(req).filter((value) => grants.has(value))),
        ];
        if (known.length !== 1) return deny(res, 401, "relay_grant_invalid");
        const token = known[0]!;
        const state = grants.get(token)!;
        if (state.expiresAt <= now()) {
          revoke(token, false);
          return deny(res, 401, "relay_grant_invalid");
        }
        // 격리 실행의 중계(#149)는 요청에 그 실행 시도의 신원을 덮어써 넣는다. 다른 조직·실행의 중계로 온 권한은 원본을 읽기 전에 거부한다.
        const relayOrganization =
          req.headers[relayIdentityHeaders.organization];
        if (
          (relayOrganization !== undefined ||
            req.headers[relayIdentityHeaders.run] !== undefined) &&
          (relayOrganization !== state.organizationId ||
            req.headers[relayIdentityHeaders.run] !== state.runId)
        )
          return deny(res, 401, "relay_grant_invalid");
        const target = new URL(req.url ?? "/", "http://relay.invalid");
        const method = (req.method ?? "GET").toUpperCase();
        const route = profile.routes.find(
          (candidate) =>
            candidate.method === method && candidate.path === target.pathname
        );
        if (!route) return deny(res, 403, "relay_route_refused");
        // 거둔 뒤나 프로그램이 연결을 끊은 뒤 끝난 원본 읽기는 쓰지 않는다.
        let gone = false;
        res.once("close", () => {
          gone = true;
        });
        let credential: string | undefined;
        if (!route.fixed) {
          const pending = { destroy: () => res.destroy() };
          state.inflight.add(pending);
          credential = await read();
          state.inflight.delete(pending);
          if (gone) return;
          if (grants.get(token) !== state)
            return deny(res, 401, "relay_grant_invalid");
          if (!credential) {
            fail("unreadable");
            return deny(res, 503, "relay_unavailable");
          }
        }
        let secrets: readonly string[] = [];
        let outgoing: http.ClientRequest;
        try {
          let headers: http.OutgoingHttpHeaders;
          if (route.fixed) {
            // 연결의 로그인을 쓰지 않는 경로. 원본을 읽지 않고 고정 값만 붙인다.
            headers = {
              ...keep(req.headers, dropped),
              ...route.fixed,
              "accept-encoding": "identity",
            };
          } else {
            const injection = (route.authorize ?? profile.authorize)(
              credential!
            );
            secrets = injection.secrets.filter((secret) => secret.length > 0);
            if (secrets.length === 0) throw new Error("no secret to inject");
            headers = {
              ...keep(req.headers, dropped),
              ...injection.headers,
              // 프로그램의 값이 상류에 닿지 않게 한다. 압축 응답은 원본을 확인할 수 없어 거부한다.
              "accept-encoding": "identity",
            };
          }
          const base = upstream.pathname.replace(/\/$/, "");
          outgoing = client.request({
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port || undefined,
            method,
            path: `${base}${route.upstreamPath ?? route.path}${target.search}`,
            headers,
          });
        } catch {
          if (!route.fixed) fail("unusable", credential);
          return deny(res, 503, "relay_unavailable");
        }
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
          // 고정 값 경로의 거부는 연결의 로그인과 상관없으므로 그대로 넘긴다.
          if (status === 401 && !route.fixed) {
            incoming.resume();
            done();
            fail("rejected", credential);
            return deny(res, 503, "relay_login_rejected");
          }
          // 압축 응답은 안에서 원본을 확인할 수 없다. 상류에 압축하지 않은 응답을 요청했으므로, 그래도 압축해 오면 거부한다.
          const encoding = incoming.headers["content-encoding"];
          if (
            encoding !== undefined &&
            String(encoding).trim().toLowerCase() !== "identity"
          ) {
            incoming.resume();
            done();
            return deny(res, 502, "relay_response_refused");
          }
          // 주입한 비밀이 그대로 돌아오면 프로그램에 넘기지 않는다. 연결은 실패로 두지 않는다.
          if (
            secrets.some((secret) =>
              Object.values(incoming.headers).some((value) =>
                value === undefined
                  ? false
                  : (Array.isArray(value) ? value : [value]).some((one) =>
                      one.includes(secret)
                    )
              )
            )
          ) {
            incoming.resume();
            done();
            return deny(res, 502, "relay_response_refused");
          }
          res.writeHead(status, keep(incoming.headers, droppedResponseHeaders));
          // 본문을 막아 끊어도 프로그램이 상태와 header를 읽도록 먼저 보낸다.
          res.flushHeaders();
          const guarded = route.fixed
            ? incoming
            : incoming.pipe(echoGuard(secrets));
          guarded.pipe(res);
          guarded.on("error", () => {
            incoming.destroy();
            res.destroy();
            done();
          });
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
 * 격리 실행에 넣으면 안 되는 로그인 흔적이 조직 제품 폴더에 남아 있는가.
 * 연결의 로그인 원본을 가리키는 알려진 링크(이 컴퓨터의 실행이 남긴 것)만 컨테이너 안에서 비어 있어 괜찮다.
 * 보통 파일·폴더, 다른 곳을 가리키는 링크, 확인할 수 없는 경로는 남은 로그인으로 본다. 비밀값은 읽지 않는다.
 */
export async function credentialResidue(
  home: string,
  paths: readonly string[],
  known?: string
): Promise<boolean> {
  for (const relative of paths) {
    const at = path.join(home, relative);
    let found;
    try {
      found = await lstat(at);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return true;
    }
    if (!found.isSymbolicLink()) return true;
    if (known === undefined) return true;
    let target: string;
    try {
      target = await readlink(at);
    } catch {
      return true;
    }
    if (target !== known) return true;
  }
  return false;
}
