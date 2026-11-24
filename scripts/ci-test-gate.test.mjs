import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { removeFolder } from "@babojubot/process/remove-folder";
import { importedSpecifiers } from "./module-imports.ts";
import { codeFormatNames, codeFormats } from "./test-files.mjs";
import { testSuites } from "./test-suites.ts";

const workflow = parse(
  readFileSync(
    new URL("../.github/workflows/scaffold.yml", import.meta.url),
    "utf8"
  )
);
// macOS·Windows도 필수다. 실제 프로그램 연결·파일 경계·부팅 검사가 시스템마다 달라 그 시스템에서만 드러나는 결함을 막는다.
// Windows의 서버 정상 종료와 화면 E2E(두 shard job e2e-windows-1·2와 보고서 판정 e2e-windows)도 코드 변경마다 성공해야 한다.
const suites = [
  "unit",
  "runtime",
  "db",
  "server",
  "opencode",
  "macos",
  "windows",
  "e2e-windows-1",
  "e2e-windows-2",
  "e2e-windows",
];
// 파일 시스템별 전체 검증 job. changes의 files 출력이 true일 때만 돌고 그때는 모두 성공해야 한다.
const fileSuites = ["files-linux", "files-windows", "files-macos"];
const gate = workflow.jobs.test;
const step = gate.steps.find(
  (candidate) => candidate.name === "Check test results"
);
const gateCommand = step.run.match(
  /^node (scripts\/check-ci-test-gate\.mjs)\s*$/
);
assert.ok(gateCommand, `Unsupported gate command: ${step.run}`);
// Resolve the checked-in script from the workflow's captured relative path.
// fileURLToPath keeps Windows drive letters and spaces intact.
const gateScript = fileURLToPath(
  new URL(`../${gateCommand[1]}`, import.meta.url)
);

// Replay the reported boundary: a legacy matrix summary says success even though
// an individual test did not succeed. Resolve the workflow's actual env bindings
// and run its actual Node gate with the current Node binary; do not substitute a
// second gate implementation.
/**
 * @param {{ code?: string, files?: string, changes?: string, results?: Record<string, string>,
 *   fileResults?: Record<string, string>, executablePath?: string, summary?: string }} [options]
 */
