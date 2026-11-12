import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { caseIds, summarize } from "./file-boundary-report.mjs";

const script = fileURLToPath(
  new URL("./file-boundary-report.mjs", import.meta.url)
);
const meta = {
  volume: "NTFS",
  fileSystem: "NTFS",
  dir: "D:\\files",
  exitCode: 0,
};

/** Vitest JSON 결과를 흉내 낸다. 사례마다 시험 하나, `outcomes`로 일부 사례의 결과를 바꾼다. */
function report(outcomes = {}) {
  const tests = [
    {
      title: "ENV records the file system",
      status: "passed",
      meta: { environment: { platform: "win32" } },
    },
    ...caseIds.map((id) => {
      const outcome = outcomes[id] ?? "pass";
      return {
        title: `${id} case`,
        status:
          outcome === "pass" || outcome === "limitation" ? "passed" : "skipped",
        meta: {
          cases: [{ id, outcome, detail: outcome === "pass" ? "" : "reason" }],
        },
      };
    }),
  ];
  const skipped = tests.filter((t) => t.status === "skipped").length;
  return {
    numTotalTests: tests.length,
    numPassedTests: tests.length - skipped,
    numFailedTests: 0,
    numPendingTests: skipped,
    testResults: [{ name: "workspace-cases.test.ts", assertionResults: tests }],
  };
}

test("accepts passes, allowed limitations and features the file system lacks", () => {
  const summary = summarize(
    "NTFS",
    meta,
    report({ C05: "limitation", C17: "n/a" })
  );
  assert.deepEqual(summary.problems, []);
});

test("fails a volume when a case could not be verified, even though Vitest exited 0", () => {
  const summary = summarize("NTFS", meta, report({ C26: "unverified" }));
  assert.deepEqual(summary.problems, ["C26 unverified: reason"]);
});

test("fails a case that was skipped without recording why", () => {
  const skipped = report();
  const c18 = skipped.testResults[0].assertionResults.find((t) =>
    t.title.startsWith("C18")
  );
  c18.status = "skipped";
  c18.meta = {};
  assert.deepEqual(summarize("NTFS", meta, skipped).problems, [
    "C18 unverified: test skipped without a recorded outcome",
  ]);
});

test("the command exits non-zero when one case is unverified", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "bj-report-"));
  try {
    writeFileSync(path.join(folder, "NTFS.meta.json"), JSON.stringify(meta));
    writeFileSync(
      path.join(folder, "NTFS.json"),
      JSON.stringify(report({ C34: "unverified" }))
    );
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    const result = spawnSync(
      process.execPath,
      [script, "--require", "NTFS", "--reports", folder],
      { encoding: "utf8", env, timeout: 10_000 }
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /failed on NTFS/);
    assert.match(result.stdout, /C34 unverified: reason/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
