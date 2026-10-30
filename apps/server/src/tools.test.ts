import { orgToolNames, orgTools } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { orgToolsRouter } from "./tools.ts";

describe("organization tool routes", () => {
  it("serves exactly the routes of the tool list", () => {
    // 경로만 거는 단계라 DB·Event·dispatcher를 부르지 않는다.
    const router = orgToolsRouter({
      db: undefined as never,
      hub: undefined as never,
      dispatcher: undefined as never,
      now: () => new Date(),
      harnessDir: "",
      providers: undefined as never,
    });
    const served = router.stack.flatMap((layer) =>
      layer.route
        ? Object.keys(
            (layer.route as unknown as { methods: Record<string, boolean> })
              .methods
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
