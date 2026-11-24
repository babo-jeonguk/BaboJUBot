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
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const unknownRef =
  "a link to a GitHub branch or commit not known here (write it with a full commit SHA or an origin branch name)";
const ambiguousRef =
  "a link to a GitHub ref that splits the path more than one way (write it with a full commit SHA or an origin branch name)";

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8", stdio: "pipe" }
  );
}

// 실제 .gitignore와 스크립트를 담은 저장소를 만든다. origin은 acme/demo, origin에 슬래시가 든 브랜치 fix/1-x가 있다.
function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "babojubot-gh-post-"));
  for (const relative of [
    ".gitignore",
    "scripts/gh-post.mjs",
    "scripts/ignored-dot-folders.mjs",
    "scripts/markdown.mjs",
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
  // 내려받은 origin처럼 원격 추적 ref를 둔다: 브랜치 main·fix/1-x와 origin의 HEAD.
  git(fixture, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(fixture, "update-ref", "refs/remotes/origin/fix/1-x", "HEAD");
  git(
    fixture,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main"
  );
  // 복사한 스크립트가 저장소의 Markdown 파서를 가져가도록 node_modules를 잇는다(커밋 뒤라 fixture의 Git에는 들지 않는다).
  fs.symlinkSync(
    path.join(repository, "node_modules"),
    path.join(fixture, "node_modules"),
    "junction"
  );
  return fixture;
}

async function withFixture(run) {
  const fixture = createFixture();
  return withCleanup(async (defer) => {
    defer(() => removeFolder(fixture));
    return await run(fixture);
  });
}

test("published text rejects references readers cannot open", async () => {
  await withFixture((fixture) => {
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
      // 참조식 링크 정의(CommonMark §4.7)도 링크다.
      "[보고서][r]\n\n[r]: playwright-report/index.html",
      "[trace]: ./test-results/a/trace.zip",
      '<a href="playwright-report/index.html">보고서</a>',
    ];
    for (const text of rejected)
      assert.notEqual(
        findLocalOnlyReferences(text, context).length,
        0,
        `expected rejection: ${text}`
      );
  });
});

test("published text allows names, product settings, prose and committed links", async () => {
  await withFixture((fixture) => {
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
      "::/0 같은 표기",
      "저장소 밖 임시 폴더에 남긴다.",
      // 코드 블록·코드 스팬 안 글은 링크가 아니다(CommonMark §4.5·§6.1). 점 폴더 경로는 코드 안도 따로 본다.
      "```\n[보고서](playwright-report/index.html)\n```",
      "`[보고서](playwright-report/index.html)`",
      "`https://github.com/acme/demo/blob/main/test-results/a/trace.zip`",
    ];
    for (const text of allowed)
      assert.deepEqual(
        findLocalOnlyReferences(text, context),
        [],
        `expected allowed: ${text}`
      );
  });
});

test("a reference definition finding names the definition's line", async () => {
  await withFixture((fixture) => {
    const findings = findLocalOnlyReferences(
      "[보고서][r]를 본다.\n\n[r]: playwright-report/index.html",
      loadContext(fixture)
    );
    assert.deepEqual(findings, [
      { line: 3, reference: "playwright-report/index.html" },
    ]);
  });
});

test("each finding names the line and the reference", async () => {
  await withFixture((fixture) => {
    const [finding] = findLocalOnlyReferences(
      "첫 줄\n자세한 건 `.scratch/x.md` 참고",
      loadContext(fixture)
    );
    assert.ok(finding && "reference" in finding, "no path finding");
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

test("a clean body is passed to gh unchanged", async () => {
  await withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture, "body.md"), "결과를 요약했다.\n");
    const args = ["issue", "comment", "12", "--body-file", "body.md"];
    const { status, calls } = post(fixture, args);
    assert.equal(status, 0);
    assert.deepEqual(calls, [{ args, input: undefined }]);
  });
});

