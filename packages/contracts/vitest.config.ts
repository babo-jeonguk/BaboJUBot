import { configDefaults, defineConfig } from "vitest/config";
import { testReport } from "../../vitest.reports.ts";

export default defineConfig({
  test: {
    reporters: [...configDefaults.reporters, ...testReport("contracts")],
  },
});
