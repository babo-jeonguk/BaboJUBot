// 부팅 확인이 서버 준비로 받는 `/api/overview` 응답은 대시보드가 읽는 응답 계약(overviewSchema)을 지켜야 한다(#286 항목 29).
// HTTP 200에 `{}`·`[]`이나 JSON이 아닌 본문이 와도 준비됨으로 보면, 대시보드가 거부할 서버를 부팅 확인은 통과시킨다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { overviewFields } from "./boot-check-overview.ts";

/** 새로 뜬 서버(조직 없음)가 내는 개요: apps/server/src/app.ts의 `/api/overview`. */
const freshOverview = {
  asOf: "2026-11-23T00:00:00.000Z",
  runs: { running: 0, cancelling: 0 },
  organizations: [],
};

test("accepts an overview the dashboard reads and counts its fields", () => {
  assert.equal(
    overviewFields("start", JSON.stringify(freshOverview)),
    Object.keys(freshOverview).length
  );
});

test("refuses a 200 answer that breaks the dashboard's overview contract", () => {
  for (const body of [
    {},
    [],
    { ...freshOverview, asOf: "yesterday" },
    { asOf: freshOverview.asOf, runs: freshOverview.runs },
  ])
    assert.throws(
      () => overviewFields("start", JSON.stringify(body)),
      /^Error: start: \/api\/overview answered .* that breaks the overview contract: /,
      JSON.stringify(body)
    );
});

test("refuses a 200 answer that is not JSON instead of waiting for another", () => {
  assert.throws(
    () => overviewFields("start", "<html>proxy error</html>"),
    /^Error: start: \/api\/overview answered a body that is not JSON: /
  );
});