function runGate({
  code = "true",
  files = "false",
  changes = "success",
  results = {},
  fileResults = {},
  executablePath = process.env.PATH,
  summary,
} = {}) {
  const needs = {
    changes: { result: changes, outputs: { code, files } },
    "test-packages": { result: code === "false" ? "skipped" : "success" },
    ...Object.fromEntries(
      suites.map((suite) => [
        `test-${suite}`,
        {
          result: results[suite] ?? (code === "false" ? "skipped" : "success"),
        },
      ])
    ),
    ...Object.fromEntries(
      fileSuites.map((suite) => [
        suite,
        {
          result:
            fileResults[suite] ?? (files === "true" ? "success" : "skipped"),
        },
      ])
    ),
  };
  const env = { PATH: executablePath };
  if (summary) env.GITHUB_STEP_SUMMARY = summary;
  // Windows child processes may need the system root to load runtime DLLs.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [name, expression] of Object.entries(step.env)) {
    // 실패 이유 조회용 토큰. 시험에서는 비워 조회 없이 판정만 본다.
    if (name === "GITHUB_TOKEN") {
      assert.equal(expression, "${{ github.token }}");
      continue;
    }
    const match = expression.match(
      /^\$\{\{\s*needs\.([\w-]+)\.(result|outputs\.code|outputs\.files)\s*\}\}$/
    );
    assert.ok(match, `Unsupported gate binding: ${name}=${expression}`);
    const value = match[2]
      .split(".")
      .reduce((object, key) => object?.[key], needs[match[1]]);
    env[name] = value ?? "";
  }
  const result = spawnSync(process.execPath, [gateScript], {
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function assertRejected(input) {
  const result = runGate(input);
  assert.notEqual(
    result.status,
    0,
    `Gate accepted unsafe results: ${result.stdout}`
  );
}

test("each mandatory suite has its own job result and direct gate dependency", () => {
  assert.equal(gate.name, "ci / test");
  assert.equal(gate.if, "always()");
  assert.ok(gate.needs.includes("changes"));
  for (const suite of suites) {
    const id = `test-${suite}`;
    assert.ok(workflow.jobs[id], `Missing independent job ${id}`);
    assert.equal(workflow.jobs[id].strategy?.matrix, undefined);
    assert.ok(gate.needs.includes(id), `Gate must directly need ${id}`);
    assert.ok(
      Object.values(step.env).some((binding) =>
        binding.includes(`needs.${id}.result`)
      ),
      `Gate must receive ${id}'s own result`
    );
  }
});

// macOS·Windows job은 각자 그 시스템에서 돌고, 상태 이름은 예전 matrix와 같다.
test("runs the macOS and Windows suites on their own systems", () => {
  assert.equal(workflow.jobs.portable, undefined);
  for (const os of ["macos", "windows"]) {
    const job = workflow.jobs[`test-${os}`];
    assert.equal(job["runs-on"], `${os}-latest`);
    assert.equal(job.name, `runtime on ${os}-latest`);
    assert.equal(job.if, "needs.changes.outputs.code == 'true'");
  }
  // 두 시스템은 같은 검사를 돈다. 한쪽만 고치면 그 시스템의 검사가 빠진다.
  assert.deepEqual(
    workflow.jobs["test-windows"].steps,
    workflow.jobs["test-macos"].steps
  );
});

// Windows E2E는 두 job으로 나눠(Playwright shard) 동시에 돌고, 판정 job이 두 보고서를 합쳐 결과 수·예상 spec을 판정한다.
test("splits the Windows E2E into two shard jobs and judges their reports together", () => {
  const shards = [1, 2].map((n) => workflow.jobs[`test-e2e-windows-${n}`]);
  const stopCheck = (each) =>
    /--config vitest\.stop\.config\.ts/.test(each.run ?? "");
  shards.forEach((job, i) => {
    const n = i + 1;
    assert.equal(job.name, `e2e on windows-latest (${n}/2)`);
    assert.equal(job["runs-on"], "windows-latest");
    assert.equal(job.if, "needs.changes.outputs.code == 'true'");
    assert.ok(job["timeout-minutes"] > 0);
    const runs = job.steps.map((each) => each.run ?? "");
    assert.ok(
      runs.some((run) => /playwright install chromium/.test(run)),
      "Chromium"
    );
    assert.ok(
      runs.includes(
        `pnpm --filter @babojubot/web exec playwright test --shard=${n}/2`
      ),
      `shard ${n}/2`
    );
    for (const each of job.steps)
      assert.notEqual(each["continue-on-error"], true);
    const uploads = job.steps.filter((each) =>
      each.uses?.startsWith("actions/upload-artifact@")
    );
    // 실패해도 보고서는 넘겨 판정 job이 수를 남긴다. 다시 돌린 시도도 같은 이름으로 찾는다.
    const report = uploads.find(
      (each) => each.with.path === "apps/web/test-results/e2e-report.json"
    );
    assert.equal(report?.if, "${{ !cancelled() }}");
    assert.equal(report.with.name, `e2e-windows-report-${n}`);
    assert.equal(report.with.overwrite, true);
    const traces = uploads.find(
      (each) => each.with.path === "apps/web/test-results/"
    );
    assert.equal(traces?.if, "failure()");
  });
  // 서버 멈춤 시험은 1/2에서만 돈다.
  assert.deepEqual(
    shards.map((job) => job.steps.some(stopCheck)),
    [true, false]
  );
  // 두 job은 shard 번호와 멈춤 시험 말고 같은 단계를 돈다. 한쪽만 고치면 그 shard만 다르게 돈다.
  // 멈춤 시험의 수 확인도 1/2에만 있다.
  const stopOnly = (each) =>
    stopCheck(each) || /check-test-reports\.mjs/.test(each.run ?? "");
  const shape = (job, n) =>
    JSON.stringify(job.steps.filter((each) => !stopOnly(each)))
      .replaceAll(`${n}/2`, "N/2")
      .replaceAll(`-${n}"`, '-N"');
  assert.equal(shape(shards[0], 1), shape(shards[1], 2));

  // 판정 job은 shard가 실패해도 돌아 두 보고서를 합쳐 판정한다. 보고서가 빠지면 실패한다.
  const judge = workflow.jobs["test-e2e-windows"];
  assert.equal(judge.name, "e2e on windows-latest");
  assert.deepEqual(judge.needs, [
    "changes",
    "test-e2e-windows-1",
    "test-e2e-windows-2",
  ]);
  assert.equal(
    judge.if,
    "${{ always() && needs.changes.outputs.code == 'true' }}"
  );
  const downloads = judge.steps.filter((each) =>
    each.uses?.startsWith("actions/download-artifact@")
  );
  assert.deepEqual(
    downloads.map((each) => [each.with.name, each.with.path]),
    [
      ["e2e-windows-report-1", "e2e-reports/1"],
      ["e2e-windows-report-2", "e2e-reports/2"],
    ]
  );
  assert.equal(downloads[1].if, "${{ !cancelled() }}");
  const check = judge.steps.find((each) =>
    /check-e2e-report\.mjs/.test(each.run ?? "")
  );
  assert.equal(
    check?.run,
    "node scripts/check-e2e-report.mjs --os windows e2e-reports/1/e2e-report.json e2e-reports/2/e2e-report.json"
  );
  assert.equal(check.if, "${{ !cancelled() }}");
  for (const each of judge.steps)
    assert.notEqual(each["continue-on-error"], true);
  // Linux E2E도 같은 보고서 판정을 하고, E2E가 실패해도 수를 남긴다.
  const linux = workflow.jobs.check.steps.find((each) =>
    /check-e2e-report\.mjs/.test(each.run ?? "")
  );
  assert.equal(
    linux?.if,
    "${{ !cancelled() && env.RUN == 'true' && matrix.script == 'test:e2e' }}"
  );
  // 시스템별 건너뜀을 판정하도록 각 판정이 보고서를 만든 시스템을 밝힌다.
  assert.equal(
    linux.run,
    "node scripts/check-e2e-report.mjs --os linux apps/web/test-results/e2e-report.json"
  );
});

test("each file-system verification has its own job, runs only for file-boundary changes, and is a direct gate dependency", () => {
  assert.equal(
    workflow.jobs.changes.outputs.files,
    "${{ steps.diff.outputs.files }}"
  );
  for (const id of fileSuites) {
    const job = workflow.jobs[id];
    assert.ok(job, `Missing independent job ${id}`);
    assert.equal(job.strategy?.matrix, undefined);
    assert.equal(job.if, "needs.changes.outputs.files == 'true'");
    assert.ok(job["timeout-minutes"] > 0, `${id} needs a time limit`);
    assert.ok(gate.needs.includes(id), `Gate must directly need ${id}`);
    assert.ok(
      Object.values(step.env).some((binding) =>
        binding.includes(`needs.${id}.result`)
      ),
      `Gate must receive ${id}'s own result`
    );
    // 준비가 실패해도 남은 볼륨 검사와 결과 집계·정리는 돈다. 실패를 성공으로 바꾸는 continue-on-error는 쓰지 않는다.
    for (const each of job.steps)
      assert.notEqual(each["continue-on-error"], true);
    assert.ok(
      job.steps.some((each) =>
        /file-boundary-report\.mjs/.test(each.run ?? "")
      ),
      `${id} must aggregate its volumes`
    );
  }
});

// 일반 PR의 macOS·Windows job은 기본 볼륨의 파일 경계 검사를 돌다가, 전체 검증이 도는 변경에서는 같은 검사를 거듭하지 않는다.
test("runs the default-volume file checks in the macOS and Windows jobs unless the full verification runs", () => {
  for (const os of ["macos", "windows"]) {
    const files = workflow.jobs[`test-${os}`].steps.find((each) =>
      /vitest\.files\.config\.ts/.test(each.run ?? "")
    );
    assert.equal(files.if, "needs.changes.outputs.files != 'true'");
  }
});

test("lets an agent run the whole verification on a branch or an exact commit by hand and cancels superseded PR runs", () => {
  assert.ok("workflow_dispatch" in workflow.on);
  assert.equal(workflow.on.workflow_dispatch.inputs.sha.required, false);
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}"
  );
  // 두 수동 실행이 서로 다른 SHA면 같은 대기열을 나누지 않는다.
  assert.match(workflow.concurrency.group, /inputs\.sha/);
  // 모든 job이 지정한 SHA를 받는다(없으면 이벤트의 기본 commit).
  for (const [name, job] of Object.entries(workflow.jobs))
    for (const step of job.steps ?? [])
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(step.with?.ref, "${{ inputs.sha }}", `${name} checkout`);
  // 지정한 값이 짧은 SHA나 브랜치 이름이면 다른 commit을 검증한 것으로 보이지 않게 실패한다. 나머지 job은 changes 뒤에 돈다.
  const verify = workflow.jobs.changes.steps.find((step) =>
    /git rev-parse HEAD/.test(step.run ?? "")
  );
  assert.equal(verify?.if, "inputs.sha != ''");
  for (const [name, job] of Object.entries(workflow.jobs))
    if (name !== "changes")
      assert.ok(
        [job.needs].flat().includes("changes"),
        `${name} needs changes`
      );
});

