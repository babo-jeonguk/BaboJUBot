import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, lstat, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ProviderConnection,
  RunResult,
  Usage,
  SteerMessage,
  SteerOutcome,
} from "@babojubot/contracts";
import {
  callKeyRequiredHeader,
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfProbeFailed,
  orIfUnreadable,
  settled,
  subtractUsage,
  usageAmount,
} from "@babojubot/contracts";
import {
  openRegularFile,
  sameEntry,
  type OpenedRegularFile,
} from "@babojubot/files";
import { organizationKeysPluginSource } from "./opencode-keys-plugin.ts";
import type { UsageUnit } from "@babojubot/contracts";
import { providerUsage } from "./usage.ts";
import { TreeLaunchRefused } from "@babojubot/process";
import {
  startProcess,
  probeTimeoutMs,
  startupLimitMs,
  commandFor,
  providerEnvironment,
  probeEnding,
  runProbe,
} from "./process.ts";
import type { ContainerSettings } from "./container.ts";
import {
  ContainerRefusal,
  placeAttempt,
  type ContainerLaunch,
} from "./container.ts";
import {
  createCredentialRelay,
  residueInFolder,
  residueRefusalFor,
  type RelayGrant,
  type RelayProfile,
  type ResidueCheck,
  residueRefusal,
} from "./credential-relay.ts";
import { providerDestinations } from "./destinations.ts";
import { connectionFolders } from "./folders.ts";
import { record } from "./record.ts";
import { removeAttemptFolder } from "./attempt-folder.ts";
const failure = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더 실행이 실패했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
/**
 * 2.2.6 `session.execution.failed`의 `data.error`(type·선택 status)를 공개할 수 있는 종료 결과로 바꾼다.
 * 원문 `message`·`response.body`는 모델 서비스의 응답·연구 내용·비밀값을 담을 수 있어 옮기지 않고, 제품이 쓴 문구만 쓴다.
 * 요청 거부와 명시적 인증 실패만 구분하며, 그 밖의 종류와 모양이 맞지 않는 값은 일반 실패다.
 */
function failedExecution(error: unknown): RunResult {
  const { type, status } = record(error);
  const http =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? `(HTTP ${status})`
      : "";
  if (type === "provider.invalid-request")
    return {
      ...failure(),
      error: `모델 서비스가 요청을 거부했습니다${http}. 도구 정의나 입력이 이 모델과 맞지 않을 수 있습니다.`,
    };
  if (type === "provider.auth")
    return {
      ...failure(),
      error: `모델 서비스가 인증을 거부했습니다${http}. 프로바이더 로그인을 확인해 주세요.`,
      errorCode: "login_required",
    };
  return failure();
}
class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Provider request failed");
    this.status = status;
  }
}
/** 서버 요청의 응답 제한. 모델 목록은 실제로 몇 초씩 걸린다. */
const requestTimeoutMs = 60_000;
/** 끼워 넣기 응답 제한. */
const steerTimeoutMs = 10_000;
/** 이보다 큰 이벤트는 메모리를 지키려고 버린다. */
const maxEventLength = 64 * 1024 * 1024;
/**
 * OpenCode의 인증 중계(#148). Go 구독 모델은 연결의 Go 키를 쓰고, Zen 무료 모델은 연결의 로그인 없이 공개 키를 쓴다.
 * Google 프로토콜을 쓰는 Go 모델은 경로가 없다.
 */
export const opencodeRelayProfile: RelayProfile = {
  upstream: "https://opencode.ai/inference",
  routes: [
    {
      method: "POST",
      path: "/zen/chat/completions",
      upstreamPath: "/openai/v1/chat/completions",
      fixed: { authorization: "Bearer public" },
    },
    {
      method: "POST",
      path: "/zen/responses",
      upstreamPath: "/openai/v1/responses",
      fixed: { authorization: "Bearer public" },
    },
    {
      method: "POST",
      path: "/go/chat/completions",
      upstreamPath: "/go/openai/v1/chat/completions",
    },
    {
      method: "POST",
      path: "/go/responses",
      upstreamPath: "/go/openai/v1/responses",
    },
    {
      method: "POST",
      path: "/go/messages",
      upstreamPath: "/go/anthropic/v1/messages",
      authorize: (key) => ({
        headers: { "x-api-key": key },
        secrets: [key],
      }),
    },
  ],
  authorize: (key) => ({
    headers: { authorization: `Bearer ${key}` },
    secrets: [key],
  }),
};
const relayFailure =
  "인증 중계가 연결의 로그인을 쓰지 못해 실행을 끝냈습니다. 로그인을 확인한 뒤 다시 실행하세요.";
/**
 * 인증 중계가 이 컴퓨터에서 연결의 Go 키를 읽는다. 컨테이너에는 키를 주지 않는다.
 * DB가 없거나 값이 Go 키가 아니면 `undefined`다. 그 밖의 읽기 오류는 던진다.
 */
