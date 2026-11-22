// 코드 지도(docs/agents/code-map.md와 docs/agents/code-map/의 절 파일)가 가리키는 파일·이름이 저장소에 있는지 확인한다(#250).
// 링크가 열리는지는 check-project.mjs가 본다. 여기서는 링크 밖의 짧은 파일 표기와 코드 표기(백틱)의 이름을 본다.
// 판정 단위는 줄 하나(표의 행, 문단의 줄)이고 코드 블록(```)은 보지 않는다. 표기마다 예외를 두지 않고 아래 규칙만 쓴다.
// - 파일 표기: 확장자로 끝나는 경로(`core/run.ts`, `rows.ts`, `docs/providers.md`). 저장소 경로, 또는 `packages/<이름>/`·
//   `apps/<이름>/` 뒤의 `src/`·`test/`·`e2e/`를 뺀 짧은 경로(`packages/core/src/run.ts` → `core/run.ts`)의 끝과 맞는 파일 하나로
//   푼다. 맞는 파일이 없거나 둘 이상이면 실패한다. Markdown 파일은 있는지만 보고 이름을 찾는 곳에 넣지 않는다.
// - 패키지 지정자(`@babojubot/process/remove-folder`): workspace 패키지(뿌리·`packages/*`·`apps/*`의 package.json)면 그 입구가
//   `exports`에 있어야 한다(`*` 무늬 포함, `exports`가 없으면 그 경로의 파일). workspace 패키지가 아니면 어느 package.json이든
//   의존성으로 적혀 있어야 한다.
// - pnpm 명령(`pnpm check:docs`, `pnpm --filter <패키지> run <스크립트>`): 돌리는 스크립트가 대상 package.json(`--filter`가 없으면
//   뿌리)의 `scripts`에 있어야 한다. pnpm 자체 명령(`pnpm install`, `pnpm exec …`)과 모든 패키지에 도는 `-r`은 보지 않는다.
// - 이름: 식별자 모양(영문·숫자·`_`·`$`, `-`로 이은 낱말, `.`로 이은 조각, 앞의 `#`, 뒤의 호출 괄호)의 코드 표기. 그 줄이 가리키는
//   파일(링크·파일 표기)이 그 이름을 정의해야 하고(definitionsOf), 줄에 파일이 없으면 Markdown이 아닌 저장소 파일 전체의 정의에서
//   찾는다. 정의는 선언(함수·클래스·인터페이스·타입·변수·enum 멤버, export 여부 무관)과 객체·클래스·인터페이스·객체 타입의 속성·메서드,
//   JSX 속성, 환경 변수를 읽는 자리, 문자열 리터럴(상태 값·오류 코드)이다. 주석, 다른 낱말의 일부, 가져오기·부르기만 한 이름은 아니다.
//   `a.b`는 클래스·인터페이스·객체 상수·타입·enum의 경로(`RunDispatcher.handled`)이거나 글자 그대로의 문자열(`message.created`)이다.
// - 시험 이름: 표의 `테스트` 열에서 파일 표기·패키지 지정자·pnpm 명령이 아니고 `/`·`*`가 없는 코드 표기. 그 줄이 가리키는 시험 파일의
//   `describe`·`it`·`test` 제목과 같아야 하고(끝의 `…`는 앞부분만 본다), 줄에 시험 파일이 없으면 저장소의 시험 파일 전체에서 찾는다.
//   이 열의 식별자 모양 표기는 시험 도움 이름도 적히므로 시험 제목이거나 그 줄의 파일이 정의한 이름이면 된다.
// - 그 밖의 코드 표기(한글·공백·따옴표가 든 문구, 경로, pnpm 밖 명령, `*`)는 보지 않는다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parseAllDocuments } from "yaml";
import { isTestFile } from "./test-files.mjs";

const extensions =
  "ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|sql|css|html|sh|ps1|patch|md";
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

