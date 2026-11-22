// 코드 지도(docs/agents/code-map.md와 docs/agents/code-map/의 절 파일)가 가리키는 파일·이름이 저장소에 있는지 확인한다(#250).
// 링크가 열리는지는 check-project.mjs가 본다. 여기서는 링크 밖의 짧은 파일 표기와 코드 표기(백틱)의 이름을 본다.
// 판정 단위는 줄 하나(표의 행, 문단의 줄)이고 코드 블록(```)은 보지 않는다. 표기마다 예외를 두지 않고 아래 규칙만 쓴다.
// - 파일 표기: 확장자로 끝나는 경로(`core/run.ts`, `rows.ts`). 저장소 경로, 또는 `packages/<이름>/`·`apps/<이름>/` 뒤의
//   `src/`·`test/`·`e2e/`를 뺀 짧은 경로(`packages/core/src/run.ts` → `core/run.ts`)의 끝과 맞는 Markdown 밖 파일 하나로 푼다.
//   맞는 파일이 없거나 둘 이상이면 실패한다.
// - 이름: 식별자 모양(영문·숫자·`_`·`$`, `-`로 이은 낱말, `.`로 이은 조각, 앞의 `#`, 뒤의 호출 괄호)의 코드 표기. 그 줄이 가리키는
//   파일(링크·파일 표기) 본문에 낱말로 있어야 한다. 줄에 파일이 없으면 Markdown이 아닌 저장소 파일 전체에서 찾는다. `.`로 이은
//   이름은 통째로 있거나 조각마다 있으면 통과한다. 문자열로만 쓰이는 상태 값도 본문에 있으면 통과한다.
// - 시험 이름: 표의 `테스트` 열에서 식별자 모양도 파일 표기도 아니고 `/`·`*`가 없는 코드 표기. 그 줄이 가리키는 시험 파일 본문에
//   글자 그대로 있어야 하고(끝의 `…`는 앞부분만 본다), 줄에 시험 파일이 없으면 저장소의 시험 파일 전체에서 찾는다.
// - 그 밖의 코드 표기(한글·공백·따옴표가 든 문구, 경로, 명령, `*`)는 보지 않는다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isTestFile } from "./test-files.mjs";

const extensions =
  "ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|sql|css|html|sh|ps1|patch";
const fileNotation = new RegExp(
  `^(?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${extensions})$`
);
const fileInText = new RegExp(
  `(?<![\\w./-])(?:[\\w-]+/)*[\\w-][\\w.-]*\\.(?:${extensions})(?![\\w/-])`,
  "g"
);
const segment = "[A-Za-z_$#][\\w$]*(?:-[\\w$]+)*";
const namePattern = new RegExp(
  `^(${segment}(?:\\.${segment})*)(?:\\((?:[^()]|\\([^()]*\\))*\\))?$`
);

function isCodeMapFile(file) {
  return (
    file === "docs/agents/code-map.md" ||
    /^docs\/agents\/code-map\/[^/]+\.md$/.test(file)
  );
}

