import { expect, test } from "@playwright/test";

// 공용 서버에 닿는지 본다. SHARED_SERVER_RUN_FAIL_BODY면 본문이 실패한다.
test("reaches the shared server", async () => {
  const res = await fetch(`${process.env.SHARED_SERVER_URL}/api/health`);
  expect(res.status).toBe(200);
  if (process.env.SHARED_SERVER_RUN_FAIL_BODY)
    throw new Error("body failed on purpose");
});
