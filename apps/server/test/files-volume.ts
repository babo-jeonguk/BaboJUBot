import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinnedReader } from "../src/workspace.ts";

/**
 * 파일 경계 시험이 임시 폴더를 만드는 곳. 환경별 전체 검증(CI `files-*` job)은 시험용 디스크·공유의 폴더를
 * `BABOJUBOT_FILES_TMPDIR`로 넘겨 그 파일 시스템에서 같은 시험을 돌린다. 없으면 운영체제의 임시 폴더다.
 */
export const filesBase = () => process.env.BABOJUBOT_FILES_TMPDIR || tmpdir();

const made: string[] = [];
/** 시험마다 새 임시 폴더. `cleanup`이 지운다. */
export async function scratch(prefix: string) {
  const created = await mkdtemp(path.join(filesBase(), prefix));
  made.push(created);
  return created;
}
/** 지운다. SMB 등에서는 지운 항목이 잠시 남아 폴더를 바로 지우지 못하므로 다시 시도한다(Node `rm`의 maxRetries). */
export const remove = (folder: string) =>
  rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
export async function cleanup() {
  await Promise.all(made.splice(0).map(remove));
}

/** 이 파일 시스템에 없는 기능과 그 오류 코드. 빈 문자열이면 있다(FAT은 링크가 없다). */
export type FeatureGaps = {
  symlink: string;
  hardLink: string;
  junction: string;
};
/**
 * 기능 탐침의 실패가 이 파일 시스템에 그 기능이 없다는 근거면 적용 불가(n/a), 아니면 준비하지 못한 것이라
 * 미검증이다. 같은 오류 코드도 어떤 작업이 실패했는지에 따라 뜻이 달라 작업과 함께 판정한다.
 */
export function gapOutcome(
  feature: keyof FeatureGaps,
  code: string,
  platform: NodeJS.Platform = process.platform
): "n/a" | "unverified" {
  const absent =
    ["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code) ||
    // Windows의 ERROR_INVALID_FUNCTION(libuv EISDIR): FAT32는 링크·hard link·정션을 만들지 못한다.
    (platform === "win32" && code === "EISDIR") ||
    // symlink(2)의 EPERM은 링크를 지원하지 않는 파일 시스템뿐이다. link(2)의 EPERM은 권한 정책일 수도 있고,
    // Windows의 EPERM은 링크 권한이 없는 계정이다.
    (feature === "symlink" && platform !== "win32" && code === "EPERM") ||
    // SMB 공유: 만든 정션을 운영체제가 보지 못한다.
    (feature === "junction" && code === "INVISIBLE");
  return absent ? "n/a" : "unverified";
}
/**
 * 만든 정션을 lstat한 결과. 링크로 보이면 "", 운영체제가 보지 못하면(ENOENT) INVISIBLE, 그 밖의 오류는 그 코드,
 * 보이지만 링크가 아니면 NOT_A_LINK.
 */
export function junctionSeen(
  result: { isSymbolicLink(): boolean } | NodeJS.ErrnoException
) {
  if (result instanceof Error)
    return result.code === "ENOENT"
      ? "INVISIBLE"
      : (result.code ?? String(result));
  return result.isSymbolicLink() ? "" : "NOT_A_LINK";
}
let gaps: Promise<FeatureGaps> | undefined;
export const featureGaps = () =>
  (gaps ??= (async () => {
    const probe = await realpath(
      await mkdtemp(path.join(filesBase(), "bjc-probe-"))
    );
    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await work();
        return "";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code ?? String(error);
      }
    };
    try {
      await writeFile(path.join(probe, "file"), "x");
      await mkdir(path.join(probe, "folder"));
      return {
        symlink: await attempt(async () => {
          await symlink("file", path.join(probe, "link"), "file");
          await symlink("folder", path.join(probe, "folder-link"), "dir");
        }),
        hardLink: await attempt(() =>
          link(path.join(probe, "file"), path.join(probe, "hard"))
        ),
        // SMB 공유에 만든 정션은 만들어져도 운영체제가 보지 못한다(lstat ENOENT). 보이는 정션만 있다고 본다.
        junction: windows
          ? (await attempt(() =>
              symlink(
                path.join(probe, "folder"),
                path.join(probe, "junction"),
                "junction"
              )
            )) ||
            junctionSeen(
              await lstat(path.join(probe, "junction")).catch(
                (error: NodeJS.ErrnoException) => error
              )
            )
          : "not Windows",
      };
    } finally {
      // 지우지 못해도 기능 판정은 맞다. 남은 항목을 알리고 볼륨 정리 단계에 맡긴다.
      await remove(probe).catch(async (error: NodeJS.ErrnoException) =>
        console.warn(
          `could not remove ${probe} (${error.code}); left: ${JSON.stringify(await listEntries(probe))}`
        )
      );
    }
  })());

/** 폴더 안의 항목과 종류. 지우지 못한 이유를 보일 때 쓴다. */
export async function listEntries(folder: string) {
  const entries = await readdir(folder).catch(
    (error: NodeJS.ErrnoException) => [`<${error.code}>`]
  );
  return Promise.all(
    entries.map(async (name) => {
      const info = await lstat(path.join(folder, name)).catch(() => undefined);
      return `${name}:${info ? (info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file") : "?"}`;
    })
  );
}

export const windows = process.platform === "win32";

/** 읽는 프로세스 하나의 결과. 끝난 코드(성공이면 0), 고른 위치, 읽은 바이트다. */
export type PinnedResult = {
  code: unknown;
  parts: string[] | null;
  bytes: Buffer | null;
};
/**
 * 서버와 같은 읽는 프로세스(`pinnedReader`)를 띄우되 앞에 `preload` 코드를 붙여 파일 작업 사이에 바꿔치기를 넣는다.
 * `cwd`는 서버처럼 `organizations` 폴더의 실제 경로다.
 */
export const runPinned = (
  cwd: string,
  preload: string,
  options: {
    organizationId?: string;
    requested: string;
    plan?: unknown;
    maxBytes?: number;
  }
) =>
  new Promise<PinnedResult>((resolve) => {
    const organizationId = options.organizationId ?? "organization-one";
    const shared = path.join(cwd, organizationId, "shared");
    execFile(
      process.execPath,
      [
        "-e",
        preload + pinnedReader,
        JSON.stringify([
          options.maxBytes ?? 1000,
          organizationId,
          options.requested,
          shared,
          shared,
        ]),
      ],
      {
        cwd,
        encoding: "buffer",
        timeout: 30_000,
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          PLAN: JSON.stringify(options.plan ?? {}),
        },
      },
      (error, stdout) => {
        if (error)
          return resolve({ code: error.code, parts: null, bytes: null });
        const at = stdout.indexOf(0x0a);
        resolve({
          code: 0,
          parts: JSON.parse(stdout.subarray(0, at).toString("utf8")),
          bytes: stdout.subarray(at + 1),
        });
      }
    );
  });

/** 실제 경로로 푼 임시 폴더. 읽는 프로세스의 `cwd`처럼 링크 없는 경로가 필요할 때 쓴다. */
export const realScratch = async (prefix: string) =>
  realpath(await scratch(prefix));
