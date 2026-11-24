// CI의 Vitest·node:test 실행이 실제로 돌아 통과했는지 판정하고 묶음마다 시험 수를 로그에 남긴다.
// 두 실행기는 시험 파일의 시험이 모두 건너뛰어져도 0으로 끝난다(Vitest의 passWithNoTests는 시험 파일이 없을 때만 본다).
// 그래서 보고서(Vitest의 json 보고, scripts/run-node-tests.mjs의 같은 모양 보고)를 읽어 다음을 실패로 본다.
//   예상한 묶음의 보고서가 없거나 모르는 보고서가 있음, 묶음 정의(scripts/test-suites.ts)가 고르는 시험 파일이 보고서에 없음(설정
//   필터·명령의 파일 목록에서 빠짐), 묶음이 고르지 않는 파일이 보고서에 있음, 통과한 시험이 하나도 없는 시험 파일, 실패하거나 모르는
//   상태의 시험. 기대하는 파일은 실행과 따로 저장소의 파일 목록(Git)과 묶음 정의로 정한다. 시스템이 지원하지 않아 파일 전체를 건너뛰는
//   시험은 아래 목록에 묶음·시스템·사유로 두고, 그 파일도 건너뛴 시험을 보고해야 한다.
// 보고서는 CI가 job마다 준 BABOJUBOT_TEST_REPORTS 폴더의 `<묶음>.json`이다(vitest.reports.ts, scripts/run-node-tests.mjs). 판정한 뒤
// 그 폴더에 표식을 남겨, 같은 job에서 판정 뒤에 도는 묶음은 시작하지 않고 실패한다(scripts/test-suites.ts reportFolder).
// 사용: node scripts/check-test-reports.mjs --expect <묶음>[,<묶음> ...]
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasErrorCode, orIfMissing } from "@babojubot/contracts";
import { judgedMarker, suiteFiles, suiteNamed } from "./test-suites.ts";

const systems = ["linux", "macos", "windows"];
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * 시스템이 지원하지 않아 파일 전체를 건너뛰는 시험. 그 묶음·시스템에서만 통과 없이 끝나도 되고, 그때는 반드시 통과 없이 끝나야
 * 한다(그 시스템에서 돌기 시작했거나 파일이 빠졌으면 목록이 낡았다). 파일 안 일부 시험의 시스템별 건너뜀은 그 자리에 사유를 적는다.
 */
export const intendedExclusions = [
  {
    report: "runtime",
    file: "packages/runtime/src/providers/process-windows.test.ts",
    systems: ["linux", "macos"],
    reason:
      "감독 실행기의 Windows 묶음(Job Object)과 Windows 명령줄(.cmd·경로 검색)의 시험이라 Windows에서만 돈다",
  },
  {
    report: "runtime",
    file: "packages/runtime/src/providers/container.docker.test.ts",
    systems: ["macos", "windows"],
    reason:
      "macOS·Windows 실행기에는 Linux 컨테이너용 Docker가 없다(Linux는 BABOJUBOT_REQUIRE_DOCKER로 필수)",
  },
  {
    report: "runtime",
    file: "packages/runtime/src/providers/container-mounts.test.ts",
    systems: ["windows"],
    reason:
      "Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행)",
  },
  {
    report: "runtime",
    file: "packages/runtime/src/providers/relay.test.ts",
    systems: ["windows"],
    reason:
      "격리 실행의 중계라 Docker 격리를 지원하지 않는 Windows에서는 쓰지 않는다",
  },
  {
    report: "process",
    file: "packages/process/src/ps.test.ts",
    systems: ["windows"],
    reason:
      "ps 한 칸 조회(psField)는 Linux·macOS의 프로세스 신원 조회라 Windows에서는 쓰지 않는다",
  },
  {
    report: "process",
    file: "packages/process/src/clean.test.ts",
    systems: ["windows"],
    reason:
      "표식 정리는 Linux·macOS의 감독 실행기가 한다(Windows는 묶음이 트리를 끄고 표식 정리가 없다)",
  },
  {
    report: "runtime",
    file: "packages/runtime/src/providers/process-leftovers.test.ts",
    systems: ["windows"],
    reason:
      "Windows에는 새 세션으로 나가는 명령이 없다(남은 프로그램은 process-windows.test.ts가 본다)",
  },
  {
    report: "files",
    file: "packages/files/src/regular-file-follow.test.ts",
    systems: ["windows"],
    reason:
      "링크를 따라가는 Windows의 열기를 Linux·macOS에서 재현하는 시험이라, Windows에서는 regular-file.test.ts가 실제 길을 본다",
  },
  {
    report: "process-alone",
    file: "packages/process/src/lease-hidden.alone.test.ts",
    systems: ["macos", "windows"],
    reason: "systemd 사용자 scope는 Linux에만 있다",
  },
  {
    report: "runtime-alone",
    file: "packages/runtime/src/providers/process-hidden.alone.test.ts",
    systems: ["macos", "windows"],
    reason:
      "환경을 읽을 수 없게 막은 프로그램(prctl)과 그 표식 확인은 Linux의 /proc에만 있다",
  },
];

/** Node의 `process.platform`을 이 검사의 시스템 이름으로 바꾼다. */
export function systemOf(platform) {
  const os = { linux: "linux", darwin: "macos", win32: "windows" }[platform];
  if (!os) throw new Error(`unsupported platform "${platform}"`);
  return os;
}

/** 보고서의 절대 경로를 저장소 기준 `/` 경로로 바꾼다. */
const relative = (file) => path.relative(root, file).split(path.sep).join("/");

