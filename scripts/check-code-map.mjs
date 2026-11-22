// 코드 지도(docs/agents/code-map.md와 docs/agents/code-map/의 절 파일)가 가리키는 파일·이름이 저장소에 있는지 확인한다(#250).
// 링크가 열리는지는 check-project.mjs가 본다. 여기서는 링크 밖의 짧은 파일 표기와 코드 표기(백틱)를 본다.
// Markdown은 CommonMark 0.31.2(https://spec.commonmark.org/0.31.2/)와 GFM 표(https://github.github.com/gfm/#tables-extension-)대로
// 읽는다: 펜스 코드 블록(§4.5)·들여쓰기 코드 블록(§4.4)은 보지 않고, 코드 스팬은 같은 길이의 백틱 줄로 닫으며(§6.1), 표 칸은
// 이스케이프하지 않은 `|`로 나눈다. 판정 단위는 줄 하나(표의 행, 문단의 줄)다.
// 코드 표기는 아래 순서로 한 갈래에 넣고, 어느 갈래에도 맞지 않으면 실패한다. 표기마다 예외를 두지 않는다.
// - 파일 표기: 마지막 조각이 `이름.확장자`인 경로. 확장자는 저장소가 추적하는 파일의 확장자와 이 검사가 읽을 줄 아는 확장자
//   (languages)다. 백틱 밖 글에서도 같은 판정으로 찾는다. 저장소 경로, 또는 `packages/<이름>/`·`apps/<이름>/` 뒤의
//   `src/`·`test/`·`e2e/`를 뺀 짧은 경로(`packages/core/src/run.ts` → `core/run.ts`)의 끝과 맞는 파일 하나로 푼다.
//   맞는 파일이 없거나 둘 이상이면 실패한다. Markdown 파일은 있는지만 보고 이름을 찾는 곳에 넣지 않는다.
// - 폴더 표기: `/`로 끝나는 경로(`scripts/`). 그 경로 아래에 추적 파일이 있어야 한다.
// - 패키지: `@범위/이름[/입구]`, 또는 어느 package.json이 의존성으로 적은 이름(`typescript`). workspace 패키지(뿌리·`packages/*`·
//   `apps/*`)면 그 입구가 `exports`에 있어야 하고(`*` 무늬 포함, `exports`가 없으면 그 경로의 파일), 아니면 의존성으로 적혀 있어야 한다.
// - pnpm 명령(`pnpm check:docs`, `pnpm --filter <패키지> run <스크립트>`): 돌리는 스크립트가 대상 package.json(`--filter`가 없으면
//   뿌리)의 `scripts`에 있어야 한다. pnpm 자체 명령(`pnpm install`, `pnpm exec …`)과 모든 패키지에 도는 `-r`은 보지 않는다.
// - 이름: 식별자 모양(영문·숫자·`_`·`$`, `-`로 이은 낱말, `.`로 이은 조각, 앞의 `#`, 뒤의 호출 괄호)의 코드 표기. 그 줄이 가리키는
//   파일(링크·파일 표기)이 그 이름을 정의해야 하고(definitionsOf), 줄에 파일이 없으면 저장소 소스 코드(languages의 source) 전체의
//   정의에서 찾는다. 설정·잠금·데이터 파일(JSON·YAML 등)의 이름은 그 파일을 같은 줄에서 가리킬 때만 받는다. 정의는 선언(함수·클래스·
//   인터페이스·타입·변수·enum 멤버, export 여부 무관)과 객체·클래스·인터페이스·객체 타입의 속성·메서드, JSX 속성, 환경 변수를 읽는
//   자리, 문자열 리터럴(상태 값·오류 코드, 모듈 경로 문자열은 뺌)이다. 주석, 다른 낱말의 일부, 가져오기·부르기만 한 이름은 아니다.
//   `a.b`는 클래스·인터페이스·객체 상수·타입·enum의 경로(`RunDispatcher.handled`)이거나 글자 그대로의 문자열(`message.created`)이다.
// - 시험 이름: 표의 `테스트` 열의 나머지 표기. 그 줄이 가리키는 시험 파일의 `describe`·`it`·`test` 제목과 같아야 하고(끝의 `…`는
//   앞부분만 본다), 줄에 시험 파일이 없으면 저장소의 시험 파일 전체에서 찾는다. 이 열의 식별자 모양 표기는 시험 도움 이름도 적히므로
//   시험 제목이거나 그 줄의 파일이 정의한 이름이면 된다.
// - 제외 규칙(보지 않음): 문구(공백·ASCII 밖 글자·따옴표·백틱), HTTP 경로(`/`로 시작), 무늬(`*`·`{`), 점·대시로 시작하는 표기
//   (CSS 선택자·사용자 속성, 확장자, 메서드 표시), 영문·숫자가 없는 기호.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parseAllDocuments } from "yaml";
import { isTestFile } from "./test-files.mjs";