test("accepts code only when every test job succeeded", () => {
  assert.equal(runGate().status, 0);
});

test("accepts Markdown-only changes when every test job was skipped", () => {
  assert.equal(runGate({ code: "false" }).status, 0);
});

test("accepts a file-boundary change only when every file-system verification succeeded", () => {
  assert.equal(runGate({ files: "true" }).status, 0);
});

for (const suite of fileSuites) {
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    test(`rejects a file-boundary change with ${suite}=${result || "missing"}`, () => {
      assertRejected({ files: "true", fileResults: { [suite]: result } });
    });
  }
  for (const result of ["success", "failure", "cancelled", ""]) {
    test(`rejects ${suite}=${result || "missing"} when the file boundary did not change`, () => {
      assertRejected({ fileResults: { [suite]: result } });
    });
  }
}

for (const files of ["", "unknown"]) {
  test(`rejects files=${files || "missing"}`, () => assertRejected({ files }));
}

test("rejects a file-boundary change reported for a Markdown-only change", () => {
  assertRejected({ code: "false", files: "true" });
});

for (const suite of suites) {
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    test(`rejects ${suite}=${result || "missing"} despite a successful matrix summary`, () => {
      assertRejected({ results: { [suite]: result } });
    });
  }
  for (const result of ["success", "failure", "cancelled", ""]) {
    test(`rejects Markdown-only ${suite}=${result || "missing"} despite a skipped matrix summary`, () => {
      assertRejected({ code: "false", results: { [suite]: result } });
    });
  }
}

for (const changes of ["failure", "cancelled", "skipped", ""]) {
  test(`rejects changes=${changes || "missing"}`, () => {
    assertRejected({ changes });
    assertRejected({ changes, code: "false" });
  });
}

for (const code of ["", "unknown"]) {
  test(`rejects code=${code || "missing"}`, () => assertRejected({ code }));
}

test("rejects a partial rerun where one test recovered but another still failed", () => {
  assertRejected({ results: { unit: "success", runtime: "failure" } });
});

// Windows development requires Node/Git, not a shell installation. Reproduce
// that boundary on any OS by removing every executable from the child PATH.
test("runs the real workflow gate without any executable on PATH", (context) => {
  const emptyPath = mkdtempSync(path.join(tmpdir(), "ci-gate-no-shell-"));
  context.after(() => removeFolder(emptyPath));
  assert.equal(runGate({ executablePath: emptyPath }).status, 0);
  assert.equal(runGate({ code: "false", executablePath: emptyPath }).status, 0);
  assertRejected({
    executablePath: emptyPath,
    results: { opencode: "cancelled" },
  });
});

// 실패 이유는 job 이름으로 job 기록을 찾는다. 판정 스크립트의 이름이 workflow의 name과 같아야 한다.
test("names each failed job by its workflow name in the log and the job summary", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-gate-summary-"));
  context.after(() => removeFolder(dir));
  for (const suite of suites) {
    const summary = path.join(dir, `${suite}.md`);
    const result = runGate({ results: { [suite]: "cancelled" }, summary });
    assert.notEqual(result.status, 0);
    const name = workflow.jobs[`test-${suite}`].name;
    assert.ok(
      result.stderr.includes(`${name} did not finish as success: 'cancelled'`),
      result.stderr
    );
    // 토큰이 없어 조회하지 못한 job은 알 수 없음이다. 판정은 그대로 실패다.
    assert.ok(
      readFileSync(summary, "utf8").includes(
        `| ${name} | cancelled | success | 알 수 없음 |`
      ),
      suite
    );
  }
  for (const suite of fileSuites) {
    const result = runGate({
      files: "true",
      fileResults: { [suite]: "failure" },
    });
    assert.ok(
      result.stderr.includes(
        `${workflow.jobs[suite].name} did not finish as success`
      ),
      result.stderr
    );
  }
});

