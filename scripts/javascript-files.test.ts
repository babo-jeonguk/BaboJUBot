// 새 JS 파일 금지(#270 PR 3b-1). 스크립트·시험·도구는 TypeScript로 쓴다. 바뀐 파일 목록(merge-base와의 `git diff`, 이름 바꾸기
// 포함)에서 새로 더해진 JS를 찾는다. JS를 TypeScript로 옮기기(이름 바꾸기)와 기존 JS 고치기·옮기기·지우기는 받는다. 예외 목록은 없다.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { removeFolder } from "@babojubot/process/remove-folder";
import { field } from "../.agents/scripts/json-field.ts";
import { addedJavaScript, isJavaScript } from "./javascript-files.ts";

const script = fileURLToPath(new URL("./javascript-files.ts", import.meta.url));
const workflow = fileURLToPath(
  new URL("../.github/workflows/scaffold.yml", import.meta.url)
);

/** `git diff -z --name-status --find-renames`의 출력 모양: 상태와 경로(이름 바꾸기·복사는 원래 경로와 새 경로)를 NUL로 잇는다. */
const diff = (...entries: string[][]) =>
  entries.map((fields) => `${fields.join("\0")}\0`).join("");

/** 명령에 바뀐 파일 목록을 표준 입력으로 준다. */
const check = (input: string) =>
  spawnSync(process.execPath, [script], {
    input,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });

test("JavaScript is every format TypeScript reads as JavaScript", () => {
  assert.deepEqual(
    [
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
      "a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "a.d.ts",
      "a.json",
      "a.md",
    ].filter(isJavaScript),
    ["a.js", "a.jsx", "a.mjs", "a.cjs"]
  );
});

test("a JavaScript file that is added, copied or renamed from another format is new JavaScript", () => {
  assert.deepEqual(
    addedJavaScript(
      diff(
        ["A", "scripts/new.mjs"],
        ["C75", "scripts/old.mjs", "scripts/copy.mjs"],
        ["R90", "scripts/typed.ts", "scripts/back.mjs"],
        ["A", "apps/web/e2e/support/server.cjs"],
        ["A", "scripts/new.ts"]
      )
    ),
    [
      "scripts/new.mjs",
      "scripts/copy.mjs",
      "scripts/back.mjs",
      "apps/web/e2e/support/server.cjs",
    ]
  );
});

test("moving JavaScript to TypeScript and editing, moving or deleting existing JavaScript add none", () => {
  assert.deepEqual(
    addedJavaScript(
      diff(
        [
          "R080",
          ".agents/scripts/run-worker.mjs",
          ".agents/scripts/run-worker.ts",
        ],
        ["M", "scripts/gh-post.mjs"],
        ["R100", "scripts/a.mjs", "scripts/live/a.mjs"],
        ["D", "scripts/old.mjs"],
        ["T", "scripts/link.mjs"]
      )
    ),
    []
  );
  assert.deepEqual(addedJavaScript(""), []);
});

test("the command names each new JavaScript file and fails, and passes when there is none", () => {
  const refused = check(
    diff(["A", "scripts/new.mjs"], ["A", "a folder/b.cjs"], ["A", "c.ts"])
  );
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(
    refused.stdout
      .split("\n")
      .filter((line) => line.startsWith("::error"))
      .map((line) => line.slice(0, line.indexOf("::", 2))),
    ["::error file=scripts/new.mjs", "::error file=a folder/b.cjs"]
  );
  assert.match(refused.stdout, /TypeScript/);

  const passed = check(diff(["M", "scripts/gh-post.mjs"], ["A", "c.ts"]));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "");
});

// CI는 바뀐 파일을 고르는 job(changes)에서 같은 기준으로 본다: pull request는 base와의 merge-base, push는 앞 push와의 merge-base다.
// 이벤트가 기준을 주지 않는 실행(수동 실행, 첫 push)도 건너뛰지 않고 main과의 merge-base로 보며, main이 없으면 실패한다(#285 리뷰
// SPEC-1). 그 job은 타입을 지우고 .ts를 바로 돌리는 Node 24를 준비한다. 단계의 셸 스크립트를 임시 저장소에서 GitHub과 같은 셸
// 옵션으로 실제로 돌린다.
const changesJob = () => {
  const jobs = field(parse(readFileSync(workflow, "utf8")), "jobs");
  return field(jobs, "changes");
};

