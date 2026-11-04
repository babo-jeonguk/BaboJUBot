import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
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

// E2E 서버처럼 임시 DB로 띄운 서버의 조직은 끝나면 DB와 함께 사라진다. 그 조직 폴더도 임시 제품 폴더에 두고,
// 서버가 멈춘 뒤 지워 개발용 제품 폴더(BABOJUBOT_HOME)에 쌓이지 않게 한다.
it("keeps a temporary product folder only while the server runs", async () => {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        DATABASE_URL: "",
        BABOJUBOT_EPHEMERAL_DB: "1",
        BABOJUBOT_EPHEMERAL_HOME: "1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  let home: string | undefined;
  try {
    const [line] = await once(child.stdout!, "data");
    home = /product folder (.+)\)/.exec(String(line))?.[1];
    expect(home).toBeDefined();
    expect(path.resolve(home!)).not.toBe(
      path.resolve(process.env.BABOJUBOT_HOME!)
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "임시 폴더 조직", goal: "임시 폴더 목표" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(existsSync(path.join(home!, "organizations", id))).toBe(true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }

  expect(existsSync(home!)).toBe(false);
  expect(
    existsSync(path.join(process.env.BABOJUBOT_HOME!, "organizations"))
  ).toBe(false);
});