test("a body with a local-only path is not posted", async () => {
  await withFixture((fixture) => {
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

// 링크 경로는 아는 단순한 모양만 판정한다. 앞뒤 공백, 제어 문자(인코딩을 푼 탭 포함), 역슬래시, `//`로 시작, `..` 조각, `:`가 든
// 경로는 GitHub·브라우저가 git과 다르게 풀 수 있어 판정할 수 없음이다. 저장소 밖(`../../outside.md`)도 `..`라 예전처럼 허용하지
// 않는다(#295 외부 리뷰 1회차 SPEC-1).
test("published text rejects a link path it cannot judge", async () => {
  await withFixture((fixture) => {
    const context = loadContext(fixture);
    const cases = [
      [
        "[보고서](< playwright-report/index.html>)",
        "a link path with space at either end",
        " playwright-report/index.html",
      ],
      [
        "[trace](test-results/a%09trace.zip)",
        "a link path with a control character",
        "test-results/a%09trace.zip",
      ],
      [
        "[trace](test-results\\a\\trace.zip)",
        "a link path with a backslash",
        "test-results\\a\\trace.zip",
      ],
      [
        "[trace](//github.com/acme/demo/blob/main/test-results/a/trace.zip)",
        "a link path that starts with //",
        "//github.com/acme/demo/blob/main/test-results/a/trace.zip",
      ],
      [
        "[보고서](docs/../playwright-report/index.html)",
        "a link path with a .. segment",
        "docs/../playwright-report/index.html",
      ],
      [
        "[밖](../../outside.md)",
        "a link path with a .. segment",
        "../../outside.md",
      ],
      [
        "[trace](./test-results:a/trace.zip)",
        "a link path with a colon",
        "./test-results:a/trace.zip",
      ],
      [
        "https://github.com/acme/demo/blob/main/test-results%5Ca%5Ctrace.zip",
        "a link path with a backslash",
        "https://github.com/acme/demo/blob/main/test-results%5Ca%5Ctrace.zip",
      ], // 잘못된 퍼센트 인코딩은 그대로 판정하지 않는다. 아는 ref가 없는 주소의 첫 마디를 ref로 짐작하지 않는다. 주소 해석기가
      // 읽지 못한 http(s) 주소를 "이 저장소 파일 아님"으로 접지 않는다(#295 2회차 parent 점검).
      [
        "[문서](docs/%E0%A4%A.md)",
        "a link path with invalid percent-encoding",
        "docs/%E0%A4%A.md",
      ],
      [
        "https://github.com/acme/demo/blob/main/docs/%E0%A4%A.md",
        "a link path with invalid percent-encoding",
        "https://github.com/acme/demo/blob/main/docs/%E0%A4%A.md",
      ],
      [
        "https://github.com/acme/demo/blob/no-such-ref/docs/a.md",
        unknownRef,
        "https://github.com/acme/demo/blob/no-such-ref/docs/a.md",
      ],
      [
        "[주소](<https://[github.com/acme/demo>)",
        "a link address the URL parser cannot read",
        "https://[github.com/acme/demo",
      ],
    ];
    for (const [text, reason, url] of cases)
      assert.deepEqual(
        findLocalOnlyReferences(text, context),
        [{ line: 1, undecidable: `${reason}: ${url}` }],
        text
      );
  });
});

// GitHub 파일 주소의 ref는 GitHub가 아는 것만 인정한다: origin 브랜치 이름(원격 추적 ref, HEAD 제외)과, origin 원격 추적 ref에서
// 닿는 전체 커밋 SHA. 로컬에서 풀리는 revision(origin/main, refs/remotes/origin/main, ORIG_HEAD, 로컬 브랜치·태그, 짧은 SHA, push 안 된
// 커밋)은 GitHub가 모를 수 있다. ref 경계가 둘 이상 맞아도 어느 경로인지 모른다(#295 외부 리뷰 2회차 STD-3·SPEC-2·REC-4).
test("published text judges a GitHub file link only by an origin branch or a full commit SHA reachable from origin", async () => {
  await withFixture((fixture) => {
    const head = git(fixture, "rev-parse", "HEAD").trim();
    git(fixture, "update-ref", "ORIG_HEAD", "HEAD");
    git(fixture, "branch", "local-only");
    git(fixture, "tag", "fix");
    const unpushed = git(
      fixture,
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "unpushed"
    ).trim();
    git(fixture, "update-ref", `refs/remotes/origin/${head}/x`, "HEAD");
    const context = loadContext(fixture);
    const file = (ref, rest) =>
      `https://github.com/acme/demo/blob/${ref}/${rest}`;
    for (const [url, reason] of [
      [file("origin/main", "docs/a.md"), unknownRef],
      [file("refs/remotes/origin/main", "docs/a.md"), unknownRef],
      [file("ORIG_HEAD", "docs/a.md"), unknownRef],
      [file("HEAD", "docs/a.md"), unknownRef],
      [file("local-only", "docs/a.md"), unknownRef],
      [file(head.slice(0, 7), "docs/a.md"), unknownRef],
      [file(unpushed, "docs/a.md"), unknownRef],
      [file(head, "x/docs/a.md"), ambiguousRef],
    ])
      assert.deepEqual(
        findLocalOnlyReferences(url, context),
        [{ line: 1, undecidable: `${reason}: ${url}` }],
        url
      );
    // 태그 fix는 ref가 아니므로 origin 브랜치 fix/1-x로 경로(data/a.md)를 정한다.
    for (const url of [
      file("fix/1-x", "data/a.md"),
      file(head, "test-results/a/trace.zip"),
    ])
      assert.deepEqual(
        findLocalOnlyReferences(url, context),
        [{ line: 1, reference: url }],
        url
      );
    for (const ref of ["main", head])
      assert.deepEqual(
        findLocalOnlyReferences(
          file(ref, "docs/research/issue-1-references.md"),
          context
        ),
        [],
        ref
      );
  });
});

// origin 저장소를 모르면 github.com 파일 주소가 이 저장소를 가리키는지 알 수 없다. 다른 저장소로 접지 않는다.
test("published text rejects a GitHub link when the checkout has no GitHub origin", async () => {
  await withFixture((fixture) => {
    git(fixture, "remote", "remove", "origin");
    const url = "https://github.com/acme/demo/blob/main/docs/a.md";
    assert.deepEqual(findLocalOnlyReferences(url, loadContext(fixture)), [
      {
        line: 1,
        undecidable: `a link to GitHub while this checkout has no GitHub origin: ${url}`,
      },
    ]);
  });
});

// 브라우저는 속성 값의 문자 참조를 풀어 `playwright-report/index.html`로 읽는다. 그 값을 글자 그대로 판정하면 열 수 없는 경로가
// 게시된다. 판정할 수 없는 HTML 링크는 게시하지 않는다(#286 병합분 감사 항목 1).
test("a body with an HTML link that cannot be read is not posted", async () => {
  await withFixture((fixture) => {
    fs.writeFileSync(
      path.join(fixture, "body.md"),
      '요약\n\n<a href="playwright-report&#47;index.html">보고서</a>\n'
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
    assert.match(
      errors,
      /Cannot tell where a link points in published text body\.md:3: href in raw HTML \(write the link in Markdown\)$/m
    );
  });
});

test("every text option of issue and pr commands is checked", async () => {
  await withFixture((fixture) => {
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

test("a body read from stdin is checked and handed to gh", async () => {
  await withFixture((fixture) => {
    const args = ["pr", "comment", "3", "--body-file", "-"];
    const clean = post(fixture, args, { stdin: "요약만 남긴다.\n" });
    assert.equal(clean.status, 0);
    assert.deepEqual(clean.calls, [{ args, input: "요약만 남긴다.\n" }]);

    const dirty = post(fixture, args, { stdin: "원문은 .scratch/x\n" });
    assert.equal(dirty.status, 1);
    assert.deepEqual(dirty.calls, []);
  });
});

test("usage errors do not reach gh", async () => {
  await withFixture((fixture) => {
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

test("the command stops before gh when the body has a local-only path", async () => {
  await withFixture((fixture) => {
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
