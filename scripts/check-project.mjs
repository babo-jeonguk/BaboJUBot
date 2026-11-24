import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hasErrorCode, orIfMissing } from "@babojubot/contracts";

import {
  gitIgnores,
  ignoredDotFolderPattern,
  loadIgnoredDotFolders,
} from "./ignored-dot-folders.mjs";
import { linkTargets, parseMarkdown } from "./markdown.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [".gitignore", "AGENTS.md", "GLOSSARY.md", "docs/features.md"];
for (const location of required)
  assert(fs.existsSync(path.join(root, location)), `Missing ${location}`);

const ignoredFolderPath = ignoredDotFolderPattern(loadIgnoredDotFolders(root));
// 그 폴더를 작업 위치로 정하는 도구 정의(agent skill·권한 설정)만 이름을 쓸 수 있다.
const toolDefinitions = [".agents/", ".opencode/"];

// 작업 트리를 직접 훑지 않고 Git이 아는 파일만 본다. 무시된 worktree·캐시 폴더가 검사에 섞이지 않는다.
let markdownFiles = 0;
const repositoryFiles = new Set(
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" }
  )
    .split("\0")
    .filter(Boolean)
);
for (const relative of repositoryFiles) {
  if (!relative.endsWith(".md")) continue;
  const location = path.join(root, relative);
  // index에는 있지만 작업 트리에서 지운 파일은 검사하지 않는다. 그 밖의 읽기 오류는 드러낸다.
  const content = orIfMissing(
    () => fs.readFileSync(location, "utf8"),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (content === undefined) continue;
  markdownFiles++;
  if (!toolDefinitions.some((prefix) => relative.startsWith(prefix)))
    content.split("\n").forEach((line, index) => {
      assert(
        !ignoredFolderPath.test(line),
        `Path to Git-ignored folder ${relative}:${index + 1}`
      );
    });
  // 링크는 CommonMark·GFM 구문 트리로 읽는다: 참조식 링크 정의도 링크이고, 코드 안 글은 링크가 아니다.
  const targets = linkTargets(parseMarkdown(content));
  for (const { reason, line } of targets.undecidable)
    assert.fail(
      `Cannot tell where an HTML link points ${location}:${line}: ${reason}. Write it as a Markdown link or a single plain href.`
    );
  for (const { url, line } of targets.links) {
    if (/^(https?:|mailto:|#)/.test(url)) continue;
    const hash = url.indexOf("#");
    const local = hash === -1 ? url : url.slice(0, hash);
    const resolved = path.resolve(path.dirname(location), local);
    assert(
      fs.existsSync(resolved),
      `Broken local link ${location}:${line}: ${url}`
    );
    assert(
      !gitIgnores(root, resolved),
      `Link to Git-ignored path ${location}:${line}: ${url}`
    );
  }
}

// 두 worker 실행 경로(스크립트·Paseo)가 같은 agent 계약으로 돌게 한다.
const runWorker = fs.readFileSync(
  path.join(root, ".agents/scripts/run-worker.ts"),
  "utf8"
);
assert(
  /"--agent",\s*"dev-worker"/.test(runWorker),
  "run-worker.ts must pass --agent dev-worker"
);
const devWorker = fs.readFileSync(
  path.join(root, ".opencode/agents/dev-worker.md"),
  "utf8"
);
assert(/^steps: \d+$/m.test(devWorker), "dev-worker.md must set steps");
for (const action of ["subagent", "webfetch", "external_directory"])
  assert(
    new RegExp(
      `action: ${action}\\n\\s+resource: "\\*"\\n\\s+effect: deny`
    ).test(devWorker),
    `dev-worker.md must deny ${action}`
  );
// worker가 통과시킬 시험과 검사 설정을 스스로 고치지 못하게 한다.
for (const resource of [
  "*.test.*",
  "*.spec.*",
  "*eslint.config.*",
  "*package.json",
  "scripts/*",
])
  assert(
    devWorker.includes(
      `action: edit\n    resource: "${resource}"\n    effect: deny`
    ),
    `dev-worker.md must deny editing ${resource}`
  );
console.log(
  `Checked local links in ${markdownFiles} Markdown files. No product functionality was tested.`
);
