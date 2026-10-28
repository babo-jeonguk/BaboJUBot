import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  freePort,
  createTestDatabase,
  type TestDatabase,
} from "@babojubot/db/testing";
import { listOrganizations } from "@babojubot/db";
import { afterAll, beforeAll, expect, it } from "vitest";

let external: TestDatabase;
beforeAll(async () => {
  external = await createTestDatabase();
});
afterAll(async () => {
  await external?.close();
});

it("starts against an external Postgres URL and leaves that Postgres running on shutdown", async () => {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    {
      env: { ...process.env, DATABASE_URL: external.url, PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  try {
    const [line] = await once(child.stdout!, "data");
    expect(String(line)).toContain("external Postgres");

    const res = await fetch(`http://127.0.0.1:${port}/api/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "외부 DB 조직", goal: "외부 DB 목표" }),
    });
    expect(res.status).toBe(201);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }

  // The server only owned its connections: the external database still answers.
  expect((await listOrganizations(external.db)).map((o) => o.name)).toContain(
    "외부 DB 조직"
  );
});
