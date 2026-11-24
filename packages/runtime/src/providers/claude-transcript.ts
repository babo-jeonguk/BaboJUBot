import { readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  addUsage,
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  isTokenCount,
  isUsageAnomaly,
  orIfMissing,
  orIfUnreadable,
  usageAmount,
  type SessionMaintenance,
  type UsageAmount,
} from "@babojubot/contracts";
import {
  inFolder,
  openRegularFile,
  type OpenedRegularFile,
} from "@babojubot/files";
import { record } from "./record.ts";

const unreadable = Symbol("unreadable");

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
  const listed = await continueAfterFailure(
    () =>
      inFolder(home, ["config", "projects"], (folder) =>
        orIfMissing(
          () => readdir(folder.path, { withFileTypes: true }),
          hasErrorCode("ENOENT", "ENOTDIR"),
          undefined
        )
      ),
    (error) =>
      console.warn(
        `[provider] the Claude session folders could not be read (${failureCode(error)})`
      )
  );
  // Transcripts are read for usage facts, not to allow anything. A folder we cannot look into is not the same as
  // no transcript, so say why before skipping.
  if (listed === undefined) return;
  switch (listed.state) {
    case "reached":
      break;
    case "absent":
      return;
    case "unverifiable":
      console.warn(
        `[provider] a Claude session transcript folder could not be checked (${listed.found})`
      );
      return;
    default: {
      const unhandled: never = listed;
      throw new Error(`unhandled folder state ${String(unhandled)}`);
    }
  }
  const folders = listed.value;
  if (!folders) return;
  for (const entry of folders) {
    if (!entry.isDirectory()) continue;
    const found = await continueAfterFailure(
      () =>
        inFolder(home, ["config", "projects", entry.name], async (folder) => {
          let file: OpenedRegularFile | undefined;
          try {
            const opened = await openRegularFile(folder.at(`${id}.jsonl`));
            if (typeof opened === "string") {
              // 확인한 폴더 안에서 열었으므로, 여는 사이 자리가 바뀐 것만 알린다. 없음·일반 파일 아님은 기록이 없는 것이다.
              if (opened === "changed")
                console.warn(
                  "[provider] a Claude session transcript changed while it was opened"
                );
              return;
            }
            file = opened;
            return await read(opened.handle, Number(opened.info.size));
          } catch (error) {
            console.warn(
              `[provider] a Claude session transcript could not be read (${failureCode(error)})`
            );
            /* Missing/unsupported transcript cannot schedule a guessed maintenance request. */
          } finally {
            const opened = file;
            if (opened)
              await continueAfterFailure(
                () => opened.handle.close(),
                (error) =>
                  console.warn(
                    `[provider] a Claude session transcript handle could not be closed (${failureCode(error)})`
                  )
              );
          }
        }),
      (error) =>
        console.warn(
          `[provider] a Claude session transcript could not be read (${failureCode(error)})`
        )
    );
    if (found === undefined) continue;
    switch (found.state) {
      case "reached":
        if (found.value !== undefined) return found.value;
        break;
      case "absent":
        break;
      case "unverifiable":
        console.warn(
          `[provider] a Claude session transcript folder could not be checked (${found.found})`
        );
        break;
      default: {
        const unhandled: never = found;
        throw new Error(`unhandled folder state ${String(unhandled)}`);
      }
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
      const parsed = orIfUnreadable(
        (): unknown => JSON.parse(lines[index]!),
        unreadable
      );
      if (parsed === unreadable) continue;
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
      const parsed = orIfUnreadable(
        (): unknown => JSON.parse(text),
        unreadable
      );
      if (parsed === unreadable) continue;
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
