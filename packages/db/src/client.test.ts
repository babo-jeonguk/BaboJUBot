import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { freePort, openDatabase } from "./client.ts";

describe("embedded Postgres lifetime", () => {
  it("closes and removes a non-persistent dataDir after Postgres died on its own", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const handle = await openDatabase({
      embedded: { dataDir, port: await freePort(), persistent: false },
    });
    const client = new pg.Client({ connectionString: handle.url });
    await client.connect();
    const { rows } = await client.query<{ pid: string }>(
      "select split_part(pg_read_file('postmaster.pid'), E'\\n', 1) as pid"
    );
    await client.end();
    const pid = Number(rows[0]!.pid);

    process.kill(pid, "SIGKILL");
    while (isAlive(pid)) await new Promise((r) => setTimeout(r, 50));

    await handle.close();
    expect(fs.existsSync(dataDir)).toBe(false);
  }, 15_000);

  it("lets the process exit promptly when Postgres fails to start", async () => {
    // PG_VERSION이 있어 initdb를 건너뛰지만 cluster가 아니므로 postgres가 바로 끝난다.
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    await fsp.writeFile(path.join(dataDir, "PG_VERSION"), "0\n");
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const { openDatabase, freePort } = await import(${JSON.stringify(clientModule)});
      const port = await freePort();
      await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port, persistent: true } })
        .then(() => console.log("started"), (error) => console.log("failed:", error.message));
    `;
    try {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      let output = "";
      let failedAt = 0;
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        failedAt ||= Date.now();
      });
      await once(child, "exit");

      expect(output).toContain("failed: embedded Postgres exited");
      // embedded-postgres의 종료 hook이 멈추면 async-exit-hook이 10초 뒤에야 강제 종료한다.
      expect(Date.now() - failedAt).toBeLessThan(5_000);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
