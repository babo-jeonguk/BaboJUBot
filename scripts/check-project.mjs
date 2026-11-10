import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// .gitignore의 점 폴더(로컬 조사 캐시·실행 데이터 등)는 checkout에 없으므로 문서가 경로로 가리키지 않는다.
const ignoredDotFolders = fs
  .readFileSync(path.join(root, ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /^\/?\.[^/*!]+\/$/.test(line))
  .map((line) => line.replace(/^\//, "").slice(0, -1));
const ignoredFolderPath = new RegExp(
  `(?:^|[\\s\`'"(])(?:\\./)?(?:${ignoredDotFolders
    .map((name) => name.replace(/[.]/g, "\\."))
    .join("|")})(?![\\w.-])`
);
// 그 폴더를 작업 위치로 정하는 도구 정의(agent skill·권한 설정)만 이름을 쓸 수 있다.
const toolDefinitions = [".agents/", ".opencode/"];

let markdownFiles = 0;
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        ".git",
        "node_modules",
        ".babojubot",
        ".venv",
        ".pnpm-store",
        ".reference-cache",
        ".scratch",
      ].includes(entry.name)
    )
      continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(location);
    else if (entry.name.endsWith(".md")) {
      markdownFiles++;
      const content = fs.readFileSync(location, "utf8");
      const relative = path.relative(root, location).split(path.sep).join("/");
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
        assert(
          fs.existsSync(resolved),
          `Broken local link ${location}: ${target}`
        );
        assert(
          !isGitIgnored(resolved),
          `Link to Git-ignored path ${location}: ${target}`
        );
      }
    }
  }
}
inspect(root);

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
