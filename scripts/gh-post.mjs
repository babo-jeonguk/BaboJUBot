// 이슈·PR 게시문을 검사한 뒤 gh에 넘긴다. 독자가 저장소에서 열 수 없는 로컬 전용 경로가 있으면 게시하지 않는다.
// 사용: node scripts/gh-post.mjs <issue|pr> <subcommand> ... (gh와 같은 인수)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts";

import {
  gitIgnores,
  ignoredDotFolderPattern,
  loadIgnoredDotFolders,
} from "./ignored-dot-folders.mjs";
import { linkTargets, parseMarkdown } from "./markdown.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * git 출력. `absent`에 든 종료 코드(없는 remote·ref)는 빈 문자열이고, git을 띄우지 못했거나 그 밖의 코드로 끝나면 원인과 함께 던진다.
 * 게시를 막는 검사이므로 모르는 것을 "없음"으로 보고 넘기지 않는다.
 * @param {string} root
 * @param {string[]} args
 * @param {{ absent?: number[] }} [options]
 */
function gitOutput(root, args, { absent = [] } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim();
  if (result.status !== null && absent.includes(result.status)) return "";
  throw new Error(
    `git ${args.join(" ")} failed (exit ${result.status ?? result.signal}): ${result.stderr.trim()}`
  );
}

function parseGitHubRepository(remote) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote);
  return match ? { owner: match[1], name: match[2] } : null;
}

/**
 * `root`가 속한 메인 checkout 폴더. git 명령 없이 `.git`을 읽는다(`git rev-parse --git-common-dir`와 같은 답): `.git`이 폴더면
 * `root` 자신, worktree의 `.git` 파일이면 그것이 가리키는 폴더의 `commondir`가 가리키는 `.git`의 부모다. checkout이 아니면 undefined.
 * 로컬 경로 검사는 git 없이도 돈다. git은 링크를 판정할 때만 부른다.
 */
function mainCheckout(root) {
  const dotGit = path.join(root, ".git");
  // 없으면 undefined, 그 밖의 오류는 던진다(throwIfNoEntry가 ENOENT만 undefined로 바꾼다).
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isDirectory()) return root;
  const pointer = fs.readFileSync(dotGit, "utf8");
  const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (!gitDir) throw new Error(`${dotGit} does not name a gitdir`);
  const worktreeDir = path.resolve(root, gitDir);
  // 없으면 commondir가 없는 worktree다. 그 밖의 읽기 오류는 드러낸다.
  const common = orIfMissing(
    () => fs.readFileSync(path.join(worktreeDir, "commondir"), "utf8"),
    hasErrorCode("ENOENT"),
    undefined
  );
  const commonDir =
    common === undefined
      ? worktreeDir
      : path.resolve(worktreeDir, common.trim());
  return path.basename(commonDir) === ".git"
    ? path.dirname(commonDir)
    : undefined;
}

export function loadContext(root = scriptRoot) {
  // 이 worktree와 메인 checkout의 절대 경로. 게시문에 붙은 이 접두사를 떼어 저장소 기준 경로로 본다.
  const roots = new Set([root]);
  const main = mainCheckout(root);
  if (main) roots.add(main);
  for (const location of [...roots]) {
    // 없는 경로는 접두사로 쓰지 않는다. 그 밖의 오류는 드러낸다.
    const real = orIfMissing(
      () => fs.realpathSync(location),
      hasErrorCode("ENOENT"),
      undefined
    );
    if (real !== undefined) roots.add(real);
  }
  const refs = new Map();
  let origin;
  return {
    root,
    roots: [...roots].flatMap((location) => [
      `${location}${path.sep}`,
      `${location.split(path.sep).join("/")}/`,
    ]),
    dotFolderPath: ignoredDotFolderPattern(loadIgnoredDotFolders(root), "g"),
    /** origin의 GitHub 저장소. GitHub 주소를 판정할 때 처음 묻는다. origin이 없으면(git 종료 코드 2) null이라 판정하지 않는다. */
    get repository() {
      origin ??= {
        repository: parseGitHubRepository(
          gitOutput(root, ["remote", "get-url", "origin"], { absent: [2] })
        ),
      };
      return origin.repository;
    },
    refExists(ref) {
      if (!refs.has(ref))
        refs.set(
          ref,
          [ref, `origin/${ref}`].some(
            (candidate) =>
              // 없는 ref는 종료 코드 1이다.
              gitOutput(
                root,
                ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
                { absent: [1] }
              ) !== ""
          )
        );
      return refs.get(ref);
    },
    /** 저장소 기준 경로가 `.gitignore`에 걸리는지. 경로는 `unknownPathShape`를 지난 아는 모양이다. 빈 경로는 저장소 자체다. */
    isIgnored(relative) {
      if (!relative) return false;
      return [relative, `${relative.replace(/\/$/, "")}/`].some((candidate) =>
        gitIgnores(root, candidate)
      );
    },
  };
}