test("lists every failed job, not only the first", () => {
  const result = runGate({ results: { unit: "failure", macos: "cancelled" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /\| tests \/ unit \| failure \|/);
  assert.match(result.stdout, /\| runtime on macos-latest \| cancelled \|/);
});

test("writes 'no failures' to the job summary when the gate passes", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-gate-summary-"));
  context.after(() => removeFolder(dir));
  const summary = path.join(dir, "summary.md");
  assert.equal(runGate({ summary }).status, 0);
  assert.match(readFileSync(summary, "utf8"), /실패 없음/);
});

test("lets the gate read job records and notes but not rerun anything", () => {
  assert.deepEqual(gate.permissions, {
    contents: "read",
    actions: "read",
    checks: "read",
  });
});

const runSteps = (job) => job.steps.filter((each) => each.run);
// 시험·내려받기 단계마다 시한을 두고, 한 job 안의 단계 시한 합은 job 시한보다 5분 이상 짧다. 그래서 어떤 단계가 멈춰도
// job 시한보다 먼저 그 단계 시한에 걸려 그 단계만 실패하고, 뒤의 보고 단계(`!cancelled()`·`failure()`)가 돈다.
// 단계 시한에 걸린 단계는 실패로 끝나고 두 보고 단계가 모두 돈다(#218, GitHub Actions run 44133006534에서 확인).
test("gives test and install steps time limits that fit inside the job's with room for reports", () => {
  /** @type {[string, RegExp][]} */
  const timed = [
    ["check", /^pnpm run test:e2e$|playwright install/],
    ["test-unit", /run test/],
    ["test-runtime", /run test|apt-get/],
    ["test-db", /run test|check-test-exit-code|run-node-tests/],
    ["test-server", /vitest run/],
    ["test-opencode", /vitest run|curl /],
    ["test-macos", /runtime test|vitest|run-node-tests\.mjs boot-check/],
    ["test-windows", /runtime test|vitest|run-node-tests\.mjs boot-check/],
    ["test-e2e-windows-1", /vitest|playwright/],
    ["test-e2e-windows-2", /playwright/],
  ];
  for (const [id, pattern] of timed) {
    const job = workflow.jobs[id];
    const steps = runSteps(job).filter((each) => pattern.test(each.run));
    assert.ok(steps.length > 0, id);
    for (const each of steps)
      assert.ok(each["timeout-minutes"] > 0, `${id}: ${each.run}`);
    const total = job.steps.reduce(
      (sum, each) => sum + (each["timeout-minutes"] ?? 0),
      0
    );
    assert.ok(total <= job["timeout-minutes"] - 5, `${id}: ${total} minutes`);
  }
});

// apt는 시간 초과·연결 실패 같은 일시적인 받기 오류에만 Acquire::Retries를 쓴다. 종료 코드 100만 보고 다시 돌리지 않는다.
test("lets apt retry transient download failures before every apt install", () => {
  const config = /Acquire::Retries "2";.*\/etc\/apt\/apt\.conf\.d\/zzz-/;
  const linuxE2e = runSteps(workflow.jobs.check);
  const install = linuxE2e.findIndex((each) => /--with-deps/.test(each.run));
  const retries = linuxE2e.findIndex((each) => config.test(each.run));
  assert.ok(retries >= 0 && retries < install);
  assert.equal(linuxE2e[retries].if, linuxE2e[install].if);
  const disk = runSteps(workflow.jobs["test-runtime"]).find((each) =>
    /apt-get install/.test(each.run)
  );
  assert.ok(
    disk.run.search(config) >= 0 &&
      disk.run.search(config) < disk.run.indexOf("apt-get update")
  );
  // 이 저장소에서 apt를 쓰는 곳은 위 둘뿐이다. 새로 생기면 같은 설정을 먼저 둔다.
  const aptUsers = Object.entries(workflow.jobs).flatMap(([id, job]) =>
    (job.steps ?? [])
      .filter((each) => /apt-get|--with-deps/.test(each.run ?? ""))
      .map(() => id)
  );
  assert.deepEqual(aptUsers, ["check", "test-runtime"]);
});

// #218이 시한을 요구한 것은 시험 실행이다. check matrix의 문서 검사·타입·lint·빌드는 예전처럼 job 시한만 받고,
// E2E 실행만 따로 단계 시한을 받는다(PR #221 외부 리뷰 SPEC-1).
test("limits only the E2E run in the check matrix, not check, typecheck, lint or build", () => {
  const runs = runSteps(workflow.jobs.check).filter((each) =>
    /^pnpm run /.test(each.run)
  );
  assert.deepEqual(
    runs.map((each) => [each.if, each.run, each["timeout-minutes"]]),
    [
      [
        "env.RUN == 'true' && matrix.script != 'test:e2e'",
        "pnpm run ${{ matrix.script }}",
        undefined,
      ],
      [
        "env.RUN == 'true' && matrix.script == 'test:e2e'",
        "pnpm run test:e2e",
        12,
      ],
    ]
  );
});

// 단계 시한은 느리지만 진행 중인 설치를 끊지 않을 만큼 넉넉해야 한다. Linux의 Chromium·시스템 의존성 설치는 최근 35회 중
// 최대 511초였고, #221 CI(run 44222170536)에서는 Ubuntu 미러가 느려 3분 시한에 끊겼다.
test("gives the Linux Chromium and system dependency install room for a slow package mirror", () => {
  const install = runSteps(workflow.jobs.check).find((each) =>
    /--with-deps/.test(each.run)
  );
  assert.ok(
    install["timeout-minutes"] >= 12,
    `${install["timeout-minutes"]} minutes`
  );
});

// Vitest·node:test는 시험 파일의 시험이 모두 건너뛰어져도 0으로 끝난다. 그래서 시험 묶음마다 보고서를 남기고 job의 마지막 단계가
// 실행·통과 수를 판정한다(scripts/check-test-reports.mjs). 어느 묶음을 돌리는지는 명령 글자로 찾지 않는다(래퍼 스크립트로 옮기면
// 놓친다, #286 항목 20): CI 전체가 보고서를 필수로 하고(BABOJUBOT_REQUIRE_TEST_REPORTS), 보고 폴더를 준 job만 묶음을 돌릴 수 있으며,
// 판정은 보고서를 묶음 정의(scripts/test-suites.ts)와 대조해 빠지거나 모르는 보고서를 실패로 본다. 여기서는 그 배선을 본다.
const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = (folder) =>
  JSON.parse(readFileSync(path.join(root, folder, "package.json"), "utf8"));
const reportFolderValue = "${{ github.workspace }}/test-reports";

/**
 * Vitest 설정 파일이 실제로 남기는 보고서 이름. 설정을 보고 폴더를 준 채 따로 띄운 Node로 가져와 JSON 보고기의 파일 이름을 읽는다.
 * 글자를 찾지 않으므로 주석에 남은 이름은 세지 않는다. JSON 보고기가 없으면 undefined.
 */
function reportOf(config) {
  // 보고 폴더는 경로만 쓴다: 설정을 읽을 때 보고기가 가리킬 파일 이름을 정할 뿐 폴더를 만들지 않는다.
  const folder = path.join(tmpdir(), "ci-gate-report-folder-never-written");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { default: config } = await import(process.argv[1]); console.log(JSON.stringify(config.test?.reporters ?? []));",
      pathToFileURL(path.resolve(root, config)).href,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        BABOJUBOT_TEST_REPORTS: folder,
        BABOJUBOT_REQUIRE_TEST_REPORTS: "1",
      },
    }
  );
  assert.equal(result.status, 0, `${config}: ${result.stderr}`);
  const json = JSON.parse(result.stdout).find(
    (reporter) => Array.isArray(reporter) && reporter[0] === "json"
  );
  return json ? path.basename(json[1].outputFile, ".json") : undefined;
}

