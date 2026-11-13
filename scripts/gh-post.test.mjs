import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findLocalOnlyReferences,
  loadContext,
  postToGitHub,
} from "./gh-post.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8", stdio: "pipe" }
  );
}

// 실제 .gitignore와 스크립트를 담은 저장소를 만든다. origin은 acme/demo, 슬래시가 든 브랜치 fix/1-x가 있다.
function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "babojubot-gh-post-"));
  for (const relative of [
    ".gitignore",
    "scripts/gh-post.mjs",
    "scripts/ignored-dot-folders.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(fixture, relative)), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repository, relative),
      path.join(fixture, relative)
    );
  }
  fs.mkdirSync(path.join(fixture, "docs/research"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "docs/research/issue-1-references.md"),
    "# refs\n"
  );
  git(fixture, "init", "-q", "-b", "main");
  git(fixture, "remote", "add", "origin", "https://github.com/acme/demo.git");
  git(fixture, "add", ".");
  git(fixture, "commit", "-q", "-m", "init");
  git(fixture, "branch", "fix/1-x");
  return fixture;
}

function withFixture(run) {
  const fixture = createFixture();
  try {
    return run(fixture);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test("published text rejects references readers cannot open", () => {
  withFixture((fixture) => {
    const context = loadContext(fixture);
    const rejected = [
      "근거는 `.reference-cache/issue-1/`에 있다.",
      "증거는 .scratch/chaos/<timestamp>/ 에 남긴다",
      `원문은 ${fixture}/.scratch/run/log.md 에 있다`,
      "[보고서](playwright-report/index.html)",
      "[trace](./test-results/a/trace.zip)",
      "https://github.com/acme/demo/blob/main/test-results/a/trace.zip",
      "[캐시](https://github.com/Acme/Demo/tree/main/.reference-cache/issue-1)",
      "[브랜치 파일](https://github.com/acme/demo/blob/fix/1-x/data/a.md)",
    ];
    for (const text of rejected)
      assert.notEqual(
        findLocalOnlyReferences(text, context).length,
        0,
        `expected rejection: ${text}`
      );
  });
});

test("published text allows names, product settings, prose and committed links", () => {
  withFixture((fixture) => {
    const context = loadContext(fixture);
    const allowed = [
      "제품 데이터는 `BABOJUBOT_HOME` 아래에 둔다.",
      "Codex 로그인 파일 `auth.json`과 `postgres.log`, `.env`를 설명한다.",
      "미실행: test/typecheck/lint/build/E2E",
      "차트의 data/empty 전환을 확인했다.",
      "조직 공유 폴더 `shared/.venv/bin`이 PATH 앞에 놓인다.",
      "`~/.venv/bin`과 foo.reference-cache/x는 다른 것이다.",
      "[조사](https://github.com/acme/demo/blob/main/docs/research/issue-1-references.md)",
      "[다른 저장소](https://github.com/other/repo/blob/main/.scratch/x.md)",
      "[밖](../../outside.md) 그리고 ::/0 같은 표기",
      "저장소 밖 임시 폴더에 남긴다.",
    ];
    for (const text of allowed)
      assert.deepEqual(
        findLocalOnlyReferences(text, context),
        [],
        `expected allowed: ${text}`
      );
  });
});

test("each finding names the line and the reference", () => {
  withFixture((fixture) => {
    const [finding] = findLocalOnlyReferences(
      "첫 줄\n자세한 건 `.scratch/x.md` 참고",
      loadContext(fixture)
    );
    assert.equal(finding.line, 2);
    assert.match(finding.reference, /\.scratch/);
  });
});

function post(fixture, args, { stdin = "" } = {}) {
  const calls = [];
  const errors = [];
  const status = postToGitHub(args, {
    context: loadContext(fixture),
    cwd: fixture,
    readStdin: () => stdin,
    runGh: (ghArgs, input) => {
      calls.push({ args: ghArgs, input });
      return 0;
    },
    report: (message) => errors.push(message),
  });
  return { status, calls, errors: errors.join("\n") };
}

test("a clean body is passed to gh unchanged", () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture, "body.md"), "결과를 요약했다.\n");
    const args = ["issue", "comment", "12", "--body-file", "body.md"];
    const { status, calls } = post(fixture, args);
    assert.equal(status, 0);
    assert.deepEqual(calls, [{ args, input: undefined }]);
  });
});

test("a body with a local-only path is not posted", () => {
  withFixture((fixture) => {
    fs.writeFileSync(
      path.join(fixture, "body.md"),
      "요약\n\n원문은 `.reference-cache/issue-1/`\n"
    );
    const { status, calls, errors } = post(fixture, [
      "issue",
      "comment",
      "12",
      "--body-file",
      "body.md",
    ]);
    assert.equal(status, 1);
    assert.deepEqual(calls, []);
    assert.match(errors, /body\.md:3/);
    assert.match(errors, /\.reference-cache/);
  });
});

test("every text option of issue and pr commands is checked", () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture, "bad.md"), "see .scratch/x\n");
    const cases = [
      ["issue", "comment", "1", "--body", "see .scratch/x"],
      ["issue", "comment", "1", "-b", "see .scratch/x"],
      ["issue", "comment", "1", "--body=see .scratch/x"],
      ["issue", "create", "--title", "fix .scratch/x", "--body", "ok"],
      ["pr", "create", "-t", "fix .scratch/x", "-b", "ok"],
      ["pr", "edit", "3", "-F", "bad.md"],
      ["pr", "review", "3", "--comment", "--body-file=bad.md"],
      ["issue", "close", "1", "--comment", "see .scratch/x"],
      ["pr", "close", "1", "-c", "see .scratch/x"],
      ["pr", "merge", "1", "--subject", "fix .scratch/x"],
    ];
    for (const args of cases) {
      const { status, calls } = post(fixture, args);
      assert.equal(status, 1, `expected rejection: ${args.join(" ")}`);
      assert.deepEqual(calls, []);
    }
  });
});

test("a body read from stdin is checked and handed to gh", () => {
  withFixture((fixture) => {
    const args = ["pr", "comment", "3", "--body-file", "-"];
    const clean = post(fixture, args, { stdin: "요약만 남긴다.\n" });
    assert.equal(clean.status, 0);
    assert.deepEqual(clean.calls, [{ args, input: "요약만 남긴다.\n" }]);

    const dirty = post(fixture, args, { stdin: "원문은 .scratch/x\n" });
    assert.equal(dirty.status, 1);
    assert.deepEqual(dirty.calls, []);
  });
});

test("usage errors do not reach gh", () => {
  withFixture((fixture) => {
    for (const args of [
      [],
      ["api", "repos/acme/demo/issues/1/comments", "-f", "body=x"],
      ["issue", "comment", "1", "--body-file", "missing.md"],
      ["issue", "comment", "1", "--body"],
    ]) {
      const { status, calls } = post(fixture, args);
      assert.equal(status, 2, `expected usage error: ${args.join(" ")}`);
      assert.deepEqual(calls, []);
    }
  });
});

test("the command stops before gh when the body has a local-only path", () => {
  withFixture((fixture) => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/gh-post.mjs",
        "issue",
        "comment",
        "1",
        "--body",
        "see .scratch/x",
      ],
      {
        cwd: fixture,
        encoding: "utf8",
        timeout: 30_000,
        // gh가 불리면 실패하도록 PATH를 비운다.
        env: { ...process.env, PATH: "" },
      }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\.scratch/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  });
});