function goKey(dataHome: string): string | undefined {
  const file = path.join(dataHome, "opencode", "opencode.db");
  let db: DatabaseSync | undefined;
  try {
    if (
      !orIfMissing(
        () => lstatSync(file),
        hasErrorCode("ENOENT", "ENOTDIR"),
        undefined
      )
    )
      return undefined;
    db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare(
        "select value from credential where integration_id = 'opencode-go' order by active desc limit 1"
      )
      .get() as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return undefined;
    const stored = row.value;
    const value = orIfUnreadable(() => record(JSON.parse(stored)), undefined);
    return value?.type === "key" && typeof value.key === "string" && value.key
      ? value.key
      : undefined;
  } finally {
    db?.close();
  }
}
/** 확인한 저장소를 개인 폴더로 복사해 읽는 최대 크기. 이보다 크면 확인하지 않고 남은 로그인으로 본다. */
const residueCopyMaxBytes = 512 * 1024 * 1024;
/** 저장소를 개인 폴더로 복사할 때 읽는 조각. */
const residueChunkBytes = 1024 * 1024;
/**
 * 확인한 파일 하나를 처음부터 위치를 명시해 읽어 개인 폴더 `destination`에 쓰면서 SHA-256을 계산한다.
 * `from.info.size`나 읽은 합이 `limit`을 넘으면 `unsafe`다. `destination` handle은 이 함수가 닫고, `from`은 부르는 쪽이 닫는다.
 * 위치를 명시해 읽으므로 handle의 현재 위치가 달라도 같은 구간을 읽는다.
 */
async function copyOpened(
  from: OpenedRegularFile,
  destination: string,
  limit: number
): Promise<{ copied: number; digest: string } | "unsafe"> {
  if (from.info.size > limit) return "unsafe";
  let to: FileHandle | undefined;
  try {
    to = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(residueChunkBytes);
    let copied = 0;
    for (;;) {
      const { bytesRead } = await from.handle.read(
        buffer,
        0,
        buffer.length,
        copied
      );
      if (bytesRead === 0) break;
      copied += bytesRead;
      if (copied > limit) return "unsafe";
      hash.update(buffer.subarray(0, bytesRead));
      await writeAll(to, buffer.subarray(0, bytesRead));
    }
    return { copied, digest: hash.digest("hex") };
  } finally {
    const opened = to;
    if (opened !== undefined)
      await continueAfterFailure(
        () => opened.close(),
        (error) =>
          console.warn(
            `[provider] a login store handle could not be closed (${failureCode(error)})`
          )
      );
  }
}
/**
 * 같은 handle을 위치 0부터 최대 `length` 바이트(파일이 더 짧으면 끝까지) 다시 읽어 읽은 바이트 수와 SHA-256을 돌려준다.
 * 복사한 구간이 그대로인지 확인하는 데 쓴다. `from`은 닫지 않는다.
 */
async function digestOf(
  from: OpenedRegularFile,
  length: number
): Promise<{ read: number; digest: string }> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(residueChunkBytes);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await from.handle.read(
      buffer,
      0,
      Math.min(buffer.length, length - read),
      read
    );
    if (bytesRead === 0) break;
    read += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { read, digest: hash.digest("hex") };
}
/** 파일 핸들에 다 쓸 때까지 쓴다. */
async function writeAll(file: FileHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      written,
      buffer.length - written
    );
    written += bytesWritten;
  }
}
/**
 * 조직의 제품 폴더에 남은 로그인 흔적이 있는가. 서버를 띄우기 전에 보므로, 그 폴더의 로그인을 읽을 수 있는
 * 컨테이너는 시작하지 않는다. 값은 읽지 않고 표의 개수만 센다. 저장소는 확인한 폴더의 handle로 열어 개인 폴더에 복사한 뒤 읽는다:
 * 링크는 따라가지 않고 FIFO에서는 기다리지 않으며, 복사본의 크기가 제한을 넘으면 남은 로그인으로 본다.
 *
 * DB와 WAL을 각각 한 handle로 처음부터 읽어 사본에 쓰면서 SHA-256을 계산하고, 둘 다 복사한 뒤 같은 handle로 DB 전체와 WAL의
 * 앞부분(복사한 바이트 수만큼)을 다시 읽어 비교한다. 체크포인트가 복사 사이에 WAL의 프레임을 DB로 옮기고 WAL을 비우면, 옛 DB와
 * 빈 WAL을 복사해 정상으로 열리지만 행을 0개로 세는 사본이 된다. DB가 그대로면 그 사이 체크포인트가 DB를 바꾸지 않았고, WAL의
 * 앞부분이 그대로면 WAL이 재시작(새 salt의 머리로 처음부터 다시 씀)되지 않았다. 끝에 새 프레임이 붙는 것은 앞부분을 바꾸지
 * 않으므로 같은 조직의 OpenCode가 쓰는 중이어도 통과하며, 사본을 열면 SQLite는 salt·checksum이 맞는 마지막 commit 프레임까지만
 * 쓴다(https://www.sqlite.org/walformat.html §3 Recovery). 둘 중 하나라도 다르면 사본이 원본의 어느 한 때와도 같다고 할 수
 * 없으므로 확인하지 못한 것으로 보고 그 이유를 돌려준다(fail closed). 내용이 그대로여도 그 사이 DB나 WAL의 이름이 다른 파일로
 * 바뀌었으면(WAL이 새로 생겼거나 사라진 것 포함) 읽은 것이 그 이름의 저장소라고 할 수 없으므로 같은 이유로 돌려준다. 체크포인트는 DB를 바꾸고
 * (https://www.sqlite.org/fileformat2.html §4.3 Checkpoint Algorithm), WAL 재시작은 머리의 salt를 바꾼다(같은 문서
 * §4.4 WAL Reset).
 */
