import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isDisconnect } from "@babojubot/contracts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { awaitedLater, folderCleanup } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ephemeralCluster,
  startEmbeddedCluster,
  type EmbeddedCluster,
  type EmbeddedOptions,
} from "./embedded.ts";

// 내장 DB 폴더 주인의 연결(#268, #275 외부 리뷰 1·2회차). 주인 연결은 이 사용자 전용 폴더에만 두고, 다른 프로세스는 기록의 자리로
// 연결만 해 볼 뿐 지우지 않는다. 연 연결은 실패한 길에서도 닫는다. 소켓 경로 한도는 바이트로 잰다. Windows는 named pipe라
// 파일·경로 한도가 없어 이 파일의 시험은 POSIX에서만 돈다.
const inject = vi.hoisted(() => ({
  /** 주인 기록(`<dataDir>.owner/<번호>`)을 붙이는 hard link가 이 오류로 실패한다. */
  recordFails: undefined as Error | undefined,
  /** 임시 cluster 폴더(`babojubot-pg-…`)를 지우면 이 오류로 실패한다. */
  removeFails: undefined as Error | undefined,
  /** 주인 연결을 그 자리(경로)에서 듣지 못하게 한다. 오류를 돌려주면 듣기가 그 오류로 실패한다. */
  listenFails: undefined as ((handle: string) => Error | undefined) | undefined,
  /** 제품이 경로에서 듣기를 시도한 자리와 그 결과. 주입한 실패도 여기 남는다. */
  listens: [] as { handle: string; failure?: Error }[],
  /** 제품이 경로에서 실제로 듣기 시작한 자리(듣기가 성공해 알린 뒤에 남긴다). 그 자리가 닫혔는지는 이 목록으로 본다. */
  listened: [] as string[],
  /** 경로에서 들은 서버의 닫기가 실제로 닫힌 뒤 이 오류로 끝난다(#286). */
  closeFails: undefined as Error | undefined,
}));
vi.mock("node:net", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:net")>();
  // 경로(소켓·pipe)에서 듣는 서버만 본다. 번호로 듣는 서버(빈 port 고르기)는 그대로 둔다.
  const createServer = ((...args: Parameters<typeof real.createServer>) => {
    const server = real.createServer(...args);
    const listen = server.listen.bind(server);
    const listenAt = (...listenArgs: unknown[]) => {
      const [handle, callback] = listenArgs;
      if (typeof handle !== "string")
        return listen(...(listenArgs as Parameters<typeof listen>));
      if (listenArgs.length !== 2 || typeof callback !== "function")
        throw new Error(
          `the owner connection was listened in an unexpected way: ${JSON.stringify(listenArgs)}`
        );
      const failure = inject.listenFails?.(handle);
      inject.listens.push({ handle, ...(failure && { failure }) });
      if (failure) {
        process.nextTick(() => server.emit("error", failure));
        return server;
      }
      // 이 서버의 닫기는 실제로 닫은 뒤, 실패를 주입했으면 그 오류로 답한다.
      const close = server.close.bind(server);
      server.close = ((done?: (error?: Error) => void) =>
        close((error) =>
          done?.(inject.closeFails ?? error)
        )) as typeof server.close;
      return listen(handle, () => {
        inject.listened.push(handle);
        (callback as () => void)();
      });
    };
    server.listen = listenAt as typeof server.listen;
    return server;
  }) as typeof real.createServer;
  return { ...real, createServer, default: { ...real, createServer } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof real.rm = async (target, options) => {
    if (inject.removeFails && String(target).includes("babojubot-pg-"))
      throw inject.removeFails;
    return real.rm(target, options);
  };
  return { ...real, rm, default: { ...real, rm } };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const linkSync = ((existing, target) => {
    if (inject.recordFails && /\.owner[\\/]\d+$/.test(String(target)))
      throw inject.recordFails;
    return real.linkSync(existing, target);
  }) as typeof real.linkSync;
  return { ...real, linkSync, default: { ...real, linkSync } };
});

const posix = process.platform !== "win32";

beforeEach(() => {
  inject.closeFails = undefined;
  inject.listens = [];
  inject.listened = [];
});

