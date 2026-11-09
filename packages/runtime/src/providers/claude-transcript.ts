import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SessionMaintenance } from "@babojubot/contracts";

/** Claude's saved cumulative session cost, as written to the session transcript. */
export type ClaudeSessionCost = {
  /** The raw row as JSON text, so callers can tell whether Claude saved a new row. */
  row: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

/** Claude's own saved cost for a session; last valid `cost-state` row wins. */
export async function claudeSessionCost(
  home: string,
  id: string
): Promise<ClaudeSessionCost | undefined> {
  return sessionTranscripts(home, id, async (file) => {
    let found: ClaudeSessionCost | undefined;
    for await (const raw of file.readLines()) {
      const line = raw.trim();
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !row ||
        row.type !== "cost-state" ||
        row.sessionId !== id ||
        typeof row.totalCostUSD !== "number" ||
        !Number.isFinite(row.totalCostUSD) ||
        row.totalCostUSD < 0 ||
        !row.modelUsage ||
        typeof row.modelUsage !== "object"
      )
        continue;
      const sum = (key: string): number | undefined => {
        let total = 0;
        for (const usage of Object.values(
          row.modelUsage as Record<string, unknown>
        )) {
          const value = (usage as Record<string, unknown> | null)?.[key];
          if (value === undefined) continue;
          if (!Number.isSafeInteger(value) || (value as number) < 0)
            return undefined;
          total += value as number;
        }
        return total;
      };
      const inputTokens = sum("inputTokens"),
        outputTokens = sum("outputTokens"),
        cacheReadTokens = sum("cacheReadInputTokens"),
        cacheWriteTokens = sum("cacheCreationInputTokens");
      if (
        inputTokens === undefined ||
        outputTokens === undefined ||
        cacheReadTokens === undefined ||
        cacheWriteTokens === undefined
      )
        continue;
      found = {
        row: line,
        costUsd: row.totalCostUSD,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      };
    }
    return found;
  });
}
