import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SessionMaintenance } from "@babojubot/contracts";

/** Claude's saved cumulative session cost, as written to the session transcript. */
export type ClaudeSessionCost = {
  /** The 0-based index of the saved row's line in the transcript file. */
  line: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/** Find a session's transcript file under the product's projects folder. */
async function sessionTranscripts<T>(
  home: string,
  id: string,
  read: (file: FileHandle, size: number) => Promise<T | undefined>
): Promise<T | undefined> {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return;
  const projects = path.join(home, "config/projects");
  let folders;
  try {
    folders = await readdir(projects, { withFileTypes: true });
  } catch {
    return;
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    let file;
    try {
      file = await open(
        path.join(projects, folder.name, `${id}.jsonl`),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      const info = await file.stat();
      if (!info.isFile()) continue;
      const value = await read(file, info.size);
      if (value !== undefined) return value;
    } catch {
      /* Missing/unsupported transcript cannot schedule a guessed maintenance request. */
    } finally {
      await file?.close();
    }
  }
}

/** Product-owned transcripts only; bounded tail read, no transcript text leaves this module. */
export async function claudeSessionFacts(
  home: string,
  id: string
): Promise<SessionMaintenance | undefined> {
  return sessionTranscripts(home, id, async (file, size) => {
    const limit = Math.min(size, 512 * 1024),
      buffer = Buffer.alloc(limit);
    await file.read(buffer, 0, limit, size - limit);
    const lines = buffer.toString("utf8").split("\n");
    let facts: SessionMaintenance | undefined;
    for (let index = lines.length - 1; index >= 0; index--) {
      let row;
      try {
        row = JSON.parse(lines[index]!);
      } catch {
        continue;
      }
      if (!row || row.isSidechain || row.sessionId !== id) continue;
      if (row.subtype === "compact_boundary" || row.isCompactSummary) break;
      if (row.type !== "assistant" || !row.message?.usage) continue;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at)) continue;
      const usage = row.message.usage;
      const counts = [
        usage.input_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      ];
      if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)) continue;
      facts ??= {
        tokens: counts.reduce((sum, n) => sum + n, 0),
        lastRequestAt: new Date(at).toISOString(),
        ttlMs: 3600000,
      };
      const creation = usage.cache_creation;
      if (creation?.ephemeral_5m_input_tokens > 0) {
        facts.ttlMs = 300000;
        return facts;
      }
      if (creation?.ephemeral_1h_input_tokens > 0) return facts;
    }
    return facts;
  });
}

/** Claude's own saved cost for a session; the last `cost-state` row wins, field by field. */
export async function claudeSessionCost(
  home: string,
  id: string
): Promise<ClaudeSessionCost | undefined> {
  return sessionTranscripts(home, id, async (file) => {
    let found: ClaudeSessionCost | undefined;
    let line = -1;
    for await (const raw of file.readLines()) {
      line++;
      const text = raw.trim();
      if (!text) continue;
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        continue;
      }
      if (
        !row ||
        typeof row !== "object" ||
        row.type !== "cost-state" ||
        row.sessionId !== id
      )
        continue;
      const total = (row as Record<string, unknown>).totalCostUSD;
      const modelUsage = (row as Record<string, unknown>).modelUsage;
      const sum = (key: string): number | null => {
        if (!modelUsage || typeof modelUsage !== "object") return null;
        const entries = Object.values(modelUsage as Record<string, unknown>);
        if (entries.length === 0) return null;
        let total = 0;
        for (const usage of entries) {
          const value = (usage as Record<string, unknown> | null)?.[key];
          if (!Number.isSafeInteger(value) || (value as number) < 0)
            return null;
          total += value as number;
        }
        return total;
      };
      found = {
        line,
        costUsd:
          typeof total === "number" && Number.isFinite(total) && total >= 0
            ? total
            : null,
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        cacheReadTokens: sum("cacheReadInputTokens"),
        cacheWriteTokens: sum("cacheCreationInputTokens"),
      };
    }
    return found;
  });
}
