import { open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SessionMaintenance } from "@babojubot/contracts";

/** Product-owned transcripts only; bounded tail read, no transcript text leaves this module. */
export async function claudeSessionFacts(
  home: string,
  id: string
): Promise<SessionMaintenance | undefined> {
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
      const size = Math.min(info.size, 512 * 1024),
        buffer = Buffer.alloc(size);
      await file.read(buffer, 0, size, info.size - size);
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
      if (facts) return facts;
    } catch {
      /* Missing/unsupported transcript cannot schedule a guessed maintenance request. */
    } finally {
      await file?.close();
    }
  }
}
