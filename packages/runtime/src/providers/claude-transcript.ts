import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  addUsage,
  isTokenCount,
  isUsageAnomaly,
  usageAmount,
  type SessionMaintenance,
  type UsageAmount,
} from "@babojubot/contracts";
import { record } from "./record.ts";

/** Claude's saved cumulative session cost, as written to the session transcript. A bad saved figure stays an anomaly. */
export type ClaudeSessionCost = {
  /** The 0-based index of the saved row's line in the transcript file. */
  line: number;
  costUsd: UsageAmount;
  inputTokens: UsageAmount;
  outputTokens: UsageAmount;
  cacheReadTokens: UsageAmount;
  cacheWriteTokens: UsageAmount;
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]!);
      } catch {
        continue;
      }
      const row = record(parsed);
      if (row.isSidechain || row.sessionId !== id) continue;
      if (row.subtype === "compact_boundary" || row.isCompactSummary) break;
      if (row.type !== "assistant") continue;
      const usage = record(record(row.message).usage);
      if (typeof row.timestamp !== "string") continue;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at)) continue;
      const counts = [
        usage.input_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      ];
      if (!counts.every(isTokenCount)) continue;
      const tokens = counts.reduce((sum, n) => sum + n, 0);
      if (!isTokenCount(tokens)) continue;
      facts ??= {
        tokens,
        lastRequestAt: new Date(at).toISOString(),
        ttlMs: 3600000,
      };
      const creation = record(usage.cache_creation);
      const ephemeral5m = creation.ephemeral_5m_input_tokens;
      if (typeof ephemeral5m === "number" && ephemeral5m > 0) {
        facts.ttlMs = 300000;
        return facts;
      }
      const ephemeral1h = creation.ephemeral_1h_input_tokens;
      if (typeof ephemeral1h === "number" && ephemeral1h > 0) return facts;
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const row = record(parsed);
      if (row.type !== "cost-state" || row.sessionId !== id) continue;
      const total = row.totalCostUSD;
      const modelUsage = row.modelUsage;
      /** All models' counts; a model without the count leaves the session's total unknown, a bad count makes it an anomaly. */
      const modelsTotal = (key: string): UsageAmount => {
        if (!modelUsage || typeof modelUsage !== "object") return null;
        const entries = Object.values(modelUsage as Record<string, unknown>);
        if (entries.length === 0) return null;
        let total: UsageAmount = 0,
          missing = false;
        for (const usage of entries) {
          const value = usageAmount(
            "tokens",
            (usage as Record<string, unknown> | null)?.[key]
          );
          if (value === null) missing = true;
          else total = addUsage("tokens", total, value);
        }
        return missing && !isUsageAnomaly(total) ? null : total;
      };
      found = {
        line,
        costUsd: usageAmount("usd", total),
        inputTokens: modelsTotal("inputTokens"),
        outputTokens: modelsTotal("outputTokens"),
        cacheReadTokens: modelsTotal("cacheReadInputTokens"),
        cacheWriteTokens: modelsTotal("cacheCreationInputTokens"),
      };
    }
    return found;
  });
}
