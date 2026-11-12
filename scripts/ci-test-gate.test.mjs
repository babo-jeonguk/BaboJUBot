import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../.github/workflows/scaffold.yml", import.meta.url),
    "utf8"
  )
);
// macOS·Windows도 필수다. 실제 프로그램 연결·파일 경계·부팅 검사가 시스템마다 달라 그 시스템에서만 드러나는 결함을 막는다.
const suites = [
  "unit",
  "runtime",
  "db",
  "server",
  "opencode",
  "macos",
  "windows",
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
  // Windows child processes may need the system root to load runtime DLLs.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [name, expression] of Object.entries(step.env)) {
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

test("lets an agent run the whole verification on a branch by hand and cancels superseded PR runs", () => {
  assert.ok("workflow_dispatch" in workflow.on);
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}"
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
  context.after(() => rmSync(emptyPath, { recursive: true, force: true }));
  assert.equal(runGate({ executablePath: emptyPath }).status, 0);
  assert.equal(runGate({ code: "false", executablePath: emptyPath }).status, 0);
  assertRejected({
    executablePath: emptyPath,
    results: { opencode: "cancelled" },
  });
});