const scriptKinds = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);
/** 구문 분석기가 없는 파일에서 지울 주석(파일 확장자별). */
const comments = new Map([
  [".css", [/\/\*[\s\S]*?\*\//g]],
  [".sql", [/\/\*[\s\S]*?\*\//g, /--.*$/gm]],
  [".cs", [/\/\*[\s\S]*?\*\//g, /\/\/.*$/gm]],
  [".sh", [/(^|\s)#.*$/gm]],
  [".ps1", [/<#[\s\S]*?#>/g, /(^|\s)#.*$/gm]],
  [".html", [/<!--[\s\S]*?-->/g]],
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
  const extension = path.extname(file);
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

  if (scriptKinds.has(extension) || extension === ".json") {
    const source =
      extension === ".json"
        ? ts.parseJsonText(file, text)
        : ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            false,
            scriptKinds.get(extension)
          );
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
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
  if (extension === ".yml" || extension === ".yaml") {
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
  for (const pattern of comments.get(extension) ?? [])
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
  const titlesOrNames = [];
  const specifiers = [];
  const commands = [];
  for (const [, span] of text.matchAll(/`([^`]+)`/g)) {
    if (fileNotation.test(span)) notations.push(span);
    else if (packageSpecifier.test(span)) specifiers.push(span);
    else if (/^pnpm\s/.test(span)) commands.push(span);
    else if (testColumn && namePattern.test(span))
      // `테스트` 열에는 시험 제목과 시험 도움 이름이 함께 적힌다.
      titlesOrNames.push(namePattern.exec(span)[1]);
    else if (namePattern.test(span)) names.push(namePattern.exec(span)[1]);
    else if (testColumn && !/[/*]/.test(span)) testNames.push(span);
  }
  return {
    links,
    notations,
    names,
    testNames,
    titlesOrNames,
    specifiers,
    commands,
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
  const manifests = readManifests(present, read);
  const presentFiles = new Set(present);
  const resolve = (notation) =>
    present.filter((file) =>
      [file, shortForm(file)].some(
        (form) => form === notation || form.endsWith(`/${notation}`)
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
        const found = readCell(cell);
        names.push(...found.names);
        testNames.push(...found.testNames);
        titlesOrNames.push(...found.titlesOrNames);
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
        for (const specifier of found.specifiers) {
          const problem = specifierProblem(specifier);
          if (problem) problems.push(`${where}: ${problem}`);
        }
        for (const command of found.commands) {
          const problem = commandProblem(command);
          if (problem)
            problems.push(
              `${where}: 없는 pnpm 스크립트 \`${command}\` — ${problem}`
            );
        }
      }

      for (const name of names) {
        const scope = pointed.size ? [...pointed] : codeFiles;
        if (scope.some((file) => defines(definitions(file), name))) continue;
        problems.push(
          pointed.size
            ? `${where}: 없는 이름 \`${name}\` — 이 줄이 가리키는 파일: ${scope.join(", ")}`
            : `${where}: 없는 이름 \`${name}\` — 저장소 코드 전체에서 찾음`
        );
      }
      const titleScope = pointedTests.size ? [...pointedTests] : testFiles;
      const hasTitle = (testName) => {
        const literal = testName.replace(/…$/, "");
        const titled = (title) =>
          testName.endsWith("…")
            ? title.startsWith(literal)
            : title === literal;
        return titleScope.some((file) =>
          [...definitions(file).titles].some(titled)
        );
      };
      for (const name of titlesOrNames) {
        const scope = pointed.size ? [...pointed] : codeFiles;
        if (
          hasTitle(name) ||
          scope.some((file) => defines(definitions(file), name))
        )
          continue;
        problems.push(
          pointed.size
            ? `${where}: 없는 시험 이름·이름 \`${name}\` — 이 줄이 가리키는 파일: ${scope.join(", ")}`
            : `${where}: 없는 시험 이름·이름 \`${name}\` — 저장소 코드 전체에서 찾음`
        );
      }
      for (const testName of testNames) {
        const scope = titleScope;
        if (hasTitle(testName)) continue;
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
      "Checked file notations, names, test names, package entries and pnpm scripts in the code map. No product functionality was tested."
    );
}
