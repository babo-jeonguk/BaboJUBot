import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  artifactFileMaxBytes,
  type ArtifactSnapshot,
  type RunRequest,
} from "@babojubot/contracts";
import { findOrganization, type Database } from "@babojubot/db";

export class ArtifactFileError extends Error {}

/**
 * 조직 폴더 안의 파일을 다른 프로세스에서 읽는다. Node에는 폴더 핸들로 여는 기능이 없어 경로를 여러 번 확인해도
 * 그 사이의 바꿔치기를 막지 못한다. 작업 폴더는 커널이 폴더 자체를 붙들므로 한 칸씩 들어가며 확인한 폴더인지 보고,
 * 고정된 폴더 안에서 연다. 들어간 뒤에 바깥 경로가 바뀌어도 영향이 없다.
 */
export const pinnedReader = `
const fs = require("node:fs");
const { constants } = fs;
const [maxBytes, ...parts] = JSON.parse(process.argv[1]);
const stat = { bigint: true };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const name = parts.pop();
for (const part of parts) {
  const expected = fs.lstatSync(part, stat);
  if (!expected.isDirectory()) process.exit(3);
  process.chdir(part);
  if (!same(expected, fs.statSync(".", stat))) process.exit(3);
}
const expected = fs.lstatSync(name, stat);
if (!expected.isFile()) process.exit(3);
const fd = fs.openSync(
  name,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
);
const opened = fs.fstatSync(fd, stat);
if (
  !same(expected, opened) ||
  !opened.isFile() ||
  opened.nlink !== 1n ||
  opened.size > BigInt(maxBytes)
)
  process.exit(3);
const buffer = Buffer.alloc(Number(opened.size));
let length = 0;
while (length < buffer.length) {
  const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
  if (!read) break;
  length += read;
}
process.stdout.write(buffer.subarray(0, length));
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
  private personal(orgId: string, agentId: string) {
    return path.resolve(this.root, "organizations", orgId, "agents", agentId);
  }
  async ensure(orgId: string) {
    const org = await findOrganization(this.db, orgId);
    if (!org) throw new Error("workspace organization missing");
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