const statuses = ["passed", "failed", "skipped", "pending", "todo"];

/** 보고서 하나를 판정한다. `selected`는 묶음 정의가 고르는 시험 파일이다. */
function judgeReport(name, report, os, selected) {
  const problems = [];
  const files = (report.testResults ?? []).map((result) => ({
    file: relative(result.name),
    tests: result.assertionResults ?? [],
  }));
  const ran = new Set(files.map((f) => f.file));
  for (const file of selected)
    if (!ran.has(file))
      problems.push(
        `${name}: ${file} did not run, though the suite selects it (scripts/test-suites.ts)`
      );
  for (const { file } of files)
    if (!selected.includes(file))
      problems.push(
        `${name}: ran ${file}, which the suite does not select (scripts/test-suites.ts)`
      );
  const all = files.flatMap((f) => f.tests);
  const count = (status) => all.filter((t) => t.status === status).length;
  const line = `${name}: ${files.length} files, ${all.length} tests, ${count("passed")} passed, ${count("skipped") + count("pending")} skipped, ${count("todo")} todo, ${count("failed")} failed`;
  if (files.length === 0) problems.push(`${name}: no test file ran`);
  const excluded = intendedExclusions.filter(
    (e) => e.report === name && e.systems.includes(os)
  );
  for (const { file, tests } of files) {
    for (const t of tests) {
      if (t.status === "failed")
        problems.push(`${name}: failed: ${file} › ${t.fullName ?? t.title}`);
      else if (!statuses.includes(t.status))
        problems.push(
          `${name}: unknown status ${t.status}: ${file} › ${t.fullName ?? t.title}`
        );
    }
    const passed = tests.some((t) => t.status === "passed");
    const exclusion = excluded.find((e) => e.file === file);
    if (exclusion && passed)
      problems.push(
        `${name}: ${file} passed on ${os} but is listed as skipped there (${exclusion.reason}); remove it from the list`
      );
    else if (exclusion && tests.length === 0)
      problems.push(
        `${name}: ${file} is listed as skipped on ${os} but recorded no test; a skipped file still reports its skipped tests`
      );
    else if (!exclusion && !passed)
      problems.push(
        `${name}: ${file} passed no test on ${os} (${tests.length} tests: ${[...new Set(tests.map((t) => t.status))].join(", ") || "none"})`
      );
  }
  for (const exclusion of excluded)
    if (!files.some((f) => f.file === exclusion.file))
      problems.push(
        `${name}: ${exclusion.file} is listed as skipped on ${os} but did not run; update the list`
      );
  return { line, problems };
}

/**
 * 판정한다. `reports`는 묶음 이름 → 보고서, `expected`는 이 job이 돌린 묶음, `os`는 이 job의 시스템이다.
 * `problems`가 비어 있어야 성공이다.
 * `files`는 저장소의 파일 목록(Git, 저장소 기준 경로)이고 묶음마다 기대하는 시험 파일을 그것과 묶음 정의로 정한다.
 * @param {Map<string, any>} reports
 * @param {{ os: string, expected: string[], files: string[] }} options
 */
export function judgeReports(reports, { os, expected, files }) {
  if (!systems.includes(os))
    throw new Error(`unknown system "${os}" (one of ${systems.join(", ")})`);
  const lines = [];
  const problems = [];
  for (const name of expected)
    if (!reports.has(name)) problems.push(`${name}: no test report`);
  for (const [name, report] of reports) {
    if (!expected.includes(name)) {
      problems.push(`${name}: report this job did not expect`);
      continue;
    }
    const judged = judgeReport(
      name,
      report,
      os,
      suiteFiles(suiteNamed(name), files)
    );
    lines.push(judged.line);
    problems.push(...judged.problems);
  }
  return { lines, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [flag, list] = process.argv.slice(2);
  const expected = (list ?? "").split(",").filter(Boolean);
  const folder = process.env.BABOJUBOT_TEST_REPORTS;
  if (flag !== "--expect" || expected.length === 0 || !folder) {
    console.error(
      "usage: BABOJUBOT_TEST_REPORTS=<folder> node scripts/check-test-reports.mjs --expect <suite>[,<suite> ...]"
    );
    process.exit(1);
  }
  // 모르는 묶음 이름은 판정할 정의가 없다. 보고서를 읽기 전에 거부한다.
  for (const name of expected) suiteNamed(name);
  const reports = new Map();
  // 폴더가 없으면 어느 묶음도 보고서를 남기지 않은 것이다. 그때는 예상한 묶음마다 보고서가 없다고 알린다.
  const entries = orIfMissing(
    () => readdirSync(folder),
    hasErrorCode("ENOENT"),
    []
  );
  for (const entry of entries.filter((e) => e.endsWith(".json"))) {
    const file = path.join(folder, entry);
    try {
      reports.set(
        entry.slice(0, -".json".length),
        JSON.parse(readFileSync(file, "utf8"))
      );
    } catch (error) {
      console.error(
        `cannot read test report ${file}: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
  }
  // 기대하는 시험 파일은 실행과 따로 저장소의 파일 목록에서 정한다(추적한 파일과 무시하지 않은 새 파일).
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    }
  )
    .split("\0")
    .filter(Boolean);
  const { lines, problems } = judgeReports(reports, {
    os: systemOf(process.platform),
    expected,
    files,
  });
  for (const line of lines) console.log(line);
  for (const problem of problems) console.error(problem);
  // 이 job의 보고서를 판정했다. 뒤에 도는 묶음은 판정되지 않으므로 시작하지 않는다(reportFolder).
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, judgedMarker),
    `judged ${expected.join(",")}\n`
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}
