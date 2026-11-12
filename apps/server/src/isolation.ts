import os from "node:os";
import type { ProviderReadinessCheck } from "@babojubot/contracts";
import {
  containerToolsOrigin,
  type DockerEnvironment,
} from "@babojubot/runtime";

/** 격리 실행을 시작하지 않은 이유. 제품이 쓴 안내라 실행 시도의 실패 문장으로 그대로 보인다. */
export class IsolationError extends Error {}

/** 실행 시도·세션 정비가 돌 곳과 그때의 조직 도구 주소. */
export type Placement = { execution?: "container"; toolsBaseUrl: string };

type Safety =
  | { status: "safe"; toolsBaseUrl: string }
  | { status: "unsafe" | "unavailable" };

/**
 * 격리 실행의 관문(#102, #149). 실행 시도 컨테이너에는 네트워크가 없고 실행 시도 밖의 중계(runtime relay)만 바깥·조직 도구로 잇는다.
 * 확인은 같은 컴퓨터의 Linux Docker Engine·이 제품 판의 이미지인지 본 뒤, 실행 시도와 같은 권한·중계의 시험 컨테이너로
 * 네트워크 장치가 없고 이 컴퓨터의 주소(사용자 API·DB 포트)에 직접 닿지 않으며, 중계를 거쳐도 그 포트가 열리지 않고,
 * 중계를 거친 조직 도구에는 닿는지(양성 대조) 본다.
 * 확인은 한 번 하고 결과를 나눠 쓰며 준비 확인을 다시 할 때 새로 한다. 확인을 통과하지 않으면 실제 연결은
 * 준비안됨이고 실행 시도는 컨테이너에서도 이 컴퓨터에서도 시작하지 않는다. 닫으면 진행 중인 확인을 끝내고 그 뒤로는 확인하지 않는다(격리 환경 없음).
 * Windows는 Docker 격리를 지원하지 않으므로 격리를 켜면 실제 연결은 준비안됨(격리 환경 없음)이고 실행 시도는 이 컴퓨터에서도 시작하지 않는다.
 */
export class IsolationGate {
  readonly #docker: DockerEnvironment | undefined;
  readonly #protectedPorts: () => number[];
  readonly #readIsolated: () => Promise<boolean>;
  readonly #hostUrl: () => string;
  readonly #timeoutMs: number;
  /** 이 컴퓨터의 운영체제가 Windows인지. Windows는 Docker 격리를 지원하지 않는다. */
  readonly #windows: boolean;
  /** 관문의 수명. 닫으면 진행 중인 확인을 끝내고 새 확인을 하지 않는다. */
  readonly #lifetime = new AbortController();
  #current: Promise<Safety> | undefined;

  constructor(options: {
    docker: DockerEnvironment | undefined;
    /** 컨테이너에서 막혀야 하는 이 컴퓨터의 포트(사용자 API·DB). 부를 때 읽는다(사용자 API 포트는 listen 뒤에 정해짐). */
    protectedPorts: () => number[];
    readIsolated: () => Promise<boolean>;
    /** 격리하지 않는 실행의 조직 도구 주소(사용자 API 주소). */
    hostUrl: () => string;
    /** 안전 확인 한 번의 시한. 넘으면 격리 환경 없음이다. 기본 60초. */
    timeoutMs?: number;
    /** 이 컴퓨터의 운영체제. Windows는 Docker 격리를 지원하지 않아 격리 환경 없음으로 둔다(docs/providers.md 격리 실행). 기본 process.platform. */
    platform?: NodeJS.Platform;
  }) {
    this.#docker = options.docker;
    this.#protectedPorts = options.protectedPorts;
    this.#readIsolated = options.readIsolated;
    this.#hostUrl = options.hostUrl;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#windows = (options.platform ?? process.platform) === "win32";
  }

  check(): Promise<Safety> {
    return (this.#current ??= this.#probe());
  }

  invalidate(): void {
    this.#current = undefined;
  }

  async place(isolatable: boolean): Promise<Placement> {
    if (!isolatable || !(await this.#readIsolated()))
      return { toolsBaseUrl: this.#hostUrl() };
    const safety = await this.check();
    if (safety.status === "safe")
      return { execution: "container", toolsBaseUrl: safety.toolsBaseUrl };
    // 확인하지 못한 것은 다음 실행 시도 때 다시 본다. 안전하지 않다는 결과는 다음 준비 확인까지 둔다.
    if (safety.status === "unavailable") this.invalidate();
    throw new IsolationError(
      "격리 실행 환경이 안전한지 확인하지 못해 실행하지 않았습니다."
    );
  }

  async readiness(isolatable: boolean): Promise<ProviderReadinessCheck | null> {
    if (!isolatable || !(await this.#readIsolated())) return null;
    const safety = await this.check();
    if (safety.status === "safe") return null;
    return {
      status: "not_ready",
      reason:
        safety.status === "unsafe"
          ? "isolation_unsafe"
          : "isolation_unavailable",
    };
  }

  /** 확인의 결과는 시한 안에, 또는 관문을 닫으면 바로 정한다. Docker가 늦게 끝내는 일(시험 컨테이너 제거 등)을 기다리지 않는다. */
  async #probe(): Promise<Safety> {
    const docker = this.#docker;
    if (!docker || this.#windows || this.#lifetime.signal.aborted)
      return { status: "unavailable" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed: (() => void) | undefined;
    const ended = new Promise<Safety>((resolve) => {
      const end = (reason: Error) => {
        controller.abort(reason);
        resolve({ status: "unavailable" });
      };
      timer = setTimeout(() => {
        console.error("[isolation] safety check did not finish in time");
        end(new Error("isolation safety check timed out"));
      }, this.#timeoutMs);
      closed = () => end(new Error("isolation gate closed"));
      this.#lifetime.signal.addEventListener("abort", closed, { once: true });
    });
    try {
      return await Promise.race([
        this.#examine(docker, controller.signal),
        ended,
      ]);
    } finally {
      clearTimeout(timer);
      if (closed) this.#lifetime.signal.removeEventListener("abort", closed);
    }
  }

  async #examine(
    docker: DockerEnvironment,
    signal: AbortSignal
  ): Promise<Safety> {
    try {
      await docker.checkDaemon(signal);
      signal.throwIfAborted();
      const addresses = Object.values(os.networkInterfaces())
        .flatMap((interfaces) => interfaces ?? [])
        .map((address) => address.address)
        .filter((address) => !address.startsWith("fe80:"));
      const hosts = [...new Set(["127.0.0.1", ...addresses])];
      const targets = hosts.flatMap((host) =>
        [...new Set(this.#protectedPorts())].map((port) => ({ host, port }))
      );
      const result = await docker.probe(
        { blocked: targets, forbidden: targets },
        signal
      );
      if (
        result.interfaces.length > 0 ||
        result.reached.length > 0 ||
        result.proxied.length > 0
      )
        return { status: "unsafe" };
      if (!result.toolsReached) return { status: "unavailable" };
      return { status: "safe", toolsBaseUrl: containerToolsOrigin };
    } catch (error) {
      console.error("[isolation] safety check failed", error);
      return { status: "unavailable" };
    }
  }

  /** 관문을 닫는다. 진행 중인 확인은 격리 환경 없음으로 끝나고 그 뒤로는 확인하지 않는다. */
  async close(): Promise<void> {
    this.#lifetime.abort();
  }
}
