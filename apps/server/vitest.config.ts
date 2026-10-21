import { defineConfig } from "vitest/config";

// Tests start embedded Postgres clusters and a child server process. The slowest takes ~12s on an idle
// machine; the limits leave room for a busy shared machine and still name a hung test.
export default defineConfig({
  test: { hookTimeout: 120_000, testTimeout: 120_000 },
});