/** `${{ <조건> && format('{0}/test-reports', github.workspace) || '' }}`의 조건. 그런 모양이 아니면 undefined. */
const conditionalFolder = (value) =>
  /^\$\{\{ (.+) && format\('\{0\}\/test-reports', github\.workspace\) \|\| '' \}\}$/.exec(
    value ?? ""
  )?.[1];

/**
 * 보고서 배선의 문제마다 한 줄. 판정하는 job(counted)과 그 job이 기대하는 묶음(expected: 늘, 전체 검증이 돌지 않을 때만)도 돌려준다.
 * - workflow env가 보고서를 필수로 한다. 보고 폴더 없이 도는 묶음은 시작하지 않고 실패한다(scripts/test-suites.ts reportFolder).
 * - 보고 폴더는 판정하는 job의 env에만 둔다. workflow·단계 env에 두면 판정하지 않는 폴더에 보고서가 남거나 다른 실행의 보고기를
 *   가로챈다(run 44670627223).
 * - 보고 폴더를 준 job에는 시험이 실패해도 도는 판정 단계가 하나 있고, 폴더가 조건부면 판정도 같은 조건에서 돈다.
 * - 판정 단계가 기대하는 묶음은 묶음 정의에 있다.
 */
function wiringProblems(flow) {
  const problems = [];
  if (flow.env?.BABOJUBOT_REQUIRE_TEST_REPORTS !== "1")
    problems.push(
      'the workflow env must set BABOJUBOT_REQUIRE_TEST_REPORTS to "1" so a suite run outside a judged job fails'
    );
  if (flow.env?.BABOJUBOT_TEST_REPORTS !== undefined)
    problems.push("the workflow env gives every job a report folder");
  const counted = [];
  /** @type {Map<string, { always: string[], withoutFiles: string[] }>} */
  const expected = new Map();
  const names = new Set(testSuites.map((suite) => suite.name));
  for (const [id, job] of Object.entries(flow.jobs)) {
    const steps = job.steps ?? [];
    if (steps.some((each) => each.env?.BABOJUBOT_TEST_REPORTS !== undefined))
      problems.push(
        `${id}: a step's env sets BABOJUBOT_TEST_REPORTS; only a job that checks the counts gives its suites a folder`
      );
    const checks = steps.filter((each) =>
      /check-test-reports\.mjs/.test(each.run ?? "")
    );
    const folder = job.env?.BABOJUBOT_TEST_REPORTS;
    if (folder === undefined) {
      if (checks.length > 0)
        problems.push(
          `${id} checks counts but gives its suites no report folder`
        );
      continue;
    }
    if (checks.length !== 1) {
      problems.push(
        `${id} gives a report folder but has ${checks.length} count checks; it needs exactly one`
      );
      continue;
    }
    const [check] = checks;
    counted.push(id);
    const condition = conditionalFolder(folder);
    if (folder !== reportFolderValue && condition === undefined)
      problems.push(`${id}: unexpected report folder ${folder}`);
    if (!/!cancelled\(\)/.test(check.if ?? ""))
      problems.push(`${id}: count even after a failed test`);
    if (condition !== undefined && !(check.if ?? "").includes(condition))
      problems.push(
        `${id}: the report folder is given when ${condition}, but the count check does not run on that condition`
      );
    const [, listed, conditional] =
      /--expect ([\w,-]+)(?:\$\{\{ needs\.changes\.outputs\.files != 'true' && ',([\w-]+)' \|\| '' \}\})?$/.exec(
        check.run
      ) ?? [];
    if (!listed) {
      problems.push(`${id}: ${check.run}`);
      continue;
    }
    const entry = {
      always: listed.split(","),
      withoutFiles: conditional ? [conditional] : [],
    };
    for (const name of [...entry.always, ...entry.withoutFiles])
      if (!names.has(name))
        problems.push(
          `${id}: expects ${name}, which scripts/test-suites.ts does not define`
        );
    expected.set(id, entry);
  }
  return { problems, counted: counted.sort(), expected };
}

