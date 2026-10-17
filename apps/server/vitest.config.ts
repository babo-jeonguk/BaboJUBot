import { defineConfig } from "vitest/config";

// Tests start embedded Postgres clusters and a child server process; give them room on a busy machine.
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 30_000 },
});
