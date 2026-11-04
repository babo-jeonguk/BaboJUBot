import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  artifactFileMaxBytes,
  type ArtifactSnapshot,
  type RunRequest,
} from "@babojubot/contracts";
import {
  findOrganization,
  hasWorkspaceIdentity,
  recordWorkspaceIdentity,
  type Database,
} from "@babojubot/db";

export class ArtifactFileError extends Error {}

const identityFile = "workspace-identity.json";
const identityMaxBytes = 4096;

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
 * 조직 폴더 안의 파일을 다른 프로세스에서 읽는다. Node에는 폴더 핸들로 여는 기능이 없어 경로를 여러 번 확인해도
 * 그 사이의 바꿔치기를 막지 못한다. 작업 폴더는 커널이 폴더 자체를 붙들므로 한 칸씩 들어가며 확인한 폴더인지 보고,
 * 고정된 폴더 안에서 연다. 들어간 뒤에 바깥 경로가 바뀌어도 영향이 없다.
 * 경로를 고정해도 처음 고른 폴더가 다른 조직이면 소용없으므로, 고정한 폴더가 자기 ID를 말하게 해 대조한다.
 */
export const pinnedReader = `
const fs = require("node:fs");
const { constants } = fs;
const [maxBytes, organizationId, ...parts] = JSON.parse(process.argv[1]);
const stat = { bigint: true };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const enter = (part) => {
  const expected = fs.lstatSync(part, stat);
  if (!expected.isDirectory()) process.exit(3);
  process.chdir(part);
  if (!same(expected, fs.statSync(".", stat))) process.exit(3);
};
const open = (name, limit) => {
  const expected = fs.lstatSync(name, stat);
  if (!expected.isFile()) process.exit(3);
  const fd = fs.openSync(
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  const opened = fs.fstatSync(fd, stat);
  if (!same(expected, opened) || !opened.isFile() || opened.size > BigInt(limit))
    process.exit(3);
  return { fd, opened };
};
const read = ({ fd, opened }) => {
  const buffer = Buffer.alloc(Number(opened.size));
  let length = 0;
  while (length < buffer.length) {
    const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  return buffer.subarray(0, length);
};
enter(organizationId);
let claimed;
try {
  claimed = JSON.parse(read(open(${JSON.stringify(identityFile)}, ${identityMaxBytes})).toString("utf8"))?.organizationId;
} catch {
  process.exit(3);
}
if (claimed !== organizationId) process.exit(3);
const name = parts.pop();
for (const part of parts) enter(part);
const file = open(name, maxBytes);
if (file.opened.nlink !== 1n) process.exit(3);
process.stdout.write(read(file));
`;
function readPinned(start: string, parts: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", pinnedReader, JSON.stringify([artifactFileMaxBytes, ...parts])],
      {
        cwd: start,
        // 서버의 실행 옵션(NODE_OPTIONS 등)을 넘기지 않는다. Windows는 시스템 폴더 위치만 있으면 된다.
        env: process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {},
        encoding: "buffer",
        maxBuffer: artifactFileMaxBytes + 1,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) resolve(stdout);
        // 끝난 코드가 있으면 읽기를 거부한 것이고, 없으면 띄우지 못했거나 시간이 넘은 서버 쪽 문제다.
        else
          reject(
            typeof error.code === "number" ? new ArtifactFileError() : error
          );
      }
    );
  });
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
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(
        temp,
        JSON.stringify({ version: 1, organizationId: id }),
        {
          flag: "wx",
          mode: 0o600,
        }
      );
      await rename(temp, file);
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
  async readArtifact(
    orgId: string,
    relative: string
  ): Promise<ArtifactSnapshot> {
    try {
      if (path.isAbsolute(relative) || relative.includes("\0"))
        throw new ArtifactFileError();
      // 실제 경로로 비교한다. 조직들을 담은 폴더까지는 링크를 거쳐도 되지만, 조직 폴더 자체가 다른 곳을 가리키면 여기서 벗어난 경로로 나온다.
      const organizations = await realpath(
        path.resolve(this.root, "organizations")
      );
      const root = path.join(organizations, orgId, "shared");
      const target = await realpath(path.resolve(root, relative));
      const normalized = path.relative(root, target);
      if (
        !normalized ||
        normalized === ".." ||
        normalized.startsWith(`..${path.sep}`) ||
        path.isAbsolute(normalized)
      )
        throw new ArtifactFileError();
      const bytes = await readPinned(organizations, [
        orgId,
        "shared",
        ...normalized.split(path.sep),
      ]);
      const extension = path.extname(target).toLowerCase();
      let content = "";
      let format: ArtifactSnapshot["format"] = "binary";
      const binaryTypes: Record<string, string> = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".zip": "application/zip",
        ".svg": "image/svg+xml",
        ".html": "text/html",
      };
      let mediaType = binaryTypes[extension] ?? "application/octet-stream";
      const textTypes: Record<string, string> = {
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".json": "application/json",
        ".log": "text/plain",
        ".tsv": "text/tab-separated-values",
      };
      if (textTypes[extension]) {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (!text.includes("\0")) {
            content = text;
            mediaType = textTypes[extension]!;
            format = mediaType === "text/markdown" ? "markdown" : "text";
          }
        } catch {
          /* Invalid UTF-8 remains a binary artifact. */
        }
      }
      return {
        format,
        content,
        file: {
          name: path.basename(target),
          path: normalized,
          mediaType,
          size: bytes.length,
        },
        bytes: bytes.toString("base64"),
      };
    } catch (error) {
      if (
        error instanceof ArtifactFileError ||
        (error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ELOOP", "ENOTDIR", "EACCES"].includes(String(error.code)))
      )
        throw new ArtifactFileError("invalid artifact file");
      throw error;
    }
  }
}

/** 표식 파일이 말하는 조직 ID. 없으면 `undefined`, 있는데 읽을 수 없으면 `null`이다. */
async function readIdentity(file: string) {
  let info;
  try {
    info = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw identityBlocked("읽을", file, e);
  }
  if (!info.isFile() || info.size > identityMaxBytes) return null;
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as {
      organizationId?: unknown;
    } | null;
    return typeof value?.organizationId === "string"
      ? value.organizationId
      : null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw identityBlocked("읽을", file, e);
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