test("each job that runs test suites gives them a report folder and checks their run and pass counts", () => {
  const { problems, counted } = wiringProblems(workflow);
  assert.deepEqual(problems, []);
  assert.deepEqual(counted, [
    "check",
    "test-db",
    "test-e2e-windows-1",
    "test-macos",
    "test-opencode",
    "test-runtime",
    "test-server",
    "test-unit",
    "test-windows",
  ]);
});

// 묶음 정의에 있어도 어느 job도 기대하지 않으면 그 묶음의 파일은 CI에서 판정받지 않는다. Linux에서 늘 도는 job이 모든 Vitest·node:test
// 묶음을 기대하고(같은 파일을 macOS·Windows만 돌리는 묶음은 Linux에서 다른 묶음이 같은 파일을 돈다), E2E는 자기 판정 단계가 있다.
test("every suite in the suite definition is judged in CI", () => {
  const { expected } = wiringProblems(workflow);
  const judged = new Set(
    [...expected.values()].flatMap((entry) => [
      ...entry.always,
      ...entry.withoutFiles,
    ])
  );
  assert.deepEqual(
    testSuites
      .filter((suite) => suite.runner !== "playwright")
      .map((suite) => suite.name)
      .filter((name) => !judged.has(name)),
    []
  );
  const e2eChecks = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((each) =>
      /check-e2e-report\.mjs/.test(each.run ?? "")
    )
  );
  assert.ok(e2eChecks.length > 0, "no E2E report check");
});

// 보고서 이름을 설정 글자에서 찾으면 주석에만 남은 `testReport("web")`도 보고기로 센다(#286 항목 20). 설정이 실제로 만드는 보고기를 본다.
test("does not take a report named only in a comment of a Vitest config", (context) => {
  const folder = mkdtempSync(path.join(tmpdir(), "ci-gate-config-"));
  context.after(() => removeFolder(folder));
  const config = path.join(folder, "vitest.config.mjs");
  writeFileSync(
    config,
    '// reporters: [...configDefaults.reporters, ...testReport("web")]\nexport default { test: { reporters: ["default"] } };\n'
  );
  assert.equal(reportOf(config), undefined);
});

// 시험 실행을 래퍼 스크립트로 옮기면 명령 모양으로 묶음을 찾는 판정은 그 job이 묶음을 돌리지 않는다고 본다(#286 항목 20). 판정을
// 명령 글자에 기대지 않고, CI 전체에 보고서가 필수라고 알려 보고 폴더 없이 도는 묶음이 실행에서 실패하게 한다.
test("refuses a workflow that does not require every suite run in CI to leave a report", () => {
  const flow = structuredClone(workflow);
  delete flow.env?.BABOJUBOT_REQUIRE_TEST_REPORTS;
  assert.ok(
    wiringProblems(flow).problems.some((problem) =>
      problem.startsWith(
        "the workflow env must set BABOJUBOT_REQUIRE_TEST_REPORTS"
      )
    ),
    wiringProblems(flow).problems.join("\n")
  );
});

// run 44670627223에서 고친 보고 폴더 누출은 workflow·job env만 보았다. 단계 env에 같은 변수를 두면 그 단계의 묶음이 판정하지 않는
// 폴더에 보고서를 남기거나 다른 실행의 보고기를 가로챈다(#286 항목 20).
test("refuses a report folder given in a step's env", () => {
  const flow = structuredClone(workflow);
  const run = flow.jobs["files-linux"].steps.find((each) =>
    /file-boundary-run/.test(each.run ?? "")
  );
  run.env = {
    ...run.env,
    BABOJUBOT_TEST_REPORTS: "${{ github.workspace }}/test-reports",
  };
  assert.ok(
    wiringProblems(flow).problems.includes(
      "files-linux: a step's env sets BABOJUBOT_TEST_REPORTS; only a job that checks the counts gives its suites a folder"
    ),
    wiringProblems(flow).problems.join("\n")
  );
});