const segment = "[A-Za-z_$#][\\w$]*(?:-[\\w$]+)*";
const namePattern = new RegExp(
  `^(${segment}(?:\\.${segment})*)(?:\\((?:[^()]|\\([^()]*\\))*\\))?$`
);
const packageSpecifier = /^(@[\w.-]+\/[\w.-]+)(?:\/([\w./-]+))?$/;
/** `pnpm <이름>`이 스크립트가 아니라 pnpm 자체 명령인 이름(https://pnpm.io/cli/run). */
const pnpmCommands = new Set(
  (
    "add approve-builds audit bin cache cat-file cat-index config create dedupe deploy dlx doctor env exec fetch " +
    "find-hash help i ignored-builds import init install install-test it licenses link list ln ls outdated pack " +
    "patch patch-commit patch-remove prune publish rb rebuild remove rm root self-update server setup store un " +
    "uninstall unlink up update why"
  ).split(" ")
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

/**
 * 정의를 읽는 법을 아는 파일 종류(확장자별). script: TypeScript 구문 트리, json: TypeScript JSON 구문 트리, yaml: yaml,
 * comments: 지울 주석 문법(구문 분석기가 없는 소스). source: 줄에 파일이 없을 때 이름을 찾는 소스 코드인가.
 */
const languages = new Map([
  [".ts", { script: ts.ScriptKind.TS, source: true }],
  [".mts", { script: ts.ScriptKind.TS, source: true }],
  [".cts", { script: ts.ScriptKind.TS, source: true }],
  [".tsx", { script: ts.ScriptKind.TSX, source: true }],
  [".js", { script: ts.ScriptKind.JS, source: true }],
  [".mjs", { script: ts.ScriptKind.JS, source: true }],
  [".cjs", { script: ts.ScriptKind.JS, source: true }],
  [".jsx", { script: ts.ScriptKind.JSX, source: true }],
  [".json", { json: true, source: false }],
  [".yml", { yaml: true, source: false }],
  [".yaml", { yaml: true, source: false }],
  [".css", { comments: [/\/\*[\s\S]*?\*\//g], source: true }],
  [".sql", { comments: [/\/\*[\s\S]*?\*\//g, /--.*$/gm], source: true }],
  [".cs", { comments: [/\/\*[\s\S]*?\*\//g, /\/\/.*$/gm], source: true }],
  [".sh", { comments: [/(^|\s)#.*$/gm], source: true }],
  [".ps1", { comments: [/<#[\s\S]*?#>/g, /(^|\s)#.*$/gm], source: true }],
  [".html", { comments: [/<!--[\s\S]*?-->/g], source: true }],
]);
const titleCallees = new Set(["describe", "it", "test", "suite"]);

/** 이름(식별자·비공개 이름·문자열·숫자). 계산한 이름(`[key]`)은 없다. */
function textOf(name) {
  if (
    name &&
    (ts.isIdentifier(name) ||
      ts.isPrivateIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name) ||
      ts.isNoSubstitutionTemplateLiteral(name))
  )
    return name.text;
  return undefined;
}

function unwrap(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  )
    current = current.expression;
  return current;
}

/** 경로의 다음 조각이 되는 멤버 목록(객체 리터럴·타입 리터럴·클래스·인터페이스·enum). */
function membersOf(node) {
  if (!node) return undefined;
  if (
    ts.isClassLike(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeLiteralNode(node)
  )
    return node.members;
  if (ts.isTypeAliasDeclaration(node)) return membersOf(node.type);
  if (ts.isObjectLiteralExpression(node)) return node.properties;
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    const value = unwrap(node.initializer);
    if (
      value &&
      (ts.isObjectLiteralExpression(value) || ts.isClassExpression(value))
    )
      return membersOf(value);
  }
  if (ts.isPropertySignature(node)) return membersOf(node.type);
  return undefined;
}

/** 부른 함수의 맨 앞 이름(`describe.skipIf(x)("…")` → `describe`). */
function calleeRoot(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current))
    current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

/**
 * 파일 하나가 정의하는 이름. names: 선언·멤버 이름과 환경 변수를 읽는 자리, paths: `컨테이너.멤버` 경로, strings: 문자열 리터럴,
 * titles: `describe`·`it`·`test` 제목. TS·JS·JSON은 TypeScript 구문 트리로, YAML은 yaml로 읽고, 그 밖의 파일은 주석을 지운 낱말이다.
 */
export function definitionsOf(file, text) {
  const found = {
    names: new Set(),
    paths: new Set(),
    strings: new Set(),
    titles: new Set(),
  };
  const language = languages.get(path.extname(file)) ?? {};
  const addMembers = (prefix, members) => {
    for (const member of members ?? []) {
      // 생성자의 매개변수 속성(`constructor(private readonly clock)`)은 클래스 멤버다.
      if (ts.isConstructorDeclaration(member))
        addMembers(
          prefix,
          member.parameters.filter(
            (parameter) => ts.getModifiers(parameter)?.length
          )
        );
      const name = textOf(member.name);
      if (name === undefined) continue;
      const full = prefix ? `${prefix}.${name}` : name;
      found.names.add(name);
      found.paths.add(full);
      addMembers(full, membersOf(member));
    }
  };
  const addBindings = (binding) => {
    if (ts.isIdentifier(binding)) found.names.add(binding.text);
    else
      for (const element of binding.elements)
        if (!ts.isOmittedExpression(element)) addBindings(element.name);
  };
  const addValue = (prefix, value) => {
    if (typeof value === "string") found.strings.add(value);
    else if (Array.isArray(value))
      for (const item of value) addValue(prefix, item);
    else if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value)) {
        const full = prefix ? `${prefix}.${key}` : key;
        found.names.add(key);
        found.paths.add(full);
        addValue(full, inner);
      }
  };

  if (language.script !== undefined || language.json) {
    const source = language.json
      ? ts.parseJsonText(file, text)
      : ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          false,
          language.script
        );
    // 모듈 경로 문자열(`import … from "x"`, `import("x")`, `require("x")`, `import x = require("x")`, `import("x").T`)은 정의가 아니다.
    const moduleSpecifiers = new Set();
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        moduleSpecifiers.add(node.moduleSpecifier);
      else if (ts.isExternalModuleReference(node))
        moduleSpecifiers.add(node.expression);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        moduleSpecifiers.add(node.argument.literal);
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      )
        moduleSpecifiers.add(node.arguments[0]);
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        !moduleSpecifiers.has(node)
      )
        found.strings.add(node.text);
      if (
        (ts.isFunctionLike(node) || ts.isClassLike(node)) &&
        !ts.isMethodDeclaration(node) &&
        !ts.isMethodSignature(node)
      ) {
        const name = textOf(node.name);
        if (name !== undefined) found.names.add(name);
      }
      if (
        ts.isClassLike(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
      ) {
        const name = textOf(node.name);
        if (name !== undefined) found.names.add(name);
        addMembers(name ?? "", membersOf(node));
      } else if (ts.isVariableDeclaration(node)) {
        addBindings(node.name);
        if (ts.isIdentifier(node.name))
          addMembers(node.name.text, membersOf(node));
      } else if (
        ts.isObjectLiteralExpression(node) ||
        ts.isTypeLiteralNode(node)
      )
        // 이름 없는 자리(인자·매개변수 타입)의 객체도 속성 이름을 정의한다. 이름 있는 자리는 위에서 경로까지 모았다.
        addMembers("", membersOf(node));
      else if (ts.isJsxAttribute(node)) {
        // JSX 속성은 컴포넌트에 넘기는 props 객체의 속성이다.
        const name = textOf(node.name);
        if (name !== undefined) found.names.add(name);
      } else if (ts.isModuleDeclaration(node) || ts.isExportSpecifier(node)) {
        const name = textOf(node.name);
        if (name !== undefined) found.names.add(name);
      } else if (
        ts.isPropertyAccessExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === "env") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "env"))
      )
        // 환경 변수는 선언이 없고 읽는 자리가 정의다(`process.env.BABOJUBOT_PROVIDERS`).
        found.names.add(node.name.text);
      else if (
        ts.isCallExpression(node) &&
        titleCallees.has(calleeRoot(node.expression) ?? "")
      ) {
        const title = node.arguments[0] && textOf(node.arguments[0]);
        if (title !== undefined) found.titles.add(title);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }
  if (language.yaml) {
    for (const document of parseAllDocuments(text)) {
      if (document.errors.length)
        throw new Error(`${file}: YAML을 읽지 못했다`, {
          cause: document.errors[0],
        });
      addValue("", document.toJS());
    }
    return found;
  }
  let body = text;
  for (const pattern of language.comments ?? [])
    body = body.replace(pattern, "$1");
  for (const word of body.match(/[A-Za-z_$#][\w$-]*/g) ?? [])
    found.names.add(word.replace(/-+$/, ""));
  return found;
}

function defines(definitions, name) {
  return (
    definitions.strings.has(name) ||
    (name.includes(".")
      ? definitions.paths.has(name)
      : definitions.names.has(name))
  );
}

/**
 * 코드 스팬(CommonMark §6.1)을 꺼내고 그 자리를 비운 글을 돌려준다. 백틱 n개로 연 스팬은 정확히 n개인 백틱 줄로 닫고, 닫히지 않은
 * 백틱은 글자다. 스팬 밖의 `\``는 이스케이프한 백틱이다(§2.4). 스팬 안의 앞뒤 공백 하나씩은 양쪽에 다 있고 공백만이 아닐 때 뺀다.
 */
function codeSpans(text) {
  const spans = [];
  let plain = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && /[!-/:-@[-`{-~]/.test(text[index + 1] ?? "")) {
      plain += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (text[index] !== "`") {
      plain += text[index];
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === "`") end += 1;
    const length = end - index;
    let close = end;
    let found = -1;
    while (close < text.length) {
      if (text[close] !== "`") {
        close += 1;
        continue;
      }
      let after = close;
      while (text[after] === "`") after += 1;
      if (after - close === length) {
        found = close;
        break;
      }
      close = after;
    }
    if (found < 0) {
      plain += text.slice(index, end);
      index = end;
      continue;
    }
    let content = text.slice(end, found);
    if (/^ [\s\S]* $/.test(content) && /[^ ]/.test(content))
      content = content.slice(1, -1);
    spans.push(content);
    plain += " ";
    index = found + length;
  }
  return { spans, plain };
}

/** GFM 표의 한 행을 칸으로 나눈다. 이스케이프한 `\|`는 칸 구분이 아니라 글자 `|`다(코드 스팬 안도 같다). */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [""];
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "\\" && row[index + 1] === "|") {
      cells[cells.length - 1] += "|";
      index += 1;
    } else if (row[index] === "|") cells.push("");
    else cells[cells.length - 1] += row[index];
  }
  return cells.map((cell) => cell.trim());
}

const delimiterRow = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 줄 앞 공백의 열 수(탭은 다음 4의 배수 열까지, CommonMark §2.2). */
function indentOf(line) {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * 지도 본문을 판정 단위로 나눈다(CommonMark·GFM). 코드 블록, 표의 머리 행·구분 행, 빈 줄은 건너뛴다. 목록 항목(§5.2) 안에서는
 * 항목 내용의 열을 기준으로 들여쓰기를 잰다. 들여쓰기 코드 블록은 문단을 끊지 못한다(§4.4).
 * @returns {Generator<{ line: number, cells: { text: string, testColumn: boolean }[] }>}
 */
function* unitsOf(text) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  let fence;
  let listIndent = 0;
  let previous = "blank";
  let table;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = indentOf(line);
    if (fence) {
      const closing = /^[ \t]*(`+|~+)[ \t]*$/.exec(line);
      if (
        closing &&
        indent - listIndent <= 3 &&
        closing[1][0] === fence.char &&
        closing[1].length >= fence.length
      )
        fence = undefined;
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      previous = "blank";
      table = undefined;
      continue;
    }
    const item = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(line);
    if (item && indent - listIndent <= 3)
      listIndent =
        indentOf(item[1]) +
        item[2].length +
        (item[3].length >= 1 && item[3].length <= 4 ? item[3].length : 1);
    else if (indent < listIndent && previous !== "paragraph") listIndent = 0;
    const relative = item ? 0 : indent - listIndent;
    if (relative >= 4 && previous !== "paragraph") {
      previous = "code";
      continue;
    }
    const opening = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (
      opening &&
      relative <= 3 &&
      !(opening[1][0] === "`" && opening[2].includes("`"))
    ) {
      fence = { char: opening[1][0], length: opening[1].length };
      previous = "other";
      table = undefined;
      continue;
    }
    if (table) {
      yield {
        line: index + 1,
        cells: splitRow(line).map((cell, column) => ({
          text: cell,
          testColumn: column === table.testColumn,
        })),
      };
      continue;
    }
    const next = lines[index + 1];
    if (
      line.includes("|") &&
      next !== undefined &&
      next.includes("|") &&
      delimiterRow.test(next) &&
      splitRow(line).length === splitRow(next).length
    ) {
      table = { testColumn: splitRow(line).indexOf("테스트") };
      previous = "other";
      index += 1;
      continue;
    }
    previous = /^[ \t]*#{1,6}([ \t]|$)/.test(line) ? "other" : "paragraph";
    yield { line: index + 1, cells: [{ text: line, testColumn: false }] };
  }
}

/** 칸 하나의 링크 대상과 링크 밖 글, 코드 표기. */
function readCell({ text, testColumn }) {
  const { spans, plain } = codeSpans(text);
  const links = [...plain.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => target.split("#")[0]);
  return {
    links,
    text: plain.replace(/\[[^\]]*\]\([^)]*\)/g, " "),
    spans,
    testColumn,
  };
}

/** workspace의 package.json(뿌리·`packages/*`·`apps/*`)과 어느 package.json이든 의존성으로 적은 패키지 이름. */
function readManifests(present, read) {
  const manifests = present
    .filter((file) =>
      /^(?:(?:packages|apps)\/[^/]+\/)?package\.json$/.test(file)
    )
    .map((file) => ({ file, json: JSON.parse(read(file)) }));
  const declared = new Set(
    manifests.flatMap(({ json }) =>
      [
        json.dependencies,
        json.devDependencies,
        json.peerDependencies,
        json.optionalDependencies,
      ].flatMap((dependencies) => Object.keys(dependencies ?? {}))
    )
  );
  return {
    root: manifests.find(({ file }) => file === "package.json"),
    byName: new Map(
      manifests.map((manifest) => [manifest.json.name, manifest])
    ),
    declared,
  };
}

/** package.json `exports`의 입구 이름(`.`, `./testing`, `./fixtures/*`). 조건만 적은 객체와 문자열은 `.` 하나다. */
function exportEntries(exports) {
  if (exports === null || typeof exports !== "object" || Array.isArray(exports))
    return ["."];
  const keys = Object.keys(exports);
  return keys.some((key) => key.startsWith(".")) ? keys : ["."];
}

function matchesEntry(entry, key) {
  if (!key.includes("*")) return entry === key;
  const [prefix, suffix] = key.split("*");
  return (
    entry.length > prefix.length + suffix.length &&
    entry.startsWith(prefix) &&
    entry.endsWith(suffix)
  );
}

/** 정규식 안에 글자 그대로 넣는다. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 제외 규칙의 갈래. 어느 갈래에도 맞지 않으면 undefined. */
function exclusionOf(span) {
  if (/[\s"'`]|[^ -~]/.test(span)) return "문구";
  if (span.startsWith("/")) return "HTTP 경로";
  if (/[*{]/.test(span)) return "무늬";
  if (/^[.-]/.test(span)) return "점·대시로 시작";
  if (!/[A-Za-z0-9]/.test(span)) return "기호만";
  return undefined;
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
  const presentFiles = new Set(present);
  // Markdown 밖 파일은 줄이 가리키면 그 정의를 읽는다. 줄이 아무 파일도 가리키지 않을 때는 소스 코드만 찾는다.
  const isCodeFile = new Set(present.filter((file) => !file.endsWith(".md")));
  const sourceFiles = present.filter(
    (file) => languages.get(path.extname(file))?.source
  );
  const testFiles = sourceFiles.filter((file) => isTestFile(file));

  // 파일 표기 판정은 이 한 곳이다: 마지막 조각이 `이름.확장자`이고 확장자가 추적 파일의 것이거나 읽을 줄 아는 것.
  const extensions = [
    ...new Set([
      ...present.map((file) => path.extname(file).slice(1)).filter(Boolean),
      ...[...languages.keys()].map((extension) => extension.slice(1)),
    ]),
  ].sort((a, b) => b.length - a.length);
  const fileShape = `(?:[\\w.-]+/)*[\\w.-]*[\\w-]\\.(?:${extensions.map(literal).join("|")})`;
  const fileNotation = new RegExp(`^${fileShape}$`);
  const fileInText = new RegExp(`(?<![\\w./@-])${fileShape}(?![\\w/-])`, "g");
  const folderNotation = /^(?:[\w.-]+\/)+$/;

  const contents = new Map();
  const read = (file) => {
    if (!contents.has(file))
      contents.set(file, fs.readFileSync(path.join(root, file), "utf8"));
    return contents.get(file);
  };
  const manifests = readManifests(present, read);
  const forms = (file) => [file, shortForm(file)];
  const resolve = (notation) =>
    present.filter((file) =>
      forms(file).some(
        (form) => form === notation || form.endsWith(`/${notation}`)
      )
    );
  const folderExists = (notation) =>
    present.some((file) =>
      forms(file).some(
        (form) => form.startsWith(notation) || form.includes(`/${notation}`)
      )
    );
  const definitionCache = new Map();
  const definitions = (file) => {
    if (!definitionCache.has(file))
      definitionCache.set(file, definitionsOf(file, read(file)));
    return definitionCache.get(file);
  };

  const specifierProblem = (specifier) => {
    const [, name, subpath] = packageSpecifier.exec(specifier);
    const manifest = manifests.byName.get(name);
    if (!manifest)
      return manifests.declared.has(name)
        ? undefined
        : `없는 패키지 \`${specifier}\` — workspace 패키지가 아니고 어느 package.json에도 의존성으로 없음`;
    if (manifest.json.exports === undefined) {
      const file = path.posix.join(
        path.posix.dirname(manifest.file),
        subpath ?? ""
      );
      if (subpath === undefined || presentFiles.has(file)) return undefined;
      return `없는 패키지 입구 \`${specifier}\` — ${manifest.file}에 exports가 없고 ${file} 파일도 없음`;
    }
    const entries = exportEntries(manifest.json.exports);
    const entry = subpath === undefined ? "." : `./${subpath}`;
    if (entries.some((key) => matchesEntry(entry, key))) return undefined;
    return `없는 패키지 입구 \`${specifier}\` — ${manifest.file}의 exports: ${entries.join(", ")}`;
  };
  const commandProblem = (command) => {
    const words = command.split(/\s+/).slice(1);
    const filters = [];
    while (words[0]?.startsWith("-")) {
      const flag = words.shift();
      if (flag === "-r" || flag === "--recursive") return undefined;
      if (flag === "--filter" || flag === "-F") filters.push(words.shift());
      else if (flag.startsWith("--filter=")) filters.push(flag.slice(9));
    }
    const [first, second] = words;
    const script = first === "run" ? second : first;
    if (script === undefined || (first !== "run" && pnpmCommands.has(first)))
      return undefined;
    for (const target of filters.length ? filters : [undefined]) {
      const manifest =
        target === undefined ? manifests.root : manifests.byName.get(target);
      if (!manifest)
        return target === undefined
          ? "뿌리 package.json 없음"
          : `workspace 패키지 ${target} 없음`;
      if (!Object.hasOwn(manifest.json.scripts ?? {}, script))
        return `${manifest.file}의 scripts에 ${script} 없음`;
    }
    return undefined;
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
      const titlesOrNames = [];
      for (const cell of unit.cells) {
        const { links, text, spans, testColumn } = readCell(cell);
        const notations = text.match(fileInText) ?? [];
        // 코드 표기를 한 갈래에 넣는다. 순서: 파일 → 폴더 → 패키지 → pnpm 명령 → (테스트 열) 시험 제목 → 이름 → 제외 → 실패.
        for (const span of spans) {
          const name = namePattern.exec(span)?.[1];
          if (fileNotation.test(span)) notations.push(span);
          else if (folderNotation.test(span)) {
            if (!folderExists(span))
              problems.push(`${where}: 맞는 폴더가 없는 폴더 표기 \`${span}\``);
          } else if (packageSpecifier.test(span)) {
            const problem = specifierProblem(span);
            if (problem) problems.push(`${where}: ${problem}`);
          } else if (/^pnpm\s/.test(span)) {
            const problem = commandProblem(span);
            if (problem)
              problems.push(
                `${where}: 없는 pnpm 스크립트 \`${span}\` — ${problem}`
              );
          } else if (span === name && manifests.declared.has(span)) continue;
          else if (testColumn && name !== undefined) titlesOrNames.push(name);
          else if (
            testColumn &&
            [undefined, "문구"].includes(exclusionOf(span))
          )
            testNames.push(span);
          else if (name !== undefined) names.push(name);
          else if (exclusionOf(span) === undefined)
            problems.push(
              `${where}: 분류할 수 없는 코드 표기 \`${span}\` — 파일·폴더·패키지·pnpm 명령·이름·제외 규칙(문구, HTTP 경로, 무늬, 점·대시로 시작, 기호만) 어디에도 맞지 않음`
            );
        }
        const cellFiles = links
          .map((target) =>
            path
              .relative(root, path.resolve(folder, target))
              .split(path.sep)
              .join("/")
          )
          .filter((file) => isCodeFile.has(file));
        for (const notation of notations) {
          const matches = resolve(notation);
          if (matches.length === 1) {
            if (isCodeFile.has(matches[0])) cellFiles.push(matches[0]);
          } else if (matches.length === 0)
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

      const nameScope = pointed.size ? [...pointed] : sourceFiles;
      const scopeText = pointed.size
        ? `이 줄이 가리키는 파일: ${nameScope.join(", ")}`
        : "저장소 소스 코드 전체에서 찾음";
      const defined = (name) =>
        nameScope.some((file) => defines(definitions(file), name));
      const titleScope = pointedTests.size ? [...pointedTests] : testFiles;
      const hasTitle = (testName) => {
        const start = testName.replace(/…$/, "");
        const titled = (title) =>
          testName.endsWith("…") ? title.startsWith(start) : title === start;
        return titleScope.some((file) =>
          [...definitions(file).titles].some(titled)
        );
      };
      for (const name of names)
        if (!defined(name))
          problems.push(`${where}: 없는 이름 \`${name}\` — ${scopeText}`);
      for (const name of titlesOrNames)
        if (!hasTitle(name) && !defined(name))
          problems.push(
            `${where}: 없는 시험 이름·이름 \`${name}\` — ${scopeText}`
          );
      for (const testName of testNames)
        if (!hasTitle(testName))
          problems.push(
            pointedTests.size
              ? `${where}: 없는 시험 이름 \`${testName}\` — 이 줄이 가리키는 시험 파일: ${titleScope.join(", ")}`
              : `${where}: 없는 시험 이름 \`${testName}\` — 저장소 시험 파일 전체에서 찾음`
          );
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
      "Checked file notations, names, test names, package entries and pnpm scripts in the code map. No product functionality was tested."
    );
}
