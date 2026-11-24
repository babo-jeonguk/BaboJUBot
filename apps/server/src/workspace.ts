import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  artifactFileMaxBytes,
  continueAfterFailure,
  failureCode,
  orIfUnreadable,
  type ArtifactFileRead,
  type ArtifactFileRefusal,
  type ArtifactSnapshot,
  type RunRequest,
} from "@babojubot/contracts";
import {
  findOrganization,
  hasWorkspaceIdentity,
  recordWorkspaceIdentity,
  type Database,
} from "@babojubot/db";
import { openRegularFile, publishFile } from "@babojubot/files";
import { runTree } from "@babojubot/process";
import {
  identityFile,
  identityMaxBytes,
  pinnedReaderFile,
  readerExit,
} from "./workspace-reader-contract.ts";

export { pinnedReaderFile, readerExit } from "./workspace-reader-contract.ts";

/** 거부 종료 코드 → 거부 이유. 표식 불일치는 거부가 아니라 서버 쪽 문제라 따로 던진다. */
const readerRefusals: Record<number, ArtifactFileRefusal> = {
  [readerExit.changed]: "file_changed",
  [readerExit.notFile]: "not_regular_file",
  [readerExit.tooLarge]: "file_too_large",
  [readerExit.hardLink]: "hard_link_refused",
  [readerExit.notFound]: "file_not_found",
  [readerExit.unreadable]: "file_unreadable",
  [readerExit.linkLoop]: "link_loop",
  [readerExit.outside]: "path_outside_folder",
};

type PinnedRead =
  | { ok: true; parts: string[]; bytes: Buffer }
  | { ok: false; refusal: ArtifactFileRefusal };

/** 조직 폴더가 이 조직의 것이라고 확인되지 않았다. 다른 조직의 폴더를 잘못 쓰지 않도록 실행을 멈춘다. */
export class WorkspaceIdentityError extends Error {}

/** 파일 시스템이 표식을 막았을 때의 안내. 원본 오류는 원인으로 남겨 서버 기록에 보인다. */
function identityBlocked(action: string, file: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code ?? "unknown";
  return new WorkspaceIdentityError(
    `조직 폴더의 표식을 ${action} 수 없습니다(${code}). ${file}의 경로와 권한을 확인해 주세요.`,
    { cause: error }
  );
}

/**
 * 고정한 폴더에서 파일 하나를 읽는 Node.js 프로세스(workspace-reader.ts)를 공용 실행으로 끝까지 돌린다. Node에는 폴더 핸들로 여는
 * 기능이 없어, 작업 폴더로 폴더를 붙드는 그 프로세스가 한 칸씩 확인하며 들어가 고정된 폴더 안에서 연다(자세한 것은 그 파일). 상한(30초)이나 출력 상한에 닿으면 그 트리를 끄고
 * 끝난 것을 확인한 뒤 서버 쪽 문제로 던진다.
 */
async function readPinned(start: string, args: string[]): Promise<PinnedRead> {
  const run = await runTree({
    command: [process.execPath],
    args: [pinnedReaderFile, JSON.stringify([artifactFileMaxBytes, ...args])],
    cwd: start,
    // 서버의 실행 옵션(NODE_OPTIONS 등)을 넘기지 않는다. Windows는 시스템 폴더 위치만 있으면 된다.
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    limitMs: 30_000,
    maxOutputBytes: artifactFileMaxBytes + 64 * 1024,
    overflow: "stop",
  });
  // 띄우지 못했거나 시간·출력 상한에 닿았으면 서버 쪽 문제다.
  if (!run.started)
    throw new Error(`file reader could not start: ${run.reason}`, {
      cause: run.error,
    });
  if (run.stopped)
    throw new Error(
      `file reader was stopped at its ${run.stopped} limit${run.signal ? ` (signal ${run.signal})` : ""}`
    );
  if (run.code === 0) {
    const at = run.stdout.indexOf(0x0a);
    const parts = orIfUnreadable(
      (): unknown => JSON.parse(run.stdout.subarray(0, at).toString("utf8")),
      undefined
    );
    if (
      !Array.isArray(parts) ||
      !parts.every((part): part is string => typeof part === "string")
    )
      throw new Error("file reader returned an invalid header");
    return { ok: true, parts, bytes: run.stdout.subarray(at + 1) };
  }
  // 끝난 코드가 있으면 읽기를 거부한 것이고, 없으면(신호로 끝남) 서버 쪽 문제다.
  if (run.code === null)
    throw new Error(`file reader ended by ${run.signal ?? "an unknown cause"}`);
  if (run.code === readerExit.identity)
    throw new WorkspaceIdentityError(
      "조직 폴더가 이 조직의 것으로 확인되지 않아 파일을 읽지 않았습니다. 조직 폴더가 옮겨지거나 링크로 바뀌었는지 확인해 주세요."
    );
  const refusal = readerRefusals[run.code];
  // 알려진 거부 코드가 아니면 파일 문제가 아니라 서버 쪽 문제다.
  if (!refusal) throw new Error("artifact file could not be read");
  return { ok: false, refusal };
}