test("runs every node:test suite through the counting runner and gives every Vitest config its suite's report", () => {
  const commands = [
    ...Object.values(packageJson(".").scripts),
    ...Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).map((each) => each.run ?? "")
    ),
  ];
  for (const command of commands)
    assert.doesNotMatch(
      command,
      /node --test/,
      `use scripts/run-node-tests.mjs: ${command}`
    );
  // 저장소의 Vitest 설정은 모두 묶음 정의의 설정이고, 그 묶음의 보고서를 남긴다(설정이 없으면 Vitest 기본값으로 돌아 보고서가 없다).
  const configs = globSync(
    `{apps,packages}/*/vitest{,.*}.config.${codeFormats}`,
    { cwd: root }
  )
    .map((config) => config.replaceAll("\\", "/"))
    .sort();
  const vitestSuites = testSuites.filter((suite) => suite.runner === "vitest");
  assert.deepEqual(
    configs,
    vitestSuites.map((suite) => `${suite.folder}/${suite.config}`).sort()
  );
  for (const suite of vitestSuites)
    assert.equal(
      reportOf(`${suite.folder}/${suite.config}`),
      suite.name,
      `${suite.folder}/${suite.config}`
    );
});

/** 저장소 `base`의 스크립트가 (자기가 가져오는 저장소 파일을 거쳐) 가져오는 저장소 밖 패키지 이름. `node:` 기본 모듈은 뺀다. */
function packagesImportedBy(base, script, seen = new Set()) {
  if (seen.has(script)) return [];
  seen.add(script);
  const text = readFileSync(path.join(base, script), "utf8");
  const specifiers = importedSpecifiers(script, text);
  return specifiers.flatMap((specifier) => {
    if (specifier.startsWith("node:")) return [];
    if (!/^\.{1,2}\//.test(specifier)) return [specifier];
    // 상대 경로는 ESM처럼 가져오는 파일에 대한 URL로 푼다. 없는 파일은 읽다가 실패한다.
    const url = new URL(specifier, pathToFileURL(path.join(base, script)));
    const file = path
      .relative(base, fileURLToPath(url))
      .split(path.sep)
      .join("/");
    return packagesImportedBy(base, file, seen);
  });
}

/**
 * 저장소 코드를 돌릴 수 있는 실행기. Node 자신(`node`, 파일을 돌림), Node·corepack이 주거나 pnpm/action-setup이 까는 패키지 관리자
 * (`npm`·`npx`·`pnpm`·`pnpx`·`yarn`·`corepack`, package.json 스크립트와 패키지 실행 파일을 돌림), 저장소 코드를 바로 돌리는 TypeScript
 * 실행기와 다른 JS 실행 환경(`tsx`·`ts-node`·`bun`·`bunx`·`deno`).
 */
const codeRunners = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "corepack",
  "tsx",
  "ts-node",
  "bun",
  "bunx",
  "deno",
]);
const codeFile = new RegExp(`\\.(?:${codeFormatNames.join("|")})$`);

/**
 * 단계 명령 `run`이 부르는 실행기마다: 읽어 낸 저장소 스크립트(`{ script }`), 또는 무엇을 돌리는지 읽지 못한 그 줄(`{ unread }`).
 * 셸을 해석하지 않는다: 줄을 셸 구분 기호(공백·`|`·`;`·`&`·괄호·`$(`·백틱)로 낱말로 나눠 실행기 이름인 낱말을 찾는다. `node` 뒤
 * 옵션(`-`로 시작)을 건너뛴 첫 낱말이 저장소의 코드 파일(`./` 접두 허용)일 때만 읽은 것으로 본다. 다른 실행기는 대상을 읽지 않는다
 * (`pnpm install`은 설치 자체).
 */
