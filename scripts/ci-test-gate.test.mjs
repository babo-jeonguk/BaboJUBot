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
const suites = ["unit", "runtime", "db", "server", "opencode"];
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
  changes = "success",
  results = {},
  executablePath = process.env.PATH,
} = {}) {
  const needs = {
    changes: { result: changes, outputs: { code } },
    "test-packages": { result: code === "false" ? "skipped" : "success" },
    ...Object.fromEntries(
      suites.map((suite) => [
        `test-${suite}`,
        {
          result: results[suite] ?? (code === "false" ? "skipped" : "success"),
        },
      ])
    ),
  };
  const env = { PATH: executablePath };
  // Windows child processes may need the system root to load runtime DLLs.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [name, expression] of Object.entries(step.env)) {
    const match = expression.match(
      /^\$\{\{\s*needs\.([\w-]+)\.(result|outputs\.code)\s*\}\}$/
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

test("accepts code only when all five tests succeeded", () => {
  assert.equal(runGate().status, 0);
});

test("accepts Markdown-only changes when all five tests were skipped", () => {
  assert.equal(runGate({ code: "false" }).status, 0);
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