/** Server-owned folder layout. Folder access permissions are enforced by the future container adapter, or instructions on the host. */
export class Workspaces {
  private readonly root: string;
  private readonly db: Database;
  constructor(root: string, db: Database) {
    this.root = root;
    this.db = db;
  }
  organization(id: string) {
    return path.resolve(this.root, "organizations", id, "shared");
  }
  private identityPath(id: string) {
    return path.resolve(this.root, "organizations", id, identityFile);
  }
  /**
   * 이 조직 폴더가 정말 이 조직의 것인지 본다. 처음 쓰는 폴더에는 ID를 적는다. 한 번 적은 뒤로는 표식이 없는 폴더를
   * 믿지 않는다. 없다고 다시 적으면 옮겨 온 다른 조직의 폴더에도 이 조직의 표식이 붙기 때문이다.
   */
  private async confirmIdentity(id: string) {
    const file = this.identityPath(id);
    // 기록은 표식을 쓴 뒤에 남긴다. 기록을 먼저 읽어야 함께 도는 준비가 막 쓴 표식을 없다고 오판하지 않는다.
    const recorded = await hasWorkspaceIdentity(this.db, id);
    const claimed = await readIdentity(file);
    if (claimed === id) {
      await recordWorkspaceIdentity(this.db, id, new Date());
      return;
    }
    if (claimed !== undefined)
      throw new WorkspaceIdentityError(
        `조직 폴더의 표식이 이 조직과 다릅니다. 다른 조직의 폴더가 옮겨졌는지 ${file}을 확인해 주세요.`
      );
    const folder = path.dirname(file);
    if (recorded && (await exists(folder)))
      throw new WorkspaceIdentityError(
        `조직 폴더에 표식이 없습니다. 이 조직의 폴더가 맞는지 확인하고 ${file}을 복원해 주세요.`
      );
    // 처음 쓰는 폴더이거나 폴더가 통째로 없어 다른 조직과 헷갈릴 일이 없다. 한 번에 나타나게 쓴다.
    try {
      await mkdir(folder, { recursive: true });
      await publishFile(
        file,
        JSON.stringify({ version: 1, organizationId: id }),
        { mode: 0o600 }
      );
    } catch (e) {
      throw identityBlocked("쓸", file, e);
    }
    await recordWorkspaceIdentity(this.db, id, new Date());
  }
  private personal(orgId: string, agentId: string) {
    return path.resolve(this.root, "organizations", orgId, "agents", agentId);
  }
  async ensure(orgId: string) {
    const org = await findOrganization(this.db, orgId);
    if (!org) throw new Error("workspace organization missing");
    await this.confirmIdentity(orgId);
    await mkdir(this.organization(orgId), { recursive: true });
    for (const agent of org.agents)
      await mkdir(this.personal(orgId, agent.id), { recursive: true });
    return org;
  }
  async forRun(
    orgId: string,
    agentId: string
  ): Promise<NonNullable<RunRequest["workspace"]>> {
    const org = await this.ensure(orgId);
    return {
      cwd: this.organization(orgId),
      organization: this.organization(orgId),
      personal: this.personal(orgId, agentId),
      peers: org.agents
        .filter((a) => a.id !== agentId)
        .map((a) => ({
          agentId: a.id,
          path: this.personal(orgId, a.id),
          access: "read" as const,
        })),
    };
  }
  /**
   * 조직 폴더 안의 파일을 읽어 산출물로 만들 내용을 돌려준다. 경로는 에이전트의 작업 폴더(`forRun`의 `cwd`) 기준이거나
   * 절대 경로다. 경로는 고정한 폴더 안에서 읽는 프로세스가 한 칸씩 풀므로, 서버 프로세스는 조직 폴더 안을 들여다보지
   * 않는다. 바깥을 가리키는 경로는 그곳에 무엇이 있든 같은 거부를 받는다.
   * 거부하면 그 이유를 돌려주고, 조직 폴더의 표식이 이 조직과 맞지 않으면 `WorkspaceIdentityError`를 던진다.
   */
  async readArtifact(
    orgId: string,
    requested: string
  ): Promise<ArtifactFileRead> {
    const organizations = await realpath(
      path.resolve(this.root, "organizations")
    );
    const read = await readPinned(organizations, [
      orgId,
      requested,
      this.organization(orgId),
      path.join(organizations, orgId, "shared"),
    ]);
    if (!read.ok) return read;
    const { parts, bytes } = read;
    const name = parts[parts.length - 1]!;
    const extension = path.extname(name).toLowerCase();
    let content = "";
    let format: ArtifactSnapshot["format"] = "binary";
    // 확장자는 에이전트가 지은 파일 이름에서 온다. 일반 객체로 찾지 않고 Map으로 찾는다(CODING_STANDARDS.md#제품-코드).
    const binaryTypes = new Map([
      [".pdf", "application/pdf"],
      [".png", "image/png"],
      [".jpg", "image/jpeg"],
      [".jpeg", "image/jpeg"],
      [".zip", "application/zip"],
      [".svg", "image/svg+xml"],
      [".html", "text/html"],
    ]);
    let mediaType = binaryTypes.get(extension) ?? "application/octet-stream";
    const textTypes = new Map([
      [".md", "text/markdown"],
      [".markdown", "text/markdown"],
      [".txt", "text/plain"],
      [".csv", "text/csv"],
      [".json", "application/json"],
      [".log", "text/plain"],
      [".tsv", "text/tab-separated-values"],
    ]);
    const textType = textTypes.get(extension);
    if (textType) {
      const text = orIfUnreadable(
        () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        undefined
      );
      // Invalid UTF-8 remains a binary artifact.
      if (text !== undefined && !text.includes("\0")) {
        content = text;
        mediaType = textType;
        format = mediaType === "text/markdown" ? "markdown" : "text";
      }
    }
    return {
      ok: true,
      snapshot: {
        format,
        content,
        file: {
          name,
          path: parts.join(path.sep),
          mediaType,
          size: bytes.length,
        },
        bytes: bytes.toString("base64"),
      },
    };
  }
}

