import { execFile, type ExecFileException } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { failureCode } from "@babojubot/contracts";

import { pinnedReaderFile } from "../src/workspace.ts";
import { withCleanup } from "@babojubot/process/test-cleanup";
import {
  removeFolderWithin,
  type testFolders,
} from "@babojubot/process/testing";

/**
 * 파일 경계 시험이 임시 폴더를 만드는 곳. 환경별 전체 검증(CI `files-*` job)은 시험용 디스크·공유의 폴더를
 * `BABOJUBOT_FILES_TMPDIR`로 넘겨 그 파일 시스템에서 같은 시험을 돌린다. 없으면 운영체제의 임시 폴더다.
 */
export const filesBase = () => process.env.BABOJUBOT_FILES_TMPDIR || tmpdir();

/**
 * 시험이 띄운 프로그램이 어떻게 끝났는지(실패 원인으로 남긴다). 시한(`timeout`)이나 정리가 죽였으면 그 신호를, 스스로 끝났으면 종료 코드나
 * 띄우기 실패 코드를 적는다.
 */
export const childEnded = (error: ExecFileException) =>
  error.killed
    ? `killed with ${error.signal}`
    : error.signal
      ? `ended by ${error.signal}`
      : `failed (${error.code})`;

/** 시험 파일의 폴더 정리(`testFolders`, `@babojubot/process/testing`). 폴더와 그 안에서 도는 것의 끝을 함께 맡는다. */
export type Folders = ReturnType<typeof testFolders>;
/**
 * 시험마다 새 임시 폴더. 만든 직후 시험 파일의 폴더 정리(`folders`)에 맡긴다. 그 안에서 도는 것(읽는 프로세스, socket 파일 서버,
 * 막은 권한)은 `folders.own`·`folders.ownChild`로 맡기면, 정리가 그것을 모두 끝낸 뒤에만 폴더를 지운다(끝나지 않으면 남기고 실패).
 */
export async function scratch(folders: Folders, prefix: string) {
  return folders.adopt(await mkdtemp(path.join(filesBase(), prefix)));
}
/**
 * 지우기의 다시 시도. SMB 등에서는 지운 항목이 잠시 남아 폴더를 바로 지우지 못하므로 기본보다 길게 다시 시도한다. 시험 파일의 폴더
 * 정리(`testFolders(afterEach, removeRetries)`)와 `remove`가 함께 쓴다.
 */
export const removeRetries = {
  retries: 10,
  retryDelayMs: 200,
  // 폴더 하나 지우기를 기다리는 시한(`testFolders`). 다시 시도 사이 대기의 합(200ms × 1..10 = 11초, `removeFolder`)보다 길게 둔다.
  removeTimeoutMs: 30_000,
};
/** 지운다(`removeRetries`, 시한 안에서: `removeFolderWithin`). */
export const remove = (folder: string) =>
  removeFolderWithin(folder, removeRetries);

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
    const made = await mkdtemp(path.join(filesBase(), "bjc-probe-"));
    return withCleanup(async (defer) => {
      // 만든 직후 정리에 맡긴다. 지우지 못해도(시한 안에 지우지 못한 것 포함) 기능 판정은 맞다. 그 원인 코드를 경고로 남기고 볼륨
      // 정리 단계에 맡긴다. 지우기는 시험 폴더와 같은 시한 안에서 기다린다(`remove`).
      defer(() =>
        remove(made).catch((error: unknown) =>
          console.warn(
            `could not remove the feature probe folder ${made} (${failureCode(error)}: ${error instanceof Error ? error.message : String(error)}); it is left for the volume cleanup`
          )
        )
      );
      const probe = await realpath(made);
      const attempt = async (work: () => Promise<unknown>) => {
        try {
          await work();
          return "";
        } catch (error) {
          return (error as NodeJS.ErrnoException).code ?? String(error);
        }
      };
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
    });
  })());

export const windows = process.platform === "win32";

/** 읽는 프로세스 하나의 결과. 끝난 코드(성공이면 0), 고른 위치, 읽은 바이트다. */
export type PinnedResult = {
  code: unknown;
  parts: string[] | null;
  bytes: Buffer | null;
};
/**
 * 읽는 프로세스보다 먼저 도는 코드(`--import`). `node:fs/promises`의 함수를 바꿔 끼우고, 바꾼 값이 이 뒤에 가져오는 ES
 * module(`@babojubot/files` 포함)에도 보이게 한다(node:module `syncBuiltinESMExports`). 빈 코드면 아무것도 앞에 두지 않는다.
 */
export const preloadArgs = (code: string) =>
  code === ""
    ? []
    : [
        "--import",
        `data:text/javascript,${encodeURIComponent(
          `${code}\nprocess.getBuiltinModule("node:module").syncBuiltinESMExports();\n`
        )}`,
      ];
/**
 * 서버와 같은 읽는 프로세스(`pinnedReaderFile`)를 띄우되 `preload` 코드를 먼저 돌려 파일 작업 사이에 바꿔치기를 넣는다.
 * `cwd`는 서버처럼 `organizations` 폴더의 실제 경로다.
 */
export const runPinned = (
  folders: Folders,
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
    // 띄운 직후 폴더 정리에 맡긴다. 그 폴더(`cwd`)는 이 프로세스의 끝(`close`)을 확인한 뒤에만 지운다.
    folders.ownChild(
      execFile(
        process.execPath,
        [
          ...preloadArgs(preload),
          pinnedReaderFile,
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
          // 종료 코드가 없으면(신호로 끝남) 어떻게 끝났는지를 대신 남긴다. 알려진 종료 코드가 아니므로 시험이 그 값을 실패로 보인다.
          if (error)
            return resolve({
              code: error.code ?? childEnded(error),
              parts: null,
              bytes: null,
            });
          const at = stdout.indexOf(0x0a);
          resolve({
            code: 0,
            parts: JSON.parse(stdout.subarray(0, at).toString("utf8")),
            bytes: stdout.subarray(at + 1),
          });
        }
      )
    );
  });

/** 실제 경로로 푼 임시 폴더. 읽는 프로세스의 `cwd`처럼 링크 없는 경로가 필요할 때 쓴다. */
export const realScratch = async (folders: Folders, prefix: string) =>
  realpath(await scratch(folders, prefix));