// 이 저장소의 GitHub 파일 주소(blob/tree/raw)를 저장소 기준 경로로 바꾼다. github.com이 아닌 주소, 다른 저장소, 파일 주소가 아닌
// 것은 null. 주소 해석기가 읽지 못한 주소, origin을 모름, 잘못된 퍼센트 인코딩, 아는 ref가 없음은 판정할 수 없음이다.
/** @returns {string | null | { undecidable: string }} */
function repositoryPathFromUrl(url, context) {
  if (!URL.canParse(url))
    return { undecidable: "address the URL parser cannot read" };
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") return null;
  if (!context.repository)
    return {
      undecidable: "to GitHub while this checkout has no GitHub origin",
    };
  const segments = parsed.pathname.split("/").filter(Boolean).map(decoded);
  if (segments.includes(undefined))
    return { undecidable: "path with invalid percent-encoding" };
  const [owner, name, kind, ...rest] = segments;
  if (
    owner?.toLowerCase() !== context.repository.owner.toLowerCase() ||
    name?.toLowerCase() !== context.repository.name.toLowerCase() ||
    kind === undefined ||
    !["blob", "tree", "raw", "edit", "blame"].includes(kind) ||
    rest.length < 2
  )
    return null;
  // 브랜치 이름에 `/`가 들어갈 수 있어 실제로 있는 가장 짧은 ref를 찾는다. 아는 ref가 없으면 어디까지가 ref인지 모른다.
  for (let index = 1; index < rest.length; index++)
    if (context.refExists(rest.slice(0, index).join("/")))
      return rest.slice(index).join("/");
  return { undecidable: "to a GitHub branch or commit not known here" };
}

/** URL 인코딩을 푼 글자. 잘못된 인코딩(URIError)이면 undefined다. */
function decoded(text) {
  return orIfUnreadable(() => decodeURIComponent(text), undefined);
}

/**
 * 아는 단순한 모양이 아닌 경로의 까닭. 아는 모양이면 undefined. 앞뒤 공백·제어 문자(탭·개행 포함)·역슬래시·`//`로 시작·`..` 조각·`:`는
 * GitHub·브라우저와 git이 다르게 풀 수 있어(주소 해석기는 공백을 떼고 역슬래시를 `/`로 읽고, git은 `:`를 pathspec 표기로 읽는다)
 * 판정하지 않는다.
 */
function unknownPathShape(relative) {
  if (relative !== relative.trim()) return "path with space at either end";
  if (/\p{Cc}/u.test(relative)) return "path with a control character";
  if (relative.includes("\\")) return "path with a backslash";
  if (relative.startsWith("//")) return "path that starts with //";
  if (relative.split("/").includes("..")) return "path with a .. segment";
  if (relative.includes(":")) return "path with a colon";
  return undefined;
}

/**
 * 링크가 가리키는 이 저장소 기준 경로(`{ path }`), 판정할 수 없는 경로(`{ undecidable }`), 저장소 파일이 아닌 대상(null).
 * http(s) 주소는 Node의 WHATWG 주소 해석기로 읽는다.
 * @returns {{ path: string } | { undecidable: string } | null}
 */