function runnersIn(run, base) {
  /** @type {({ script: string } | { unread: string })[]} */
  const found = [];
  for (const line of run.split("\n")) {
    const words = line
      .split(/\$\(|[\s|;&()`]+/)
      .map((word) => word.replace(/^["']+|["']+$/g, ""))
      .filter(Boolean);
    let unread = false;
    words.forEach((word, at) => {
      if (!codeRunners.has(word)) return;
      if (word === "pnpm" && words[at + 1] === "install") return;
      if (word === "node") {
        let next = at + 1;
        while (words[next]?.startsWith("-")) next += 1;
        const file = words[next]?.replace(/^\.\//, "");
        if (file && codeFile.test(file) && existsSync(path.join(base, file))) {
          found.push({ script: file });
          return;
        }
      }
      unread = true;
    });
    // 한 줄에서 읽지 못한 실행기가 여럿이어도 그 줄을 한 번 알린다.
    if (unread) found.push({ unread: line.trim() });
  }
  return found;
}

/**
 * workflow에서 설치 전에 저장소 `base`의 패키지를 가져오는 스크립트를 돌리는 단계, 또는 설치 전에 무엇을 돌리는지 읽지 못한 실행기를
 * 부르는 단계. 읽지 못한 것을 "패키지 없음"으로 접지 않는다.
 */
function installProblems(workflow, base) {
  const problems = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    steps.forEach((each, index) => {
      const installed = steps
        .slice(0, index)
        .some((before) => /^pnpm install\b/.test(before.run ?? ""));
      if (installed) return;
      // 한 단계가 부르는 실행기를 모두 본다.
      for (const runner of runnersIn(each.run ?? "", base)) {
        if ("unread" in runner) {
          problems.push(
            `${id}: cannot tell what "${runner.unread}" runs, and no pnpm install comes before it`
          );
          continue;
        }
        const packages = [...new Set(packagesImportedBy(base, runner.script))];
        if (packages.length > 0)
          problems.push(
            `${id}: ${runner.script} imports ${packages.join(", ")} without pnpm install before it`
          );
      }
    });
  }
  return problems;
}

// 의존성을 설치하지 않는 job(판정만 하는 가벼운 job)이 돌리는 저장소 스크립트는 저장소 밖 패키지를 가져오지 않아야 한다. 가져오면 그
// job에서만 패키지를 찾지 못하고 실패한다(#292 외부 리뷰 1회차 CI run 45297151227: check-e2e-report.mjs → exit-after-output.ts →
// @babojubot/contracts). 스크립트의 가져오기를 구문 트리로 따라가, 패키지가 필요하면 그 단계 앞에 설치가 있어야 한다.
test("a job installs the packages before it runs a repository script that imports them", () => {
  assert.deepEqual(installProblems(workflow, root), []);
});

// 한 단계가 여러 스크립트를 돌리면 모두 본다. 따라갈 수 없는 불러오기(글자가 아닌 import() 등)는 "패키지 없음"으로 접지 않고 멈춘다
// (#291 parent 점검의 같은 모양 수색).
test("the install guard reads every script a step runs and fails on an import it cannot follow", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "babojubot-install-guard-"));
  t.after(() => removeFolder(base));
  mkdirSync(path.join(base, "scripts"));
  for (const [file, text] of Object.entries({
    "first.mjs": 'import "node:path";\n',
    "second.mjs": 'import "yaml";\n',
    "computed.mjs": 'const name = "yaml";\nawait import(name);\n',
  }))
    writeFileSync(path.join(base, "scripts", file), text);
  const job = (run) => ({ jobs: { judge: { steps: [{ run }] } } });
  assert.deepEqual(
    installProblems(
      job("node scripts/first.mjs\nnode scripts/second.mjs"),
      base
    ),
    ["judge: scripts/second.mjs imports yaml without pnpm install before it"]
  );
  assert.throws(
    () => installProblems(job("node scripts/computed.mjs"), base),
    /scripts\/computed\.mjs loads a module through import\(\) with a name that is not a string literal/
  );
});

// 설치가 앞서지 않은 단계가 저장소 코드를 돌릴 수 있는 실행기를 부르면, 그 대상을 읽어 내거나 판정할 수 없다고 보고한다. 읽지 못한
// 실행 모양을 "패키지 없음"으로 접지 않는다(#292 parent 점검).
test("the install guard reads node's script past options and ./, and reports a runner whose target it cannot read", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "babojubot-install-guard-"));
  t.after(() => removeFolder(base));
  mkdirSync(path.join(base, "scripts"));
  writeFileSync(
    path.join(base, "scripts", "first.mjs"),
    'import "node:path";\n'
  );
  writeFileSync(path.join(base, "scripts", "second.mjs"), 'import "yaml";\n');
  const job = (run) => ({ jobs: { judge: { steps: [{ run }] } } });
  const imported = [
    "judge: scripts/second.mjs imports yaml without pnpm install before it",
  ];
  assert.deepEqual(
    installProblems(job("node ./scripts/second.mjs"), base),
    imported
  );
  assert.deepEqual(
    installProblems(job("node --test-reporter=tap scripts/second.mjs"), base),
    imported
  );
  for (const run of [
    "pnpm run check",
    "pnpm exec vitest run",
    "npx tsx scripts/first.mjs",
    "tsx scripts/first.mjs",
    'node -e "process.exit(0)"',
  ])
    assert.deepEqual(
      installProblems(job(run), base),
      [
        `judge: cannot tell what "${run}" runs, and no pnpm install comes before it`,
      ],
      run
    );
  // 저장소 코드를 돌리지 않는 명령과, 설치 뒤의 실행기는 보지 않는다.
  assert.deepEqual(
    installProblems(job("echo done\nnode scripts/first.mjs"), base),
    []
  );
  assert.deepEqual(
    installProblems(
      {
        jobs: {
          judge: {
            steps: [
              { run: "pnpm install --frozen-lockfile" },
              { run: "pnpm run check" },
            ],
          },
        },
      },
      base
    ),
    []
  );
});

// node 옵션 중 값을 받는 것의 값을 진입점으로 고르지 않는다. 선적재 모듈(--import·--require·-r·--loader)과 진입점을 모두 따라가고,
// 글로 넣는 코드(-e·-p)와 모르는 옵션은 판정할 수 없다(#292 외부 리뷰 2회차 SPEC-2).
test("the install guard follows node's preloaded modules and its entry past options that take a value", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "babojubot-install-guard-"));
  t.after(() => removeFolder(base));
  mkdirSync(path.join(base, "scripts"));
  writeFileSync(
    path.join(base, "scripts", "first.mjs"),
    'import "node:path";\n'
  );
  writeFileSync(path.join(base, "scripts", "second.mjs"), 'import "yaml";\n');
  const job = (run) => ({ jobs: { judge: { steps: [{ run }] } } });
  const imported = [
    "judge: scripts/second.mjs imports yaml without pnpm install before it",
  ];
  for (const run of [
    "node --import ./scripts/first.mjs scripts/second.mjs",
    "node --require ./scripts/first.mjs scripts/second.mjs",
    "node -r ./scripts/second.mjs scripts/first.mjs",
    "node --import=./scripts/second.mjs scripts/first.mjs",
    "node --conditions development scripts/second.mjs",
  ])
    assert.deepEqual(installProblems(job(run), base), imported, run);
  assert.deepEqual(
    installProblems(job("node --import tsx scripts/first.mjs"), base),
    [
      "judge: node --import tsx loads the package tsx without pnpm install before it",
    ]
  );
  for (const run of [
    "node --frobnicate scripts/first.mjs",
    "node --eval=1",
    'node -p "1"',
  ])
    assert.deepEqual(
      installProblems(job(run), base),
      [
        `judge: cannot tell what "${run}" runs, and no pnpm install comes before it`,
      ],
      run
    );
});
