// 이슈·PR 게시문을 검사한 뒤 gh에 넘긴다. 독자가 저장소에서 열 수 없는 로컬 전용 경로가 있으면 게시하지 않는다.
// 사용: node scripts/gh-post.mjs <issue|pr> <subcommand> ... (gh와 같은 인수)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ignoredDotFolderPattern,
  loadIgnoredDotFolders,
} from "./ignored-dot-folders.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function gitOutput(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseGitHubRepository(remote) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote);
  return match ? { owner: match[1], name: match[2] } : null;
}

export function loadContext(root = scriptRoot) {
  // 이 worktree와 메인 checkout의 절대 경로. 게시문에 붙은 이 접두사를 떼어 저장소 기준 경로로 본다.
  const commonDir = gitOutput(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const roots = new Set([root]);
  if (path.basename(commonDir) === ".git") roots.add(path.dirname(commonDir));
  for (const location of [...roots]) {
    try {
      roots.add(fs.realpathSync(location));
    } catch {
      // 없는 경로는 접두사로 쓰지 않는다.
    }
  }
  const refs = new Map();
  return {
    root,
    roots: [...roots].flatMap((location) => [
      `${location}${path.sep}`,
      `${location.split(path.sep).join("/")}/`,
    ]),
    dotFolderPath: ignoredDotFolderPattern(loadIgnoredDotFolders(root), "g"),
    repository: parseGitHubRepository(
      gitOutput(root, ["remote", "get-url", "origin"])
    ),
    refExists(ref) {
      if (!refs.has(ref))
        refs.set(
          ref,
          [ref, `origin/${ref}`].some(
            (candidate) =>
              gitOutput(root, [
                "rev-parse",
                "--verify",
                "--quiet",
                `${candidate}^{commit}`,
              ]) !== ""
          )
        );
      return refs.get(ref);
    },
    isIgnored(relative) {
      // 저장소 밖(..)이나 `:`가 든 표기는 git이 오류로 멈추므로 판정하지 않는다.
      if (
        !relative ||
        relative.split("/").includes("..") ||
        relative.includes(":")
      )
        return false;
      return [relative, `${relative.replace(/\/$/, "")}/`].some(
        (candidate) =>
          spawnSync("git", ["check-ignore", "--no-index", "-q", candidate], {
            cwd: root,
            stdio: "ignore",
          }).status === 0
      );
    },
  };
}

// 이 저장소의 GitHub 파일 주소(blob/tree/raw)를 저장소 기준 경로로 바꾼다. 다른 저장소·다른 주소는 null.
function repositoryPathFromUrl(url, context) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" || !context.repository) return null;
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const [owner, name, kind, ...rest] = segments;
  if (
    owner?.toLowerCase() !== context.repository.owner.toLowerCase() ||
    name?.toLowerCase() !== context.repository.name.toLowerCase() ||
    !["blob", "tree", "raw", "edit", "blame"].includes(kind) ||
    rest.length < 2
  )
    return null;
  // 브랜치 이름에 `/`가 들어갈 수 있어 실제로 있는 가장 짧은 ref를 찾는다. 모르면 첫 마디를 ref로 본다.
  for (let index = 1; index < rest.length; index++)
    if (context.refExists(rest.slice(0, index).join("/")))
      return rest.slice(index).join("/");
  return rest.slice(1).join("/");
}

function linkTargets(line) {
  const targets = [];
  for (const match of line.matchAll(/\]\(\s*<?([^)\s>]+)/g))
    targets.push(match[1]);
  for (const match of line.matchAll(/href=["']([^"']+)["']/gi))
    targets.push(match[1]);
  for (const match of line.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g))
    targets.push(match[0]);
  return targets;
}

