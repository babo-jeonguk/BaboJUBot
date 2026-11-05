import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerSettingsSchema } from "@babojubot/contracts";
import { createFakeProviders } from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const settings = async () => {
  const res = await t!.request("GET", "/api/providers");
  expect(res.status).toBe(200);
  return providerSettingsSchema.parse(res.body);
};

describe("isolation switch", () => {
  it("is off by default and is saved at once when the owner turns it on and off", async () => {
    t = await startTestServer({ providers: createFakeProviders(1) });
    expect((await settings()).isolated).toBe(false);

    const watcher = await t.subscribe({ kind: "all" });
    const on = await t.request("PUT", "/api/providers/isolation", {
      isolated: true,
    });
    expect(on.status).toBe(200);
    expect(providerSettingsSchema.parse(on.body).isolated).toBe(true);
    expect((await settings()).isolated).toBe(true);
    // 다른 탭은 전역 설정 변경 신호로 다시 불러온다.
    await expect.poll(() => watcher.settingsSignals()).toBeGreaterThan(0);
    watcher.close();

    const off = await t.request("PUT", "/api/providers/isolation", {
      isolated: false,
    });
    expect(off.status).toBe(200);
    expect((await settings()).isolated).toBe(false);
  });

  it("refuses a value that is not on or off", async () => {
    t = await startTestServer({ providers: createFakeProviders(1) });
    for (const body of [{ isolated: "yes" }, {}, { isolated: true, extra: 1 }])
      expect(
        (await t.request("PUT", "/api/providers/isolation", body)).status
      ).toBe(422);
    expect((await settings()).isolated).toBe(false);
  });

  it("keeps the saved value across a server restart", async () => {
    t = await startTestServer({ providers: createFakeProviders(1) });
    await t.request("PUT", "/api/providers/isolation", { isolated: true });
    await t.stopServer();
    const db = t.db;
    const { startServer } = await import("../src/index.ts");
    const again = await startServer({
      db,
      port: 0,
      dataDir: await mkdtemp(path.join(tmpdir(), "babojubot-isolation-")),
      providers: createFakeProviders(1),
    });
    try {
      const res = await fetch(again.url + "/api/providers");
      expect(providerSettingsSchema.parse(await res.json()).isolated).toBe(
        true
      );
    } finally {
      await again.close();
    }
  });
});
