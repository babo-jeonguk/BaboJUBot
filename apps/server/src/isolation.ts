import http from "node:http";
import type net from "node:net";
import os from "node:os";
import type express from "express";
import type { ProviderReadinessCheck } from "@babojubot/contracts";
import type { DockerEnvironment } from "@babojubot/runtime";

/** 격리 실행을 시작하지 않은 이유. 제품이 쓴 안내라 실행 시도의 실패 문장으로 그대로 보인다. */
export class IsolationError extends Error {}

/** 실행 시도·세션 정비가 돌 곳과 그때의 조직 도구 주소. */
export type Placement = { execution?: "container"; toolsBaseUrl: string };

type Safety =
  | { status: "safe"; toolsBaseUrl: string }
  | { status: "unsafe" | "unavailable" };

/**
 * 격리 실행의 관문. 조직 도구만 담은 전용 listener를 Docker 전용 네트워크의 gateway 주소에 열고,
 * 실행 시도와 같은 네트워크의 시험 컨테이너로 사용자 API·DB 포트에 닿지 않고 전용 listener에는 닿는지 확인한다.
 * 확인은 한 번 하고 결과를 나눠 쓰며 준비 확인을 다시 할 때 새로 한다. 확인을 통과하지 않으면 실제 연결은
 * 준비안됨이고 실행 시도는 컨테이너에서도 이 컴퓨터에서도 시작하지 않는다.
 * 닫으면 진행 중인 확인을 끝내고 그 뒤로는 확인하지 않는다(격리 환경 없음).
 */
export class IsolationGate {
  readonly #docker: DockerEnvironment | undefined;
  readonly #toolsApp: express.Express;
  readonly #protectedPorts: () => number[];
  readonly #readIsolated: () => Promise<boolean>;
  readonly #hostUrl: () => string;
  readonly #timeoutMs: number;
  /** 관문의 수명. 닫으면 진행 중인 확인을 끝내고 새 확인·listener를 열지 않는다. */
  readonly #lifetime = new AbortController();
  #current: Promise<Safety> | undefined;
  #listener:
    { gateway: string; server: http.Server; origin: string } | undefined;

  constructor(options: {
    docker: DockerEnvironment | undefined;
    /** 조직 도구 경로만 담은 앱. 전용 listener가 쓴다. */
    toolsApp: express.Express;
    /** 컨테이너에서 막혀야 하는 이 컴퓨터의 포트(사용자 API·DB). 부를 때 읽는다(사용자 API 포트는 listen 뒤에 정해짐). */
    protectedPorts: () => number[];
    readIsolated: () => Promise<boolean>;
    /** 격리하지 않는 실행의 조직 도구 주소(사용자 API 주소). */
    hostUrl: () => string;
    /** 안전 확인 한 번의 시한. 넘으면 격리 환경 없음이다. 기본 60초. */
    timeoutMs?: number;
  }) {
    this.#docker = options.docker;
    this.#toolsApp = options.toolsApp;
    this.#protectedPorts = options.protectedPorts;
    this.#readIsolated = options.readIsolated;
    this.#hostUrl = options.hostUrl;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
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
    if (!docker || this.#lifetime.signal.aborted)
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
      const { gateway } = await docker.prepareNetwork(signal);
      signal.throwIfAborted();
      const tools = await this.#listen(gateway, signal);
      const addresses = Object.values(os.networkInterfaces())
        .flatMap((interfaces) => interfaces ?? [])
        .filter(
          (address) => !address.internal && !address.address.startsWith("fe80:")
        );
      const hosts = [
        ...new Set([
          gateway,
          "host.docker.internal",
          ...addresses.map((address) => address.address),
        ]),
      ];
      const blocked = hosts.flatMap((host) =>
        [...new Set(this.#protectedPorts())].map((port) => ({ host, port }))
      );
      const result = await docker.probe({ blocked, tools }, signal);
      if (result.reached.length > 0) return { status: "unsafe" };
      if (!result.toolsReached) return { status: "unavailable" };
      return { status: "safe", toolsBaseUrl: tools };
    } catch (error) {
      console.error("[isolation] safety check failed", error);
      return { status: "unavailable" };
    }
  }

  async #listen(gateway: string, signal: AbortSignal): Promise<string> {
    if (this.#listener?.gateway === gateway) return this.#listener.origin;
    await this.#closeListener();
    signal.throwIfAborted();
    const server = http.createServer(this.#toolsApp);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        server.off("listening", ready);
        reject(error);
      };
      const ready = () => {
        server.off("error", fail);
        resolve();
      };
      server.once("error", fail);
      server.once("listening", ready);
      server.listen(0, gateway);
    });
    // 여는 사이 확인이 끝났거나(시한·닫힘) 관문을 닫았으면 이 listener를 남기지 않는다.
    if (signal.aborted) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      signal.throwIfAborted();
    }
    const address = server.address() as net.AddressInfo;
    const host = gateway.includes(":") ? `[${gateway}]` : gateway;
    const origin = `http://${host}:${address.port}`;
    this.#listener = { gateway, server, origin };
    return origin;
  }

  async #closeListener() {
    const listener = this.#listener;
    this.#listener = undefined;
    if (!listener) return;
    listener.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      listener.server.close(() => resolve())
    );
  }

  /** 관문을 닫는다. 진행 중인 확인은 격리 환경 없음으로 끝나고, 닫은 뒤에는 확인도 listener도 다시 열지 않는다. */
  async close(): Promise<void> {
    this.#lifetime.abort();
    await this.#closeListener();
  }
}
