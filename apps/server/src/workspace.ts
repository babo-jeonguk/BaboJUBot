import { constants } from "node:fs";
import { mkdir, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  artifactFileMaxBytes,
  type ArtifactSnapshot,
  type RunRequest,
} from "@babojubot/contracts";
import { findOrganization, type Database } from "@babojubot/db";

export class ArtifactFileError extends Error {}

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
      // 실제 경로로 비교한다. 데이터 폴더가 심볼릭 링크를 거쳐도 되고, 폴더를 벗어나는 링크만 막는다.
      const root = await realpath(this.organization(orgId));
      const target = await realpath(path.resolve(root, relative));
      const normalized = path.relative(root, target);
      if (
        !normalized ||
        normalized === ".." ||
        normalized.startsWith(`..${path.sep}`) ||
        path.isAbsolute(normalized)
      )
        throw new ArtifactFileError();
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const before = await handle.stat({ bigint: true });
        // 하드링크는 다른 조직의 파일을 이 폴더의 파일처럼 보이게 할 수 있어 막는다.
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > BigInt(artifactFileMaxBytes)
        )
          throw new ArtifactFileError();
        // 경로 확인과 파일 열기 사이에 파일이 바뀌지 않았는지 본다.
        const current = await lstat(target, { bigint: true });
        if (current.dev !== before.dev || current.ino !== before.ino)
          throw new ArtifactFileError();
        const buffer = Buffer.alloc(Number(before.size));
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            null
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
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
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes
            );
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
            size: length,
          },
          bytes: bytes.toString("base64"),
        };
      } finally {
        await handle.close();
      }
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
