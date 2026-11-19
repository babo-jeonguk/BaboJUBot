import { orgToolNames, orgTools } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { orgToolsRouter } from "./tools.ts";
import { unused } from "../test/stand-ins.ts";

describe("organization tool routes", () => {
  it("serves exactly the routes of the tool list", () => {
    // 경로만 거는 단계라 DB·Event·dispatcher를 부르지 않는다.
    const { router } = orgToolsRouter({
      db: unused("db"),
      hub: unused("hub"),
      dispatcher: unused("dispatcher"),
      now: () => new Date(),
      harnessDir: "",
      providers: unused("providers"),
      workspaces: unused("workspaces"),
    });
    const served = router.stack.flatMap((layer) =>
      layer.route && layer.route.path !== "/mcp"
        ? Object.keys(
            (
              layer.route as typeof layer.route & {
                methods: Record<string, boolean>;
              }
            ).methods
          ).map((method) => `${method.toUpperCase()} ${layer.route!.path}`)
        : []
    );
    expect(served.sort()).toEqual(
      orgToolNames
        .map((tool) => `${orgTools[tool].method} ${orgTools[tool].path}`)
        .sort()
    );
  });
});
