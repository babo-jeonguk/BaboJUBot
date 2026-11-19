import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// setup이 적은 공용 서버(setup.ts)에 닿는지 본다. SHARED_SERVER_RUN_FAIL_BODY면 본문이 실패한다.
test("reaches the shared server", async () => {
  const { url } = JSON.parse(
    readFileSync(process.env.SHARED_SERVER_RUN_STATE!, "utf8")
  ) as { url: string };
  const res = await fetch(`${url}/api/health`);
  expect(res.status).toBe(200);
  if (process.env.SHARED_SERVER_RUN_FAIL_BODY)
    throw new Error("body failed on purpose");
});
