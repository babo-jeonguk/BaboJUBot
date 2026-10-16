import { defineConfig } from "vitest/config";

// Each test file starts its own embedded Postgres; give cluster startup room.
export default defineConfig({ test: { hookTimeout: 60_000 } });
