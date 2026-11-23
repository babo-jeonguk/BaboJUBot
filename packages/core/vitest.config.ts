import { configDefaults, defineConfig } from "vitest/config";
import { suiteTest } from "../../vitest.reports.ts";

export default defineConfig({
  test: { ...suiteTest("core", configDefaults) },
});