/**
 * 표식 파일이 말하는 조직 ID. 없으면 `undefined`, 있는데 읽을 수 없으면 `null`이다. 표식은 `@babojubot/files`의
 * `openRegularFile`로 한 번 열고, 그 handle의 종류·크기·내용으로 판정한다. `"changed"`(열 때와 그 직후 사이에 자리가 바뀜)는
 * 읽을 수 없는 것으로 본다. 열기가 던진 오류(위 칸이 폴더가 아님·위 폴더 순환·권한 등)는 "표식을 읽을 수 없습니다(코드)"로
 * 알린다.
 */
async function readIdentity(file: string) {
  let opened;
  try {
    opened = await openRegularFile(file);
  } catch (e) {
    throw identityBlocked("읽을", file, e);
  }
  if (opened === "missing") return undefined;
  if (opened === "not-regular") return null;
  if (opened === "changed")
    throw identityBlocked(
      "읽을",
      file,
      Object.assign(new Error("the mark changed while it was opened"), {
        code: "changed",
      })
    );
  const { handle, info } = opened;
  try {
    if (info.size > BigInt(identityMaxBytes)) return null;
    const buffer = Buffer.alloc(identityMaxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > identityMaxBytes) return null;
    const value: unknown = JSON.parse(buffer.toString("utf8", 0, length));
    return typeof value === "object" &&
      value !== null &&
      "organizationId" in value &&
      typeof value.organizationId === "string"
      ? value.organizationId
      : null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw identityBlocked("읽을", file, e);
  } finally {
    await continueAfterFailure(
      () => handle.close(),
      (error) =>
        console.warn(
          `[workspace] a file handle could not be closed (${failureCode(error)})`
        )
    );
  }
}

async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw identityBlocked("읽을", target, e);
  }
}