function linkedRepositoryPath(target, context) {
  const local = /^https?:/i.test(target)
    ? repositoryPathFromUrl(target, context)
    : target.startsWith("#") || /^[a-z][\w+.-]*:/i.test(target)
      ? null
      : (decoded(target.split(/[?#]/)[0]) ?? {
          undecidable: "path with invalid percent-encoding",
        });
  if (local === null) return null;
  if (typeof local !== "string")
    return { undecidable: `a link ${local.undecidable}: ${target}` };
  const shape = unknownPathShape(local);
  if (shape) return { undecidable: `a link ${shape}: ${target}` };
  const relative = local.replace(/^(\.\/)+/, "");
  // 떼어낸 뒤에도 `/`로 시작하면 저장소 밖 절대 경로다.
  return relative.startsWith("/") ? null : { path: relative };
}

/**
 * 게시문에서 독자가 열 수 없는 경로를 찾는다. 점 폴더 경로는 글자로(코드 표기 안 포함), 링크는 CommonMark·GFM 구문 트리로 본다
 * (인라인 링크·이미지·자동 링크·맨 주소·참조식 링크 정의, 코드 안 글은 링크가 아님). 이 컴퓨터의 저장소 절대 경로는 먼저 뗀다.
 * 줄마다 같은 대상은 한 번만 낸다. raw HTML의 href와 아는 모양이 아닌 링크 경로는 판정할 수 없음(`undecidable`)으로 낸다.
 */
export function findLocalOnlyReferences(text, context) {
  let stripped = text;
  for (const prefix of context.roots)
    stripped = stripped.split(prefix).join("");
  const byLine = new Map();
  const add = (line, reference) => {
    if (!byLine.has(line)) byLine.set(line, new Set());
    byLine.get(line).add(reference);
  };
  stripped.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(context.dotFolderPath))
      add(index + 1, match[0].trim().replace(/^[`'"(]/, ""));
  });
  const targets = linkTargets(parseMarkdown(stripped));
  const undecidable = targets.undecidable.map(({ line, reason }) => ({
    line,
    undecidable: reason,
  }));
  for (const { url, line } of targets.links) {
    const linked = linkedRepositoryPath(url, context);
    if (linked && "undecidable" in linked)
      undecidable.push({ line, undecidable: linked.undecidable });
    else if (linked && context.isIgnored(linked.path)) add(line, url);
  }
  return [
    ...[...byLine.keys()]
      .sort((a, b) => a - b)
      .flatMap((line) =>
        [...byLine.get(line)].map((reference) => ({ line, reference }))
      ),
    ...undecidable,
  ];
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

/**
 * @param {string[]} args
 * @param {{ cwd: string, readStdin: () => string }} io
 * @returns {{ error: string } | { texts: { source: string, text: string }[], input: string | undefined }}
 */
function collectTexts(args, { cwd, readStdin }) {
  const [command, subcommand] = args;
  if (command === undefined || !["issue", "pr"].includes(command))
    return { error: "Only `gh issue ...` and `gh pr ...` are supported." };
  const options = subcommand === "close" ? closeTextOptions : textOptions;
  const texts = [];
  let input;
  for (let index = 2; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) continue;
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const kind = options[name];
    if (!kind) continue;
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (value === undefined) return { error: `${name} needs a value.` };
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
        return {
          error: `Cannot read ${value}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
  return { texts, input };
}

export function postToGitHub(args, { context, cwd, readStdin, runGh, report }) {
  const collected = collectTexts(args, { cwd, readStdin });
  if ("error" in collected) {
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
    for (const finding of findings)
      report(
        "undecidable" in finding
          ? `Cannot tell where a link points in published text ${finding.source}:${finding.line}: ${finding.undecidable}`
          : `Local-only path in published text ${finding.source}:${finding.line}: ${finding.reference}`
      );
    report(
      "Nothing was posted. Readers cannot open Git-ignored paths: summarize the content in the text or link a committed file instead. Write a link that cannot be judged as a Markdown link with a plain repository path."
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
      // 대화형 입력(편집기·질문)을 받는 gh도 끝나도록 넉넉한 상한을 둔다.
      const result = spawnSync("gh", args, {
        timeout: 30 * 60_000,
        killSignal: "SIGKILL",
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