/** `packages/core/src/run.ts` → `core/run.ts`. 패키지 폴더 밖 파일은 그대로 둔다. */
function shortForm(file) {
  return file.replace(
    /^(?:packages|apps)\/([^/]+)\/(?:(?:src|test|e2e)\/)?/,
    "$1/"
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 표의 한 행을 칸으로 나눈다. 코드 표기 안의 `|`는 칸 구분이 아니다. */
function splitRow(line) {
  const cells = [""];
  let inCode = false;
  for (const char of line.trim().replace(/^\||\|$/g, "")) {
    if (char === "`") inCode = !inCode;
    if (char === "|" && !inCode) cells.push("");
    else cells[cells.length - 1] += char;
  }
  return cells.map((cell) => cell.trim());
}

/**
 * 지도 본문을 판정 단위로 나눈다. 표의 머리 행·구분 행과 코드 블록은 건너뛴다.
 * @returns {Generator<{ line: number, cells: { text: string, testColumn: boolean }[] }>}
 */
function* unitsOf(text) {
  let fenced = false;
  let header;
  let testColumn = -1;
  for (const [index, line] of text.split("\n").entries()) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || /^\s*```/.test(line)) continue;
    if (!line.trimStart().startsWith("|")) {
      header = undefined;
      yield { line: index + 1, cells: [{ text: line, testColumn: false }] };
      continue;
    }
    if (header === undefined) {
      header = splitRow(line);
      continue;
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      testColumn = header.indexOf("테스트");
      continue;
    }
    yield {
      line: index + 1,
      cells: splitRow(line).map((cell, column) => ({
        text: cell,
        testColumn: column === testColumn,
      })),
    };
  }
}

/** 칸 하나의 링크 대상·파일 표기·이름·시험 이름. */
function readCell({ text, testColumn }) {
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => target.split("#")[0]);
  const plain = text
    .replace(/`[^`]*`/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ");
  const notations = plain.match(fileInText) ?? [];
  const names = [];
  const testNames = [];
  for (const [, span] of text.matchAll(/`([^`]+)`/g)) {
    if (fileNotation.test(span)) notations.push(span);
    else if (namePattern.test(span)) names.push(namePattern.exec(span)[1]);
    else if (testColumn && !/[/*]/.test(span)) testNames.push(span);
  }
  return { links, notations, names, testNames };
}

/**
 * 저장소 파일 목록(저장소 기준 경로)으로 코드 지도를 검사하고 문제 줄을 돌려준다. 목록에 있어도 작업 트리에서 지운 파일과
 * 일반 파일이 아닌 것(Git이 파일 하나로 적는 폴더 링크)은 뺀다.
 * @param {{ root: string, files: string[] }} options
 * @returns {string[]}
 */
export function findCodeMapProblems({ root, files }) {
  const present = files
    .filter((file) =>
      fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()
    )
    .sort();
  const codeFiles = present.filter((file) => !file.endsWith(".md"));
  const isCodeFile = new Set(codeFiles);
  const testFiles = codeFiles.filter((file) => isTestFile(file));

  const contents = new Map();
  const read = (file) => {
    if (!contents.has(file))
      contents.set(file, fs.readFileSync(path.join(root, file), "utf8"));
    return contents.get(file);
  };
  const resolve = (notation) =>
    codeFiles.filter((file) =>
      [file, shortForm(file)].some(
        (form) => form === notation || form.endsWith(`/${notation}`)
      )
    );
  const contains = (file, name) => {
    const boundary = name.includes("-") ? "[\\w$-]" : "[\\w$]";
    const hasWord = (word) =>
      new RegExp(`(?<!${boundary})${escapeRegExp(word)}(?!${boundary})`).test(
        read(file)
      );
    return (
      hasWord(name) || (name.includes(".") && name.split(".").every(hasWord))
    );
  };

  const problems = [];
  for (const mapFile of present.filter(isCodeMapFile)) {
    const folder = path.dirname(path.join(root, mapFile));
    for (const unit of unitsOf(read(mapFile))) {
      const where = `${mapFile}:${unit.line}`;
      const pointed = new Set();
      const pointedTests = new Set();
      const names = [];
      const testNames = [];
      for (const cell of unit.cells) {
        const found = readCell(cell);
        names.push(...found.names);
        testNames.push(...found.testNames);
        const cellFiles = found.links
          .map((target) =>
            path
              .relative(root, path.resolve(folder, target))
              .split(path.sep)
              .join("/")
          )
          .filter((file) => isCodeFile.has(file));
        for (const notation of found.notations) {
          const matches = resolve(notation);
          if (matches.length === 1) cellFiles.push(matches[0]);
          else if (matches.length === 0)
            problems.push(
              `${where}: 맞는 파일이 없는 파일 표기 \`${notation}\``
            );
          else
            problems.push(
              `${where}: 여러 파일과 맞는 파일 표기 \`${notation}\`: ${matches.join(", ")} — 경로를 더 적어 하나로 좁히세요`
            );
        }
        for (const file of cellFiles) {
          pointed.add(file);
          if (isTestFile(file)) pointedTests.add(file);
        }
      }

      for (const name of names) {
        const scope = pointed.size ? [...pointed] : codeFiles;
        if (scope.some((file) => contains(file, name))) continue;
        problems.push(
          pointed.size
            ? `${where}: 없는 이름 \`${name}\` — 이 줄이 가리키는 파일: ${scope.join(", ")}`
            : `${where}: 없는 이름 \`${name}\` — 저장소 코드 전체에서 찾음`
        );
      }
      for (const testName of testNames) {
        const scope = pointedTests.size ? [...pointedTests] : testFiles;
        const literal = testName.replace(/…$/, "");
        if (scope.some((file) => read(file).includes(literal))) continue;
        problems.push(
          pointedTests.size
            ? `${where}: 없는 시험 이름 \`${testName}\` — 이 줄이 가리키는 시험 파일: ${scope.join(", ")}`
            : `${where}: 없는 시험 이름 \`${testName}\` — 저장소 시험 파일 전체에서 찾음`
        );
      }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // check-project.mjs처럼 Git이 아는 파일만 본다. 무시된 worktree·캐시 폴더의 같은 이름을 찾은 것으로 치지 않는다.
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" }
  )
    .split("\0")
    .filter(Boolean);
  const problems = findCodeMapProblems({ root, files });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(
      `코드 지도에서 문제 ${problems.length}개를 찾았습니다. 지도를 코드에 맞게 고치세요(규칙: scripts/check-code-map.mjs 머리말).`
    );
    process.exitCode = 1;
  } else
    console.log(
      "Checked file notations, names and test names in the code map. No product functionality was tested."
    );
}