/**
 * 이 시험만 쓰는 임시 폴더를 이 프로세스의 임시 폴더로 둔다(제품은 그 아래 `babojubot-<uid>`에 주인 연결을 둔다). 사용자 실행
 * 폴더(`XDG_RUNTIME_DIR`)는 비워 임시 폴더를 쓰게 한다. 그 안에서 띄운 cluster는 `cleanup.own`으로 맡겨, 멈춘 것을 확인한 뒤에만
 * 폴더를 지운다(STD-4).
 */
async function ownTemporaryFolder(name = "babojubot-owner-tmp-") {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), name));
  const cleanup = folderCleanup(() => removeFolder(base));
  onTestFinished(cleanup.cleanUp);
  vi.stubEnv("TMPDIR", base);
  vi.stubEnv("XDG_RUNTIME_DIR", "");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  return { base, cleanup };
}

/**
 * cluster를 띄우고 바로 그 멈춤을 폴더 정리에 맡긴다. 돌려준 `stop`은 한 번만 멈춘다(시험이 멈춰도 정리가 다시 멈추지 않는다).
 */
async function startOwned(
  cleanup: ReturnType<typeof folderCleanup>,
  options: EmbeddedOptions
) {
  const cluster = await startEmbeddedCluster(options);
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= cluster.stop());
  cleanup.own(stop);
  return { cluster, stop };
}

/**
 * 제품이 들었던 자리마다 지금 연결을 받는지(#286 항목 12). 연결되면 "open", 그 자리가 없거나(ENOENT) 듣는 쪽이 없으면(ECONNREFUSED)
 * "closed"다. 그 밖의 오류나 상한 초과는 닫힘이 아니라 확인하지 못한 것이라 시험을 실패시킨다. 어느 후보 폴더에서 들었든 그 자리를
 * 본다(폴더를 훑지 않는다).
 */
const listenedStates = () =>
  Promise.all(
    inject.listened.map(async (handle) => {
      const client = net.connect(handle);
      try {
        return await within(
          new Promise<"open" | "closed">((resolve, reject) => {
            client.once("connect", () => resolve("open"));
            client.once("error", (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
                resolve("closed");
              else reject(error);
            });
          }),
          10_000,
          `the owner connection ${handle} did not answer`
        );
      } finally {
        client.destroy();
      }
    })
  );

const privateFolder = (base: string) =>
  path.join(base, `babojubot-${process.getuid!()}`);
