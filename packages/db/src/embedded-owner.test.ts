import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { removeFolder } from "@babojubot/process/remove-folder";
import { folderCleanup } from "@babojubot/process/test-cleanup";
import { attemptAll } from "@babojubot/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startEmbeddedCluster } from "./embedded.ts";

// 내장 DB 폴더 주인의 연결(#268, #275 외부 리뷰 1회차). 주인 연결은 이 사용자 전용 폴더에만 두고, 다른 프로세스는 기록의 자리로
// 연결만 해 볼 뿐 지우지 않는다. 연 연결은 실패한 길에서도 닫는다. 소켓 경로 한도는 바이트로 잰다. Windows는 named pipe라
// 파일·경로 한도가 없어 이 파일의 시험은 POSIX에서만 돈다.
const inject = vi.hoisted(() => ({
  /** 주인 기록(`<dataDir>.owner/<번호>`)을 붙이는 hard link가 이 오류로 실패한다. */
  recordFails: undefined as Error | undefined,
}));
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
const ownerSocket = /^babojubot-owner-[0-9a-f]{16}\.sock$/;

/**
 * 이 시험만 쓰는 임시 폴더를 이 프로세스의 임시 폴더로 둔다(제품은 그 아래 `babojubot-<uid>`에 주인 연결을 둔다). 사용자 실행
 * 폴더(`XDG_RUNTIME_DIR`)는 비워 임시 폴더를 쓰게 한다.
 */
async function ownTemporaryFolder(name = "babojubot-owner-tmp-") {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), name));
  onTestFinished(() => removeFolder(base));
  vi.stubEnv("TMPDIR", base);
  vi.stubEnv("XDG_RUNTIME_DIR", "");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  return base;
}

/** `folder` 안에서 지금 연결을 받는 주인 소켓들. */
async function listening(folder: string) {
  const names = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  const open: string[] = [];
  for (const name of names.filter((each) => ownerSocket.test(each))) {
    const socket = path.join(folder, name);
    const answered = await new Promise<boolean>((resolve) => {
      const client = net.connect(socket);
      const timer = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 2_000);
      client.once("connect", () => {
        clearTimeout(timer);
        client.destroy();
        resolve(true);
      });
      client.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (answered) open.push(name);
  }
  return open;
}

const privateFolder = (base: string) =>
  path.join(base, `babojubot-${process.getuid!()}`);
/** 이 시험의 임시 폴더 안 어디서든(그 폴더 바로 아래와 이 사용자 전용 폴더) 연결을 받는 주인 소켓. */
const listeningUnder = async (base: string) => [
  ...(await listening(base)),
  ...(await listening(privateFolder(base))),
];

describe.runIf(posix)(
  "the owner connection of an embedded Postgres folder",
  () => {
    // STD-2: 주인 연결을 연 뒤 기록을 쓰지 못하면, 이번에 연 연결을 닫고 실패한다. 연결이 남으면 주인이 아닌 프로세스가 주인처럼 보인다.
    it("closes the connection it opened when its owner record cannot be written", async () => {
      const base = await ownTemporaryFolder();
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
      expect(await listeningUnder(base)).toEqual([]);
    });

    // 권고: 한 프로세스가 같은 폴더를 동시에 두 번 열어도 주인 연결은 하나만 남는다. 앞 연결을 덮어 잃으면 내려놓을 때 닫지 못한다.
    it("keeps a single owner connection when one process opens the same folder twice at once", async () => {
      const base = await ownTemporaryFolder();
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const opened = await Promise.allSettled([
        startEmbeddedCluster({ dataDir, persistent: true }),
        startEmbeddedCluster({ dataDir, persistent: true }),
      ]);
      const started = opened.flatMap((each) =>
        each.status === "fulfilled" ? [each.value] : []
      );
      const refused = opened.flatMap((each) =>
        each.status === "rejected" ? [each.reason] : []
      );
      onTestFinished(() =>
        attemptAll(started.map((cluster) => () => cluster.stop()))
      );
      expect(started).toHaveLength(1);
      expect(refused).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("in use by a running process"),
        }),
      ]);
      expect(await listeningUnder(base)).toHaveLength(1);
      await started[0]!.stop();
      expect(await listeningUnder(base)).toEqual([]);
    }, 60_000);

    // SPEC-2·STD-1: 기록이 가리키는 소켓은 연결만 해 본다. 다른 폴더의, 이름만 같은 죽은 소켓을 지우지 않는다(주인이 죽었다는 판단은 그대로).
    it("never removes a socket that an owner record points to", async () => {
      const base = await ownTemporaryFolder();
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
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.once("data", () => resolve());
        holder.once("exit", () => reject(new Error("the socket holder ended")));
      });
      const ended = new Promise((resolve) => holder.once("exit", resolve));
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
      const cluster = await startEmbeddedCluster({ dataDir, persistent: true });
      const cleanup = folderCleanup(() => cluster.stop());
      onTestFinished(cleanup.cleanUp);
      expect(fs.lstatSync(stale).isSocket()).toBe(true);
    }, 60_000);

    // SPEC-1: 소켓 경로 한도(Linux 107, macOS 103)는 바이트다. 글자 수로 재면 한글 경로가 한도를 넘는데도 그 자리에 듣다가 실패한다.
    it("measures the socket path limit in bytes", async () => {
      const limit = process.platform === "darwin" ? 103 : 107;
      const parent = os.tmpdir();
      // 글자 수로는 한도 안, 바이트로는 한도 밖인 폴더 이름(한 글자 3바이트).
      const letters = limit - parent.length - 60;
      expect(letters).toBeGreaterThan(10);
      const base = await ownTemporaryFolder(`${"한".repeat(letters)}-`);
      expect(Buffer.byteLength(base)).toBeGreaterThan(limit);
      const dataDir = await fsp.mkdtemp(path.join(base, "babojubot-pg-"));
      const cluster = await startEmbeddedCluster({ dataDir, persistent: true });
      await cluster.stop();
      await removeFolder(`${dataDir}.owner`);
    }, 60_000);
  }
);
