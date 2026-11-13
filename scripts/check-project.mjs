import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ignoredDotFolderPattern,
  loadIgnoredDotFolders,
} from "./ignored-dot-folders.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [".gitignore", "AGENTS.md", "GLOSSARY.md", "docs/features.md"];
for (const location of required)
  assert(fs.existsSync(path.join(root, location)), `Missing ${location}`);

function isGitIgnored(location) {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", location], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const ignoredFolderPath = ignoredDotFolderPattern(loadIgnoredDotFolders(root));
// 그 폴더를 작업 위치로 정하는 도구 정의(agent skill·권한 설정)만 이름을 쓸 수 있다.
const toolDefinitions = [".agents/", ".opencode/"];

// 작업 트리를 직접 훑지 않고 Git이 아는 파일만 본다. 무시된 worktree·캐시 폴더가 검사에 섞이지 않는다.
let markdownFiles = 0;
const repositoryFiles = new Set(
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean)
);
for (const relative of repositoryFiles) {
  if (!relative.endsWith(".md")) continue;
  const location = path.join(root, relative);
  // index에는 있지만 작업 트리에서 지운 파일은 검사하지 않는다.
  if (!fs.existsSync(location)) continue;
  markdownFiles++;
  const content = fs.readFileSync(location, "utf8");
  if (!toolDefinitions.some((prefix) => relative.startsWith(prefix)))
    content.split("\n").forEach((line, index) => {
      assert(
        !ignoredFolderPath.test(line),
        `Path to Git-ignored folder ${relative}:${index + 1}`
      );
    });
  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const local = target.split("#")[0];
    const resolved = path.resolve(path.dirname(location), local);
    assert(fs.existsSync(resolved), `Broken local link ${location}: ${target}`);
    assert(
      !isGitIgnored(resolved),
      `Link to Git-ignored path ${location}: ${target}`
    );
  }
}

// 두 worker 실행 경로(스크립트·Paseo)가 같은 agent 계약으로 돌게 한다.
const runWorker = fs.readFileSync(
  path.join(root, ".agents/scripts/run-worker.mjs"),
  "utf8"
);
assert(
  /"--agent",\s*"dev-worker"/.test(runWorker),
  "run-worker.mjs must pass --agent dev-worker"
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
console.log(
  `Checked local links in ${markdownFiles} Markdown files. No product functionality was tested.`
);
