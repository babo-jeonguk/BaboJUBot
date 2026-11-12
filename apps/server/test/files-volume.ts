import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
export async function cleanup() {
  await Promise.all(
    made.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
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