async function openCodeLoginResidue(
  organization: string
): Promise<ResidueCheck> {
  return orIfProbeFailed(
    async () => {
      return await residueInFolder(
        organization,
        ["data", "opencode"],
        async (folder) => {
          if (
            await orIfMissing(
              async () => {
                await lstat(folder.at("auth.json"));
                return true;
              },
              hasErrorCode("ENOENT", "ENOTDIR"),
              false
            )
          )
            return { state: "left" };
          const copyFolder = await mkdtemp(
            path.join(os.tmpdir(), "babojubot-opencode-residue-")
          );
          let db: DatabaseSync | undefined;
          let main: OpenedRegularFile | undefined;
          let wal: OpenedRegularFile | undefined;
          try {
            const copy = path.join(copyFolder, "opencode.db");
            const openedMain = await openRegularFile(folder.at("opencode.db"));
            if (openedMain === "missing") return { state: "none" };
            if (openedMain === "changed") {
              console.warn(
                "[provider] the OpenCode login store changed place while it was opened; the remaining login could not be checked"
              );
              return { state: "unverified", reason: "changed_while_checked" };
            }
            if (openedMain === "not-regular")
              return { state: "unverified", reason: "not_regular" };
            main = openedMain;
            const mainCopy = await copyOpened(main, copy, residueCopyMaxBytes);
            if (mainCopy === "unsafe")
              return { state: "unverified", reason: "too_large" };
            // DB 복사를 끝낸 뒤에 WAL을 연다. 시험은 이 열기 직전에 원본의 체크포인트를 일으켜, DB 다시 읽기가 그것을 잡는지 본다.
            const openedWal = await openRegularFile(
              folder.at("opencode.db-wal")
            );
            if (openedWal === "changed") {
              console.warn(
                "[provider] the OpenCode login store changed place while it was opened; the remaining login could not be checked"
              );
              return { state: "unverified", reason: "changed_while_checked" };
            }
            if (openedWal === "not-regular")
              return { state: "unverified", reason: "not_regular" };
            let walCopy: { copied: number; digest: string } | undefined;
            if (openedWal !== "missing") {
              wal = openedWal;
              const copiedWal = await copyOpened(
                wal,
                `${copy}-wal`,
                residueCopyMaxBytes - mainCopy.copied
              );
              if (copiedWal === "unsafe")
                return { state: "unverified", reason: "too_large" };
              walCopy = copiedWal;
            }
            const mainAgain = await digestOf(main, mainCopy.copied + 1);
            let same =
              mainAgain.read === mainCopy.copied &&
              mainAgain.digest === mainCopy.digest;
            if (walCopy !== undefined && wal !== undefined) {
              const walAgain = await digestOf(wal, walCopy.copied);
              same =
                same &&
                walAgain.read === walCopy.copied &&
                walAgain.digest === walCopy.digest;
            }
            // 복사한 handle의 내용이 그대로여도 그 사이 이름이 다른 파일로 바뀌었으면, 읽은 것은 지금 그 이름의 저장소가 아니다(DB와
            // WAL이 서로 다른 저장소의 짝일 수도 있다). 두 이름이 아직 읽은 그 파일일 때(WAL은 열 때 없었으면 지금도 없을 때)만 사본을
            // 그 저장소로 본다.
            const stillNamed = async (
              name: string,
              read: OpenedRegularFile | undefined
            ) => {
              const now = await orIfMissing(
                () => lstat(folder.at(name), { bigint: true }),
                hasErrorCode("ENOENT"),
                undefined
              );
              return read === undefined
                ? now === undefined
                : now !== undefined && sameEntry(now, read.info);
            };
            if (
              !same ||
              !(await stillNamed("opencode.db", main)) ||
              !(await stillNamed("opencode.db-wal", wal))
            ) {
              console.warn(
                "[provider] the OpenCode login store changed while it was copied; the remaining login could not be checked"
              );
              return { state: "unverified", reason: "changed_while_checked" };
            }
            db = new DatabaseSync(copy);
            for (const table of ["credential", "account", "control_account"]) {
              try {
                const row = db
                  .prepare(`select count(*) as n from "${table}"`)
                  .get() as { n?: unknown } | undefined;
                if (typeof row?.n === "number" && row.n > 0)
                  return { state: "left" };
              } catch (error) {
                // 없는 표는 0으로 본다. 그 밖의 읽기 오류는 남은 로그인으로 본다.
                if (!/no such table/i.test(String(error))) throw error;
              }
            }
            return { state: "none" };
          } finally {
            const closedMain = main;
            const closedWal = wal;
            await Promise.all([
              continueAfterFailure(
                () => db?.close(),
                (error) =>
                  console.warn(
                    `[provider] the copied OpenCode store could not be closed (${failureCode(error)})`
                  )
              ),
              closedMain === undefined
                ? undefined
                : continueAfterFailure(
                    () => closedMain.handle.close(),
                    (error) =>
                      console.warn(
                        `[provider] a login store handle could not be closed (${failureCode(error)})`
                      )
                  ),
              closedWal === undefined
                ? undefined
                : continueAfterFailure(
                    () => closedWal.handle.close(),
                    (error) =>
                      console.warn(
                        `[provider] a login store handle could not be closed (${failureCode(error)})`
                      )
                  ),
              continueAfterFailure(
                () => rm(copyFolder, { recursive: true, force: true }),
                (error) =>
                  console.warn(
                    `[provider] the copied OpenCode store folder could not be removed (${failureCode(error)})`
                  )
              ),
            ]);
          }
        }
      );
    },
    { state: "unverified", reason: "unreadable" },
    (error) =>
      console.warn(
        `[provider] the OpenCode login store could not be read; the remaining login could not be checked (${failureCode(error)})`
      )
  );
}
export function createOpenCodeProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
  /** 인증 중계 설정. 시험·합성 검증이 상류를 바꾸고 검증 여부를 정한다. 제품은 기본값(공식 상류, 검증됨: 2026-11-12 실제 구독으로 확인)을 쓴다. */
  relay?: { upstream?: string; verified?: boolean };
}): ProviderConnection {
  const connectionId = options.id ?? "opencode";
  const folders = connectionFolders(options.dataDir, connectionId);
  const home = folders.connection,
    command = options.command ?? commandFor(connectionId, "opencode");
  const relay = createCredentialRelay({
    profile: {
      ...opencodeRelayProfile,
      upstream: options.relay?.upstream ?? opencodeRelayProfile.upstream,
    },
    verified: options.relay?.verified ?? true,
    credential: async () => goKey(path.join(home, "data")),
  });
  /** 그 제품 폴더로 띄우는 환경. 로그인과 세션은 그 폴더의 DB 하나에 함께 있다. */
  const env = (productHome = home, isolated = false) =>
    providerEnvironment(
      connectionId,
      productHome,
      {
        XDG_CONFIG_HOME: path.join(productHome, "config"),
        XDG_DATA_HOME: path.join(productHome, "data"),
        XDG_CACHE_HOME: path.join(productHome, "cache"),
        XDG_STATE_HOME: path.join(productHome, "state"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_FILEWATCHER: "1",
        // 격리 컨테이너는 스스로 판을 올리지 않는다(바깥으로 나가는 길은 중계와 모델 목록뿐이다).
        ...(isolated ? { OPENCODE_DISABLE_AUTOUPDATE: "1" } : {}),
      },
      { isolated }
    );
  let warnedSystemConfig = false;
  const prepare = async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (warnedSystemConfig) return;
    // 이 프로그램은 시스템 설정을 끌 방법이 없다. 막지 않고 알린다.
    if (
      await orIfMissing(
        async () => {
          await lstat("/etc/opencode");
          return true;
        },
        hasErrorCode("ENOENT"),
        false
      )
    ) {
      warnedSystemConfig = true;
      console.warn(
        "[provider] /etc/opencode exists; OpenCode will also read this machine's system configuration"
      );
    }
  };
  const startups = new Map<string, Promise<void>>();
  /**
   * 같은 제품 폴더의 서버는 하나씩 띄운다. 새 폴더에 서버 둘이 함께 뜨면 그 폴더의 DB를 함께 만들다 하나가 끝난다
   * (2.2.6 실제 CLI 확인: `table … already exists`, #147). 띄우는 동안만 차례를 지키며, 띄운 서버의 실행은 함께 돈다.
   * 차례를 기다리다 취소되면 기다림을 그만두고 차례를 넘긴다.
   */
  const startupTurn = async (
    folder: string,
    signal: AbortSignal,
    waiting?: () => Promise<void>
  ) => {
    const ahead = startups.get(folder);
    const previous = ahead ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = previous.then(() => done);
    startups.set(folder, turn);
    void turn.then(() => {
      if (startups.get(folder) === turn) startups.delete(folder);
    });
    let onAbort: (() => void) | undefined;
    try {
      // 먼저 시작한 서버가 아직 뜨는 중이면 실행 활동에 알린다.
      if (ahead) await waiting?.();
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("Provider stopped"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (e) {
      release();
      throw e;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    return release;
  };
  async function server(
    signal: AbortSignal,
    config: Record<string, unknown> = {},
    container?: ContainerLaunch,
    productHome = home,
    waiting?: () => Promise<void>,
    runId?: string
  ) {
    const release = await startupTurn(productHome, signal, waiting);
    try {
      return await launch(signal, config, container, productHome, runId);
    } finally {
      release();
    }
  }
  /** 서버 하나를 띄워 첫 응답(주소)까지 기다린다. */
  async function launch(
    signal: AbortSignal,
    config: Record<string, unknown>,
    container: ContainerLaunch | undefined,
    productHome: string,
    runId?: string
  ) {
    const directory = await mkdtemp(path.join(productHome, "attempt-")),
      password = crypto.randomUUID();
    const lifetime = new AbortController();
    let interrupt: (() => void) | undefined;
    let child: ReturnType<typeof startProcess> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listening = false;
    let cleaned = false;
    const abort = () => {
      if (interrupt) interrupt();
      else lifetime.abort();
    };
    /** 지금까지 만든 것 중 이미 있는 것만 되돌린다. 성공한 뒤 부르는 `close`도 이것을 한 번만 쓴다. */
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearTimeout(timer);
      lifetime.abort();
      if (child) {
        child.end();
        await child.done;
      }
      if (listening) signal.removeEventListener("abort", abort);
      await removeAttemptFolder(directory, {
        kind: "attempt folder",
        connection: connectionId,
        runId,
      });
    };
    const close = cleanup;
    try {
      // 조직 도구 호출마다 같은 호출 키를 넣는 plugin. 설정 폴더의 `plugins/`는 OpenCode가 스스로 읽는다.
      await mkdir(path.join(directory, "plugins"), { mode: 0o700 });
      await writeFile(
        path.join(directory, "plugins", "babojubot-organization-keys.js"),
        organizationKeysPluginSource,
        { mode: 0o600 }
      );
      signal.addEventListener("abort", abort, { once: true });
      listening = true;
      if (signal.aborted) abort();
      let resolveUrl!: (url: string) => void;
      const ready = new Promise<string>((resolve) => {
        resolveUrl = resolve;
      });
      const started = startProcess({
        // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
        stateDir: home,
        command,
        args: container
          ? ["serve", "--stdio", "--hostname", "0.0.0.0", "--port", "4096"]
          : ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
        cwd: productHome,
        env: {
          ...env(productHome, Boolean(container)),
          OPENCODE_CONFIG_DIR: directory,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_SERVER_PASSWORD: password,
        },
        ...(container ? { container } : {}),
        onFrame: async (raw) => {
          const url = record(raw).url;
          if (typeof url === "string") {
            if (container) {
              // 컨테이너에는 네트워크가 없다. 컨테이너 안 서버는 중계가 이 컴퓨터 loopback에 연 주소로만 제어한다(비밀번호 인증 유지).
              const parsed = orIfUnreadable(() => new URL(url), undefined);
              if (parsed?.protocol === "http:") {
                try {
                  resolveUrl(await started.inboundOrigin());
                } catch (error) {
                  console.warn(
                    `[provider] the OpenCode inbound relay could not open; stopping the server (${failureCode(error)})`
                  );
                  lifetime.abort();
                }
              }
            } else {
              const parsed = new URL(url);
              if (
                parsed.hostname === "127.0.0.1" &&
                parsed.protocol === "http:"
              )
                resolveUrl(parsed.origin);
            }
          }
        },
      });
      child = started;
      const stop = () => started.end();
      lifetime.signal.addEventListener("abort", stop, { once: true });
      if (lifetime.signal.aborted) stop();
      timer = setTimeout(() => lifetime.abort(), startupLimitMs);
      const base = await Promise.race([
        ready,
        started.done.then(() => {
          throw new Error("Provider closed");
        }),
        new Promise<never>((_, reject) =>
          lifetime.signal.addEventListener(
            "abort",
            () => reject(new Error("Provider stopped")),
            { once: true }
          )
        ),
      ]);
      clearTimeout(timer);
      const headers = {
        authorization:
          "Basic " + Buffer.from("opencode:" + password).toString("base64"),
        "content-type": "application/json",
      };
      const request = async (
        route: string,
        method = "GET",
        body?: unknown,
        timeout = requestTimeoutMs
      ) => {
        const response = await fetch(base + route, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal:
            timeout === 0
              ? lifetime.signal
              : AbortSignal.any([
                  lifetime.signal,
                  AbortSignal.timeout(timeout),
                ]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpFailure(response.status);
        }
        return response;
      };
      return {
        request,
        close,
        setInterrupt: (callback: () => void) => {
          interrupt = callback;
        },
        closed: started.done,
        lifetime,
        async json(route: string, method = "GET", body?: unknown) {
          const response = await request(route, method, body);
          return record(await response.json());
        },
      };
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        console.warn(
          `[provider] could not clean up after preparing the OpenCode server of run ${runId ?? "(none)"} on connection ${connectionId}`,
          cleanupError
        );
      }
      throw error;
    }
  }
  const active = new Map<
    string,
    (message: SteerMessage) => Promise<SteerOutcome>
  >();
  /** 조직마다 살아 있는 격리 실행 수. 그동안 이 컴퓨터의 실행은 그 조직 폴더로 연결의 로그인을 옮기지 않는다(PR #171 SP-2). */
  const isolatedRuns = new Map<string, number>();
  /** 조직마다 진행 중인 로그인 옮기기. 격리 실행은 이것이 끝난 뒤에 남은 로그인을 확인한다. */
  const copying = new Map<string, Set<Promise<void>>>();
  const catalog = async (signal: AbortSignal) => {
    await prepare();
    const service = await server(signal);
    try {
      return await service.json("/api/model");
    } finally {
      await service.close();
    }
  };
  /** 서버 응답의 `data` 목록. */
  const entries = (value: Record<string, unknown>) =>
    Array.isArray(value.data) ? value.data.map(record) : [];
  const models = entries;
  /**
   * 조직 폴더에 로그인이 하나도 없으면 연결의 로그인을 옮겨 넣는다. `auth import`와 같은 규칙으로 같은 ID는 건너뛰고, 세션은 옮기지 않는다.
   * 실행 중인 서버는 넣은 로그인을 바로 쓴다(2.2.5 확인). 옮기지 못하면(로그인 목록을 주지 않는 판, 이 컴퓨터에 프로그램이 없음 등) 건너뛰고 그대로 돈다.
   */
  const copyLogin = async (
    target: Awaited<ReturnType<typeof server>>,
    signal: AbortSignal
  ) => {
    let source: Awaited<ReturnType<typeof server>> | undefined;
    try {
      if (entries(await target.json("/api/credential")).length) return;
      source = await server(signal);
      for (const credential of entries(await source.json("/api/credential")))
        await target
          .request("/api/credential", "POST", {
            id: credential.id,
            integrationID: credential.integrationID,
            label: credential.label,
            value: credential.value,
            activate: credential.active === true,
          })
          .catch((e: unknown) => {
            if (!(e instanceof HttpFailure && e.status === 409)) throw e;
          });
    } catch (error) {
      console.warn(
        `[provider] the OpenCode login could not be moved; the run goes on without it (${failureCode(error)})`
      );
      // 옮기지 못해도 실행은 그대로 한다. 무료 모델은 로그인 없이 돌고, 로그인이 필요하면 실행 시도가 로그인 필요로 드러난다. 중단은 다음 단계가 처리한다.
    } finally {
      await source?.close();
    }
  };

  const adapter: ProviderConnection["adapter"] = {
    capabilities: {
      steer: true,
      resume: true,
      reinjectInstructionsOnResume: true,
      usageTokens: true,
      usageCost: true,
      precompact: false,
    },
    loginCommand: `pnpm provider:login ${connectionId}`,
    async checkReadiness(signal) {
      try {
        await prepare();
        // 프로그램이 있는지만 본다. 어떤 판이든 실제로 동작하면 쓴다.
        await runProbe(command, ["--version"], {
          cwd: home,
          env: env(),
          signal,
          timeout: probeTimeoutMs,
          maxBuffer: 65536,
        });
        const listed = models(await catalog(signal));
        return listed.some(isFree)
          ? { status: "ready", reason: null }
          : { status: "unknown", reason: "credentials_unverified" };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return { status: "not_ready", reason: "program_missing" };
        console.warn(
          `[provider] the ${connectionId} readiness check failed (${probeEnding(e)})`
        );
        return { status: "not_ready", reason: "check_failed" };
      }
    },
    async steer(message) {
      return active.get(message.runId)?.(message) ?? "rejected";
    },
    async execute(input, control) {
      let service: Awaited<ReturnType<typeof server>> | undefined,
        grant: RelayGrant | undefined,
        events: Promise<void> | undefined;
      const organizationId = input.identity.organizationId;
      let counted = false;
      /** 서비스를 닫은 뒤 그 이벤트 흐름이 끝나기를 기다린다. 이벤트 흐름은 서비스가 닫혀야 끝나므로 닫기가 실패하면 기다리지 않는 한 단계다. */
      const closeServiceThenDrainEvents = async () => {
        await service?.close();
        if (events) await settled(events);
      };
      try {
        // 그 조직의 제품 폴더로 돈다.
        const organization = folders.organization(
          input.identity.organizationId
        );
        const placement = placeAttempt(options.container, organization, input);
        if (!placement) return failure();
        // 같은 조직의 격리 실행이 살아 있는 동안 이 컴퓨터의 실행은 그 조직 폴더로 연결의 로그인을 옮기지 않는다(PR #171 SP-2).
        if (placement.container) {
          isolatedRuns.set(
            organizationId,
            (isolatedRuns.get(organizationId) ?? 0) + 1
          );
          counted = true;
        }
        await prepare();
        await mkdir(organization, { recursive: true, mode: 0o700 });
        // 이 컴퓨터의 실행이 옮기던 로그인은 다 옮겨진 뒤에 본다. 기다릴 옮기기가 있으면 실행 활동에 알린다.
        const copies = placement.container && copying.get(organizationId);
        if (copies && copies.size > 0) {
          await control.emit({
            type: "progress",
            text: "로그인 정보를 옮기는 중이라 끝날 때까지 기다립니다.",
          });
          await Promise.all(copies);
        }
        // 격리 실행은 조직 폴더에 남은 로그인을 컨테이너가 읽을 수 있으므로, 서버를 띄우기 전에 확인하고 시작하지 않는다.
        if (placement.container) {
          const refusal = residueRefusalFor(
            await openCodeLoginResidue(organization)
          );
          if (refusal !== undefined) return { ...failure(), error: refusal };
        }
        let container: ContainerLaunch | undefined;
        try {
          container = placement.container?.({
            cwd: organization,
            program: "opencode",
            destinations: providerDestinations.opencode,
            // 이 컴퓨터가 컨테이너 안 OpenCode 서버를 중계의 역방향 연결로 부른다.
            inbound: 4096,
          });
        } catch (error) {
          if (error instanceof ContainerRefusal)
            return { ...failure(), error: error.message };
          throw error;
        }
        if (placement.container) {
          grant = continueAfterFailure(
            () =>
              relay.grant({
                signal: control.signal,
                organizationId: input.identity.organizationId,
                runId: input.identity.runId,
              }),
            (error) =>
              console.warn(
                `[provider] the isolated run relay refused a grant (${failureCode(error)})`
              )
          );
          if (!grant) return { ...failure(), error: relayFailure };
        }
        const runControl = grant
          ? {
              ...control,
              signal: AbortSignal.any([control.signal, grant.failed]),
            }
          : control;
        const relayBase = new URL(
          `/api/relay/${encodeURIComponent(connectionId)}`,
          input.access.toolsBaseUrl
        ).href;
        // Instructions are attached separately; never set agent.system, which replaces the native prompt.
        const config = {
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          mcp: {
            servers: {
              organization: {
                type: "remote",
                url: new URL("/api/tools/mcp", input.access.toolsBaseUrl).href,
                headers: {
                  Authorization: `Bearer ${input.access.token}`,
                  // 쓰기 도구는 plugin이 넣는 호출 키 없이는 거부된다(키 없는 쓰기로 우회하지 않음).
                  [callKeyRequiredHeader]: "required",
                },
                oauth: false,
                codemode: false,
              },
            },
          },
          // 권한은 이 실행 시도의 환경에만 들어간다. Zen 무료 모델은 공개 키를 그대로 두고 권한은 `x-api-key`로 싣는다.
          // 정책은 따로 나가는 다른 제공자들을 쓰지 않게 한다.
          ...(grant
            ? {
                policies: [
                  { action: "provider.use", resource: "*", effect: "deny" },
                  {
                    action: "provider.use",
                    resource: "opencode-go",
                    effect: "allow",
                  },
                  {
                    action: "provider.use",
                    resource: "opencode",
                    effect: "allow",
                  },
                ],
                share: "disabled",
                providers: {
                  opencode: {
                    settings: { baseURL: `${relayBase}/zen` },
                    headers: { "x-api-key": grant.token },
                  },
                  "opencode-go": {
                    settings: {
                      baseURL: `${relayBase}/go`,
                      apiKey: grant.token,
                    },
                  },
                },
              }
            : {}),
        };
        service = await server(
          runControl.signal,
          config,
          container,
          organization,
          () =>
            control.emit({
              type: "progress",
              text: "먼저 시작한 OpenCode가 준비될 때까지 기다립니다.",
            }),
          input.identity.runId
        );
        const api = service;
        // 격리 실행에는 연결의 로그인을 옮기지 않는다(#148). 조직 폴더에 옮겨 둔 로그인이 남아 있으면 컨테이너가 읽을 수 있으므로 시작하지 않는다.
        if (container) {
          if (entries(await api.json("/api/credential")).length)
            return { ...failure(), error: residueRefusal };
        } else if (isolatedRuns.get(organizationId)) {
          // 살아 있는 격리 컨테이너가 조직의 제품 폴더를 넣은 채 돌고 있다.
          await runControl.emit({
            type: "progress",
            text: "같은 조직의 격리 실행이 진행 중이라 연결의 로그인을 조직 폴더로 옮기지 않았습니다.",
          });
        } else {
          const copy = copyLogin(api, runControl.signal);
          const pending =
            copying.get(organizationId) ?? new Set<Promise<void>>();
          pending.add(copy);
          copying.set(organizationId, pending);
          try {
            await copy;
          } finally {
            pending.delete(copy);
            if (!pending.size) copying.delete(organizationId);
          }
        }
        const available = models(await api.json("/api/model"));
        // 비용이 들지 않도록 무료 모델을 먼저 고른다. 무료 모델이 없으면 그 연결이 제공하는 첫 모델을 쓴다.
        const selected = input.model
          ? available.find((m) => `${m.providerID}/${m.id}` === input.model)
          : (available.find(isFree) ?? available[0]);
        if (!selected) return failure();
        let session: Record<string, unknown> | undefined;
        if (typeof input.previousSession?.id === "string") {
          try {
            session = record(
              (
                await api.json(
                  `/api/session/${encodeURIComponent(input.previousSession.id)}`
                )
              ).data
            );
          } catch (e) {
            // 없는 세션도, 받아들이지 않는 세션도 새 세션으로 시작한다. 로그인 오류와 서버 오류는 세션 문제가 아니다.
            if (
              !(e instanceof HttpFailure) ||
              e.status < 400 ||
              e.status >= 500 ||
              e.status === 401 ||
              e.status === 403
            )
              throw e;
            await runControl.emit({
              type: "progress",
              text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
            });
          }
        }
        const model = { providerID: selected.providerID, id: selected.id };
        if (!session)
          session = record(
            (
              await api.json("/api/session", "POST", {
                location: { directory: input.workspace?.cwd ?? organization },
                agent: "build",
                model,
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
              })
            ).data
          );
        else
          await api.request(
            `/api/session/${encodeURIComponent(String(session.id))}/model`,
            "POST",
            { model }
          );
        if (typeof session.id !== "string") return failure();
        const id = session.id,
          route = `/api/session/${encodeURIComponent(id)}`;
        await api.request(
          `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/babojubot`,
          "PUT",
          { value: input.instructions.map((file) => file.content).join("\n\n") }
        );
        const before = session;
        let began = false,
          finished = false,
          success = false,
          failedError: unknown;
        let end!: () => void;
        const ended = new Promise<void>((resolve) => {
          end = resolve;
        });
        const stream = await api.request("/api/event", "GET", undefined, 0);
        if (!stream.body) throw new Error("No event stream");
        events = (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of stream.body!) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            if (buffer.length > maxEventLength) buffer = "";
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const block = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const event = orIfUnreadable(
                () => record(JSON.parse(data)),
                undefined
              );
              if (!event) continue;
              const payload = record(event.data);
              if (payload.sessionID !== id) continue;
              if (event.type === "session.execution.started") {
                began = true;
                await runControl.emit({
                  type: "progress",
                  text: "프로바이더가 작업을 시작했습니다.",
                });
              }
              if (
                began &&
                [
                  "session.execution.succeeded",
                  "session.execution.failed",
                  "session.execution.interrupted",
                ].includes(String(event.type))
              ) {
                finished = true;
                success = event.type === "session.execution.succeeded";
                if (event.type === "session.execution.failed")
                  failedError = payload.error;
                end();
                return;
              }
            }
          }
          throw new Error("Event stream ended");
        })();
        // Attach a handler immediately: a disconnected stream is a failed attempt, never a false success.
        void events.catch((error: unknown) => {
          if (!runControl.signal.aborted)
            console.warn(
              `[provider] the OpenCode event stream failed; the run ends as failed (${failureCode(error)})`
            );
          end();
        });
        active.set(input.identity.runId, async (message) => {
          if (!began || finished || runControl.signal.aborted)
            return "rejected";
          try {
            await api.request(
              route + "/prompt",
              "POST",
              {
                text: message.body,
                delivery: "steer",
              },
              steerTimeoutMs
            );
            return "accepted";
          } catch (e) {
            if (e instanceof HttpFailure && e.status >= 400 && e.status < 500)
              return "rejected";
            throw e;
          }
        });
        const cancel = () => {
          void settled(
            api.request(route + "/interrupt", "POST", undefined, 1500)
          ).then(() => api.lifetime.abort());
        };
        // Server lifetime uses a separate signal below so interrupt can be sent before escalation.
        api.setInterrupt(cancel);
        if (runControl.signal.aborted) cancel();
        try {
          await api.request(route + "/prompt", "POST", {
            text: JSON.stringify({
              identity: input.identity,
              context: input.context,
              wakeReasons: input.wakeReasons,
            }),
          });
          await Promise.race([ended, api.closed, events]);
          if (grant?.failed.aborted && !control.signal.aborted)
            return { ...failure(), error: relayFailure };
          if (control.signal.aborted)
            return { ...failure(), stopReason: "cancelled", error: null };
          if (!finished) return failure();
          // 실패를 같은 요청으로 다시 보내지 않는다. 요청 거부는 다시 보내도 거부된다.
          if (!success) return failedExecution(failedError);
          const after = record((await api.json(route)).data);
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage: sessionUsage(connectionId, before, after),
            nextSession: { id },
          };
        } finally {
          api.setInterrupt(() => api.lifetime.abort());
        }
      } catch (error) {
        // 감독 실행기를 쓸 수 없어 띄우지 않은 거절은 그 이유가 실행 시도의 실패 원인으로 보이도록 넘긴다.
        if (error instanceof TreeLaunchRefused) throw error;
        if (!control.signal.aborted)
          console.warn(
            `[provider] the OpenCode run failed (${failureCode(error)})`
          );
        if (grant?.failed.aborted && !control.signal.aborted)
          return { ...failure(), error: relayFailure };
        return control.signal.aborted
          ? { ...failure(), stopReason: "cancelled", error: null }
          : failure();
      } finally {
        grant?.revoke();
        active.delete(input.identity.runId);
        try {
          await closeServiceThenDrainEvents();
        } finally {
          // 컨테이너를 지운 뒤에야 이 격리 실행을 센 것에서 뺀다.
          if (counted) {
            const remaining = (isolatedRuns.get(organizationId) ?? 1) - 1;
            if (remaining) isolatedRuns.set(organizationId, remaining);
            else isolatedRuns.delete(organizationId);
          }
        }
      }
    },
  };
  return {
    id: connectionId,
    label: options.label ?? "OpenCode",
    isolatable: true,
    credentialRelay: relay,
    login: { command, args: ["auth", "login"], env: env() },
    adapter,
    models: [],
    async listModels(signal) {
      return models(await catalog(signal)).flatMap((m) =>
        typeof m.id === "string" && typeof m.providerID === "string"
          ? [
              {
                id: `${m.providerID}/${m.id}`,
                label: typeof m.name === "string" ? m.name : m.id,
              },
            ]
          : []
      );
    },
  };
}
function isFree(model: Record<string, unknown>) {
  return (
    Array.isArray(model.cost) &&
    model.cost.length > 0 &&
    model.cost.every(
      (item) => record(item).input === 0 && record(item).output === 0
    )
  );
}
/**
 * 실행 전·후 세션 누계의 차이. 실행 후 값이 없으면 보고 안 됨이고, 실행 전 값이 보고 안 됐으면 0으로 본다(새 세션).
 * 잘못된 값과 줄어든 누계는 그 항목만 비운다.
 */
function sessionUsage(
  provider: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Usage {
  const b = record(before.tokens),
    a = record(after.tokens),
    bc = record(b.cache),
    ac = record(a.cache);
  const delta = (unit: UsageUnit, a: unknown, b: unknown) =>
    subtractUsage(unit, usageAmount(unit, a), usageAmount(unit, b) ?? 0);
  return providerUsage(provider, {
    inputTokens: delta("tokens", a.input, b.input),
    outputTokens: delta("tokens", a.output, b.output),
    cacheReadTokens: delta("tokens", ac.read, bc.read),
    cacheWriteTokens: delta("tokens", ac.write, bc.write),
    costUsd: delta("usd", after.cost, before.cost),
  });
}