test("the job that picks the changes prepares Node 24", () => {
  const steps = field(changesJob(), "steps");
  assert.ok(Array.isArray(steps), "no changes steps");
  assert.ok(
    steps.some(
      (step) =>
        /^actions\/setup-node@/.test(String(field(step, "uses"))) &&
        field(field(step, "with"), "node-version") === "24"
    ),
    "the changes job does not set up Node 24"
  );
});

/** changes job의 바뀐 파일 단계(id: diff) 스크립트. */
function diffStep() {
  const steps = field(changesJob(), "steps");
  assert.ok(Array.isArray(steps), "no changes steps");
  const step = steps.find((each) => field(each, "id") === "diff");
  const run = field(step, "run");
  assert.equal(typeof run, "string", "no diff step");
  return String(run);
}

/** 임시 저장소: 검사 스크립트를 두고 기준 commit을 만든다. `main`이면 origin/main을 그 commit에 둔다. */
function changesRepository(t: TestContext, { main }: { main: boolean }) {
  const cwd = mkdtempSync(path.join(tmpdir(), "babojubot-changes-step-"));
  t.after(() => removeFolder(cwd));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: gitEnvironment,
    }).trim();
  mkdirSync(path.join(cwd, "scripts"));
  for (const file of [
    "ci-changes.mjs",
    "javascript-files.ts",
    "test-files.mjs",
  ])
    copyFileSync(
      fileURLToPath(new URL(`./${file}`, import.meta.url)),
      path.join(cwd, "scripts", file)
    );
  writeFileSync(path.join(cwd, "package.json"), '{ "type": "module" }\n');
  git("init", "-q");
  const commit = (message: string) => {
    git("add", "--all");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      message
    );
    return git("rev-parse", "HEAD");
  };
  const base = commit("base");
  if (main) git("update-ref", "refs/remotes/origin/main", base);
  return {
    cwd,
    base,
    /** 파일 하나를 더한 commit을 만든다. */
    add: (file: string) => {
      writeFileSync(path.join(cwd, file), "export const a = 1;\n");
      return commit(`add ${file}`);
    },
  };
}

// Git hook이 GIT_DIR 같은 변수를 두면 임시 저장소 대신 실제 저장소를 본다.
const gitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
);

/** 단계를 GitHub처럼(bash --noprofile --norc -eo pipefail) 돌린다. */
function runDiffStep(cwd: string, base: string | undefined) {
  const output = path.join(cwd, "github-output");
  writeFileSync(output, "");
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", diffStep()],
    {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: {
        ...gitEnvironment,
        GITHUB_OUTPUT: output,
        ...(base === undefined ? {} : { BASE: base }),
      },
    }
  );
  if (result.error) throw result.error;
  return { ...result, outputs: readFileSync(output, "utf8") };
}

const bashOnly =
  process.platform === "win32" ? "the CI step is a bash script" : false;

test(
  "the changes step refuses new JavaScript against the base the event gives",
  { skip: bashOnly },
  (t) => {
    // 분류도 NUL 구분 목록을 받는다(scripts/ci-changes.mjs).
    assert.match(
      diffStep(),
      /git diff -z --name-only "\$BASE" HEAD \| node scripts\/ci-changes\.mjs/
    );
    const repo = changesRepository(t, { main: false });
    repo.add("typed.ts");
    const passed = runDiffStep(repo.cwd, repo.base);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.outputs, /^code=true$/m);

    repo.add("new.mjs");
    const refused = runDiffStep(repo.cwd, repo.base);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /^::error file=new\.mjs::/m);
  }
);

test(
  "the changes step compares a run without a base (manual, first push) with main",
  { skip: bashOnly },
  (t) => {
    const repo = changesRepository(t, { main: true });
    repo.add("new.mjs");
    for (const base of [
      undefined,
      "",
      "0000000000000000000000000000000000000000",
      "1234567890123456789012345678901234567890",
    ]) {
      const refused = runDiffStep(repo.cwd, base);
      assert.equal(
        refused.status,
        1,
        `${base}: ${refused.stdout}${refused.stderr}`
      );
      assert.match(refused.stdout, /^::error file=new\.mjs::/m, `${base}`);
      // 기준이 없으면 모든 검사를 돈다.
      assert.match(refused.outputs, /^code=true\nfiles=true$/m, `${base}`);
    }
  }
);

test(
  "the changes step fails when a run without a base has no main to compare with",
  { skip: bashOnly },
  (t) => {
    const repo = changesRepository(t, { main: false });
    repo.add("typed.ts");
    const result = runDiffStep(repo.cwd, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^::error::no base to check new JavaScript/m);
  }
);