function linkedRepositoryPath(target, context) {
  if (/^https?:/i.test(target)) return repositoryPathFromUrl(target, context);
  if (target.startsWith("#") || /^[a-z][\w+.-]*:/i.test(target)) return null;
  let local = target.split(/[?#]/)[0];
  try {
    local = decodeURIComponent(local);
  } catch {
    // 잘못된 인코딩은 그대로 판정한다.
  }
  local = local.replace(/^(\.\/)+/, "");
  // 떼어낸 뒤에도 `/`로 시작하면 저장소 밖 절대 경로다.
  return local.startsWith("/") ? null : local;
}

export function findLocalOnlyReferences(text, context) {
  const findings = [];
  text.split(/\r?\n/).forEach((original, index) => {
    let line = original;
    for (const prefix of context.roots) line = line.split(prefix).join("");
    const references = new Set();
    for (const match of line.matchAll(context.dotFolderPath))
      references.add(match[0].trim().replace(/^[`'"(]/, ""));
    for (const target of linkTargets(line)) {
      const relative = linkedRepositoryPath(target, context);
      if (relative && context.isIgnored(relative)) references.add(target);
    }
    for (const reference of references)
      findings.push({ line: index + 1, reference });
  });
  return findings;
}

// gh issue/pr 하위 명령에서 게시되는 글을 받는 옵션. 값이 파일이면 "file".
const textOptions = {
  "--title": "text",
  "-t": "text",
  "--subject": "text",
  "--body": "text",
  "-b": "text",
  "--body-file": "file",
  "-F": "file",
};
// close의 --comment/-c는 글을 받지만, pr review의 --comment는 값 없는 선택지다.
const closeTextOptions = { ...textOptions, "--comment": "text", "-c": "text" };

function collectTexts(args, { cwd, readStdin }) {
  const [command, subcommand] = args;
  if (!["issue", "pr"].includes(command))
    return { error: "Only `gh issue ...` and `gh pr ...` are supported." };
  const options = subcommand === "close" ? closeTextOptions : textOptions;
  const texts = [];
  let input;
  for (let index = 2; index < args.length; index++) {
    const argument = args[index];
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const kind = options[name];
    if (!kind) continue;
    let value;
    if (equals !== -1) value = argument.slice(equals + 1);
    else if (index + 1 < args.length) value = args[++index];
    else return { error: `${name} needs a value.` };
    if (kind === "text") {
      texts.push({ source: name, text: value });
    } else if (value === "-") {
      input ??= readStdin();
      texts.push({ source: "stdin", text: input });
    } else {
      try {
        texts.push({
          source: value,
          text: fs.readFileSync(path.resolve(cwd, value), "utf8"),
        });
      } catch (error) {
        return { error: `Cannot read ${value}: ${error.message}` };
      }
    }
  }
  return { texts, input };
}

export function postToGitHub(args, { context, cwd, readStdin, runGh, report }) {
  const collected = collectTexts(args, { cwd, readStdin });
  if (collected.error) {
    report(
      `${collected.error}\nUsage: node scripts/gh-post.mjs <issue|pr> <subcommand> [gh arguments]`
    );
    return 2;
  }
  const findings = collected.texts.flatMap(({ source, text }) =>
    findLocalOnlyReferences(text, context).map((finding) => ({
      source,
      ...finding,
    }))
  );
  if (findings.length) {
    for (const { source, line, reference } of findings)
      report(
        `Local-only path in published text ${source}:${line}: ${reference}`
      );
    report(
      "Nothing was posted. Readers cannot open Git-ignored paths: summarize the content in the text or link a committed file instead."
    );
    return 1;
  }
  return runGh(args, collected.input);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = postToGitHub(process.argv.slice(2), {
    context: loadContext(),
    cwd: process.cwd(),
    readStdin: () => fs.readFileSync(0, "utf8"),
    runGh(args, input) {
      const result = spawnSync("gh", args, {
        input,
        stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      });
      if (result.error) {
        console.error(`Cannot run gh: ${result.error.message}`);
        return 2;
      }
      return result.status ?? 1;
    },
    report: (message) => console.error(message),
  });
}