describe.runIf(posix)(
  "the owner connection of an embedded Postgres folder",
  () => {
    // STD-2: 주인 연결을 연 뒤 기록을 쓰지 못하면, 이번에 연 연결을 닫고 실패한다. 연결이 남으면 주인이 아닌 프로세스가 주인처럼 보인다.
    it("closes the connection it opened when its owner record cannot be written", async () => {
      const { base } = await ownTemporaryFolder();
      const failure = Object.assign(
        new Error("injected: the owner record could not be written"),
        { code: "EIO" }
      );
      inject.recordFails = failure;
      onTestFinished(() => {
        inject.recordFails = undefined;
      });
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      await expect(
        startEmbeddedCluster({ dataDir, persistent: true })
      ).rejects.toBe(failure);
      inject.recordFails = undefined;
      expect(await listenedStates()).toEqual(["closed"]);
    });

    // 권고: 한 프로세스가 같은 폴더를 동시에 두 번 열어도 주인 연결은 하나만 남는다. 앞 연결을 덮어 잃으면 내려놓을 때 닫지 못한다.
    it("keeps a single owner connection when one process opens the same folder twice at once", async () => {
      const { base, cleanup } = await ownTemporaryFolder();
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const stops: (() => Promise<void>)[] = [];
      const opened = await Promise.allSettled(
        [0, 1].map(async () => {
          const { stop } = await startOwned(cleanup, {
            dataDir,
            persistent: true,
          });
          stops.push(stop);
        })
      );
      const refused = opened.flatMap((each) =>
        each.status === "rejected" ? [each.reason] : []
      );
      expect(stops).toHaveLength(1);
      expect(refused).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("in use by a running process"),
        }),
      ]);
      expect(await listenedStates()).toEqual(["open"]);
      await stops[0]!();
      expect(await listenedStates()).toEqual(["closed"]);
    }, 60_000);

    // STD-3: 임시 cluster는 Postgres를 멈춘 뒤 폴더 지우기가 실패해도 주인 연결을 닫는다. 폴더 지우기와 연결 닫기는 서로 독립이라,
    // 앞이 실패해도 뒤를 하고 실패는 모아 알린다. 남은 폴더는 주인이 없으니 다음 시작의 남은 cluster 정리가 가져가 지운다.
    it("releases its owner connection when removing its temporary folder fails after Postgres stopped", async () => {
      const { cleanup } = await ownTemporaryFolder();
      const options = await ephemeralCluster();
      const failure = Object.assign(
        new Error("injected: the temporary folder could not be removed"),
        { code: "EBUSY" }
      );
      const cluster: EmbeddedCluster = await startEmbeddedCluster(options);
      // 시험의 멈춤이 기대한 대로 실패하면, 정리는 남은 폴더만 지운다(Postgres는 이미 멈췄다).
      let stopping: Promise<void> | undefined;
      cleanup.own(() => (stopping ??= cluster.stop()));
      // 실패를 주입하기 전에 주인 연결이 실제로 열려 있음을 본다.
      expect(await listenedStates()).toEqual(["open"]);
      inject.removeFails = failure;
      onTestFinished(() => {
        inject.removeFails = undefined;
      });
      stopping = cluster.stop();
      await expect(stopping).rejects.toThrow(failure.message);
      stopping = Promise.resolve();
      inject.removeFails = undefined;
      expect(await listenedStates()).toEqual(["closed"]);
    }, 60_000);

    // #286: 주인 연결의 닫기는 끝날 때까지 기다리고 그 실패를 받는다. 닫기를 기다리지 않으면 닫기 실패가 사라지고, 내려놓음이 끝난
    // 뒤에도 연결이 아직 열려 있을 수 있다. 영구 cluster의 멈춤은 그 실패로 끝난다(Postgres는 이미 멈췄다).
    it("fails a persistent stop with the owner connection's close failure", async () => {
      const { base, cleanup } = await ownTemporaryFolder();
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const cluster = await startEmbeddedCluster({ dataDir, persistent: true });
      let stopped = false;
      cleanup.own(() => (stopped ? undefined : cluster.stop()));
      const failure = Object.assign(
        new Error("injected: the owner connection could not be closed"),
        { code: "EIO" }
      );
      inject.closeFails = failure;
      const stopping = cluster.stop();
      stopped = true;
      await expect(stopping).rejects.toMatchObject({
        code: "EMBEDDED_OWNER_CLOSE_FAILED",
        cause: failure,
      });
      inject.closeFails = undefined;
      expect(await listenedStates()).toEqual(["closed"]);
    }, 60_000);

    // #288 리뷰 2회차 STD-3: 주인 연결의 닫기에는 시간 상한을 두지 않는다. 그 서버는 받은 연결을 처리기에서 바로 끊으므로(`holdConnection`)
    // 닫기의 끝이 상대에 달려 있지 않다. 상대가 연결한 뒤 자기 쪽을 닫지 않고 쥐고 있어도 멈춤은 끝나고 소켓 파일은 사라진다.
    it("releases its owner connection while another side keeps its end of a connection open", async () => {
      const { base, cleanup } = await ownTemporaryFolder();
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const { stop } = await startOwned(cleanup, { dataDir, persistent: true });
      expect(inject.listened).toHaveLength(1);
      const handle = inject.listened[0]!;
      // 상대 쪽은 끝을 받아도 스스로 닫지 않는다(allowHalfOpen). 상대가 끊어 생긴 오류(끊김)만 답으로 받고, 그 밖의 오류는 시험 실패다.
      const peer = net.connect({ path: handle, allowHalfOpen: true });
      let peerFailure: unknown;
      peer.on("error", (error) => {
        if (!isDisconnect(error)) peerFailure ??= error;
      });
      onTestFinished(() => {
        peer.destroy();
      });
      await within(
        new Promise<void>((resolve) => peer.once("connect", () => resolve())),
        10_000,
        "the other side did not connect to the owner connection"
      );
      await within(
        stop(),
        30_000,
        "the stop did not finish while the other side kept its connection"
      );
      expect(fs.existsSync(handle)).toBe(false);
      expect(peer.destroyed).toBe(false);
      expect(peerFailure).toBeUndefined();
    }, 60_000);

    it("fails a temporary stop with the owner connection's close failure", async () => {
      const { cleanup } = await ownTemporaryFolder();
      const options = await ephemeralCluster();
      const cluster = await startEmbeddedCluster(options);
      let stopped = false;
      cleanup.own(() => (stopped ? undefined : cluster.stop()));
      const failure = Object.assign(
        new Error("injected: the owner connection could not be closed"),
        { code: "EIO" }
      );
      inject.closeFails = failure;
      const stopping = cluster.stop();
      stopped = true;
      await expect(stopping).rejects.toMatchObject({
        code: "EMBEDDED_OWNER_CLOSE_FAILED",
        cause: failure,
      });
      inject.closeFails = undefined;
      expect(await listenedStates()).toEqual(["closed"]);
    }, 60_000);

    // 주인 기록을 쓰지 못해 이번에 연 연결을 닫을 때 그 닫기도 실패하면, 원래 실패를 그대로 던지고 닫기 실패는 원인 코드로 남긴다.
    it("keeps the record failure and logs the close failure of the connection it opened", async () => {
      const { base } = await ownTemporaryFolder();
      const failure = Object.assign(
        new Error("injected: the owner record could not be written"),
        { code: "EIO" }
      );
      inject.recordFails = failure;
      inject.closeFails = Object.assign(
        new Error("injected: the owner connection could not be closed"),
        { code: "EIO" }
      );
      onTestFinished(() => {
        inject.recordFails = undefined;
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => logged.mockRestore());
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      await expect(
        startEmbeddedCluster({ dataDir, persistent: true })
      ).rejects.toBe(failure);
      expect(logged.mock.calls).toEqual([
        [expect.stringContaining("(EMBEDDED_OWNER_CLOSE_FAILED)")],
      ]);
      inject.closeFails = undefined;
      expect(await listenedStates()).toEqual(["closed"]);
    });

    // #286 항목 10: 후보 폴더의 검사를 통과해도 실제로 듣기가 실패할 수 있다(소켓을 지원하지 않는 볼륨 등). 듣기까지가 그 후보의
    // 시도라서, 실패하면 다음 후보(`/tmp`)에서 듣는다.
    it("moves on to the next folder when listening in a candidate fails", async () => {
      const { base, cleanup } = await ownTemporaryFolder();
      const first = privateFolder(base);
      const next = privateFolder("/tmp");
      inject.listenFails = (handle) =>
        path.dirname(handle) === first
          ? Object.assign(new Error(`injected: cannot listen at ${handle}`), {
              code: "EOPNOTSUPP",
            })
          : undefined;
      onTestFinished(() => {
        inject.listenFails = undefined;
      });
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const { stop } = await startOwned(cleanup, { dataDir, persistent: true });
      expect(
        inject.listens.map(({ handle, failure }) => ({
          folder: path.dirname(handle),
          failed: failure !== undefined,
        }))
      ).toEqual([
        { folder: first, failed: true },
        { folder: next, failed: false },
      ]);
      await stop();
    }, 60_000);

    // 모든 후보에서 듣기가 실패하면 후보마다 그 원인을 함께 남기고 실패한다.
    it("names the failure of every folder when listening fails in all of them", async () => {
      const { base } = await ownTemporaryFolder();
      inject.listenFails = (handle) =>
        Object.assign(new Error(`injected: cannot listen at ${handle}`), {
          code: "EOPNOTSUPP",
        });
      onTestFinished(() => {
        inject.listenFails = undefined;
      });
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const refused: unknown = await startEmbeddedCluster({
        dataDir,
        persistent: true,
      }).then(
        () => new Error("the cluster started although no folder could listen"),
        (error: unknown) => error
      );
      expect(inject.listens.map(({ handle }) => path.dirname(handle))).toEqual([
        privateFolder(base),
        privateFolder("/tmp"),
      ]);
      expect(refused).toMatchObject({ code: "EMBEDDED_NO_OWNER_FOLDER" });
      const cause = (refused as Error).cause;
      // 듣기 실패는 그 자리를 이름에 담는다(Node의 listen 오류도 그렇다). 후보마다 그 실패가 그대로 남는다.
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors).toEqual(
        inject.listens.map(({ failure }) => failure)
      );
    }, 60_000);

    // SPEC-3: 후보 폴더를 쓸 수 없으면(그 자리에 파일이 있음, 쓰기 권한 없음) 그 후보만 건너뛰고 다음 후보(`/tmp`)로 간다.
    it("moves on to the next folder when a candidate is a file", async () => {
      const { base, cleanup } = await ownTemporaryFolder();
      fs.writeFileSync(privateFolder(base), "");
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const { stop } = await startOwned(cleanup, { dataDir, persistent: true });
      await stop();
    }, 60_000);

    it.skipIf(process.getuid?.() === 0)(
      "moves on to the next folder when a candidate cannot be written",
      async () => {
        const { base, cleanup } = await ownTemporaryFolder();
        // 남이 읽거나 쓸 수 없는(0o077 조건은 맞는) 폴더지만 이 사용자도 쓸 수 없다(0500).
        fs.mkdirSync(privateFolder(base), { mode: 0o500 });
        cleanup.own(() => fsp.chmod(privateFolder(base), 0o700));
        const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
        const { stop } = await startOwned(cleanup, {
          dataDir,
          persistent: true,
        });
        await stop();
      },
      60_000
    );

    // SPEC-2·STD-1: 기록이 가리키는 소켓은 연결만 해 본다. 다른 폴더의, 이름만 같은 죽은 소켓을 지우지 않는다(주인이 죽었다는 판단은 그대로).
    it("never removes a socket that an owner record points to", async () => {
      const { base, cleanup } = await ownTemporaryFolder();
      const elsewhere = await fsp.mkdtemp(path.join(base, "elsewhere-"));
      const stale = path.join(
        elsewhere,
        `babojubot-owner-${randomUUID().replaceAll("-", "").slice(0, 16)}.sock`
      );
      // 듣다가 강제로 끝난 프로그램이 남긴 소켓 파일. 듣는 쪽이 없어 연결은 거절된다.
      const holder = spawn(
        process.execPath,
        [
          "-e",
          `require("node:net").createServer().listen(${JSON.stringify(stale)}, () => console.log("ready"));`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      // 띄운 직후 정리에 맡긴다: 준비 전에 멈추거나 시작하지 못해도 남지 않고, 준비 대기는 시작 실패(`error`)와 끝도 실패로 받는다.
      const ended = awaitedLater(
        new Promise<void>((resolve) => holder.once("exit", () => resolve()))
      );
      cleanup.own(async () => {
        holder.kill("SIGKILL");
        await within(ended, 10_000, "the socket holder did not end");
      });
      await within(
        new Promise<void>((resolve, reject) => {
          holder.stdout!.once("data", () => resolve());
          holder.once("error", reject);
          holder.once("exit", () =>
            reject(new Error("the socket holder ended before it was ready"))
          );
        }),
        30_000,
        "the socket holder did not get ready"
      );
      holder.kill("SIGKILL");
      await ended;
      expect(fs.lstatSync(stale).isSocket()).toBe(true);
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const owners = `${dataDir}.owner`;
      fs.mkdirSync(owners);
      fs.writeFileSync(
        path.join(owners, "1"),
        JSON.stringify({ pid: holder.pid, persistent: true, handle: stale })
      );
      await startOwned(cleanup, { dataDir, persistent: true });
      expect(fs.lstatSync(stale).isSocket()).toBe(true);
    }, 60_000);

    // SPEC-1: 소켓 경로 한도(Linux 107, macOS 103)는 바이트다. 글자 수로 재면 한글 경로가 한도를 넘는데도 그 자리에 듣다가 실패한다.
    it("measures the socket path limit in bytes", async () => {
      const limit = process.platform === "darwin" ? 103 : 107;
      const parent = os.tmpdir();
      // 글자 수로는 한도 안, 바이트로는 한도 밖인 폴더 이름(한 글자 3바이트).
      const letters = limit - parent.length - 60;
      expect(letters).toBeGreaterThan(10);
      const { base, cleanup } = await ownTemporaryFolder(
        `${"한".repeat(letters)}-`
      );
      expect(Buffer.byteLength(base)).toBeGreaterThan(limit);
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const { stop } = await startOwned(cleanup, { dataDir, persistent: true });
      await stop();
    }, 60_000);
  }
);
