// file-boundary-reports/의 볼륨별 시험 결과를 사례 표(C01–C37, F1–F6)로 모은다. GitHub job 요약과
// file-boundary-reports/summary.{md,json}에 쓴다.
//   node scripts/file-boundary-report.mjs --require NTFS,FAT32,SMB [--reports <folder>]
// 요구한 볼륨이 준비되지 않았거나, 결과가 없거나, 시험이 하나라도 실패했거나, 사례가 빠졌으면 실패한다.
// 적용 불가(n/a)·미검증(unverified)은 통과 수에 넣지 않고 이유와 함께 따로 보인다.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const caseIds = [
  ...Array.from({ length: 37 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`),
  "F3",
];
/** 결함·차이 F1–F6을 확인하는 사례. */
export const findings = {
  F1: "C33",
  F2: "C32",
  F3: "F3",
  F4: "C36",
  F5: "C15",
  F6: "C14",
};
const marks = {
  pass: "✅ pass",
  limitation: "⚠️ limitation",
  "n/a": "➖ n/a",
  unverified: "❓ unverified",
  defect: "❌ defect",
  missing: "❌ not run",
};

/** 볼륨 하나의 결과. */
export function summarize(volume, meta, report) {
  const problems = [];
  const outcomes = {};
  let environment;
  if (!meta) problems.push("no run record");
  else if (meta.error) problems.push(meta.error);
  else if (meta.exitCode !== 0)
    problems.push(`tests exited with ${meta.exitCode}`);
  if (!report) problems.push("no test report");
  const failures = [];
  for (const file of report?.testResults ?? [])
    for (const test of file.assertionResults ?? []) {
      environment ??= test.meta?.environment;
      const id = test.title.match(/^(C\d{2}|F\d|ENV)\b/)?.[1];
      if (test.status === "failed") {
        failures.push(
          `${path.basename(file.name)} › ${test.title}: ${(test.failureMessages?.[0] ?? "").split("\n")[0]}`
        );
        if (id)
          outcomes[id] = {
            outcome: "defect",
            detail: (test.failureMessages?.[0] ?? "").split("\n")[0],
          };
        continue;
      }
      for (const note of test.meta?.cases ?? [])
        outcomes[note.id] ??= { outcome: note.outcome, detail: note.detail };
      if (id && id !== "ENV" && !outcomes[id])
        outcomes[id] = {
          outcome: test.status === "passed" ? "missing" : "unverified",
          detail: `test ${test.status} without a recorded outcome`,
        };
    }
  if (report && report.numFailedTests > 0)
    problems.push(`${report.numFailedTests} failed tests`);
  if (report && !environment) problems.push("environment not identified");
  for (const id of caseIds) {
    outcomes[id] ??= { outcome: "missing", detail: "not run" };
    if (outcomes[id].outcome === "missing") problems.push(`${id} not run`);
  }
  return {
    volume,
    environment,
    meta,
    totals: report
      ? {
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          skipped: report.numPendingTests + (report.numTodoTests ?? 0),
          total: report.numTotalTests,
        }
      : undefined,
    outcomes,
    failures,
    problems,
  };
}

export function render(summaries) {
  const lines = ["## File boundary verification", ""];
  lines.push(
    "| Volume | OS | File system | Case-sensitive | NFD finds NFC | Links | Hard links | dev / ino / nlink | Tests | Time |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of summaries) {
    const e = s.environment ?? {};
    lines.push(
      `| ${s.volume} | ${e.platform ?? "?"} ${e.release ?? ""} · Node ${e.node ?? "?"} | ${s.meta?.fileSystem ?? "?"} | ${e.caseSensitive ?? "?"} | ${e.normalizationInsensitive ?? "?"} | ${e.symlink ?? "?"} | ${e.hardLink ?? "?"} | ${e.file ? `${e.file.dev} / ${e.file.ino} / ${e.file.nlink}` : "?"} | ${s.totals ? `${s.totals.passed} passed, ${s.totals.failed} failed, ${s.totals.skipped} skipped` : "none"} | ${s.meta?.seconds ?? "?"}s |`
    );
  }
  lines.push("", `| Case | ${summaries.map((s) => s.volume).join(" | ")} |`);
  lines.push(`| --- | ${summaries.map(() => "---").join(" | ")} |`);
  for (const id of caseIds)
    lines.push(
      `| ${id} | ${summaries.map((s) => marks[s.outcomes[id].outcome]).join(" | ")} |`
    );
  for (const [finding, id] of Object.entries(findings))
    lines.push(
      `| ${finding} (${id}) | ${summaries.map((s) => marks[s.outcomes[id].outcome]).join(" | ")} |`
    );
  lines.push(
    "",
    "| Count | " + summaries.map((s) => s.volume).join(" | ") + " |"
  );
  lines.push(`| --- | ${summaries.map(() => "---").join(" | ")} |`);
  for (const outcome of Object.keys(marks))
    lines.push(
      `| ${marks[outcome]} | ${summaries.map((s) => caseIds.filter((id) => s.outcomes[id].outcome === outcome).length).join(" | ")} |`
    );
  lines.push("", "### Notes");
  for (const s of summaries) {
    lines.push(
      "",
      `**${s.volume}** — \`${s.meta?.dir ?? ""}\` · ${s.meta?.sha ?? ""}`
    );
    for (const problem of s.problems) lines.push(`- ❌ ${problem}`);
    for (const failure of s.failures) lines.push(`- ❌ ${failure}`);
    for (const id of caseIds) {
      const { outcome, detail } = s.outcomes[id];
      if (detail) lines.push(`- ${id} ${marks[outcome]}: ${detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const option = (name) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const folder =
    option("reports") ??
    fileURLToPath(new URL("../file-boundary-reports", import.meta.url));
  const required = (option("require") ?? "").split(",").filter(Boolean);
  if (required.length === 0) {
    console.error("usage: --require <volume,...>");
    process.exit(2);
  }
  const load = (file) =>
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const summaries = required.map((volume) =>
    summarize(
      volume,
      load(path.join(folder, `${volume}.meta.json`)),
      load(path.join(folder, `${volume}.json`))
    )
  );
  const markdown = render(summaries);
  writeFileSync(path.join(folder, "summary.md"), markdown);
  writeFileSync(
    path.join(folder, "summary.json"),
    JSON.stringify(summaries, null, 2)
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  const failed = summaries.filter(
    (s) => s.problems.length > 0 || s.failures.length > 0
  );
  if (failed.length > 0) {
    console.error(
      `file boundary verification failed on ${failed.map((s) => s.volume).join(", ")}`
    );
    process.exitCode = 1;
  }
}
