import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { removeFolder } from "@babojubot/runtime/remove-folder";

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

// Windows E2E는 두 job으로 나눠(Playwright shard) 동시에 돌고, 판정 job이 두 보고서를 합쳐 결과 수·서버 수명 시험을 판정한다.
test("splits the Windows E2E into two shard jobs and judges their reports together", () => {
  const shards = [1, 2].map((n) => workflow.jobs[`test-e2e-windows-${n}`]);
  const stopCheck = (each) => /test\/main\.test\.ts/.test(each.run ?? "");
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
  const shape = (job, n) =>
    JSON.stringify(job.steps.filter((each) => !stopCheck(each)))
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
  const timed = [
    ["check", /^pnpm run test:e2e$|playwright install/],
    ["test-unit", /run test/],
    ["test-runtime", /run test|apt-get/],
    ["test-db", /run test|check-test-exit-code|boot-check/],
    ["test-server", /vitest run/],
    ["test-opencode", /vitest run|curl /],
    ["test-macos", /runtime test|vitest|boot-check/],
    ["test-windows", /runtime test|vitest|boot-check/],
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
