// 제품 코드 lint 규칙. 설정은 eslint.config.js의 `productFiles` 범위에 걸고, 개발 스크립트(`scriptFiles`)에도 그중 일부를 건다.
// 회귀 시험은 scripts/product-lint-rules.test.mjs와 scripts/script-lint-rules.test.mjs가 맡는다.
// `no-restricted-syntax`는 설정 블록끼리 덮어써서 서버·runtime의 기존 금지와 함께 걸 수 없으므로 규칙으로 둔다.
import {
  skippedCleanupIn,
  skippedSyncCleanupIn,
} from "./eslint-test-rules.mjs";

const wrappers = new Set([
  "AwaitExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

/** `await`·`?.`·`!`·단정을 벗긴 값. `x as unknown as T`도 안쪽의 `x`를 본다. */
function unwrap(node) {
  let value = node;
  while (wrappers.has(value.type))
    value =
      value.type === "AwaitExpression" ? value.argument : value.expression;
  return value;
}

/** `JSON.parse(...)`, 응답 본문 `x.json()`, 그 값에 기본값을 붙이거나 `.catch`·`.then`으로 이어 받은 값인가. */
function readsOutsideData(node) {
  const value = unwrap(node);
  if (value.type === "LogicalExpression")
    return readsOutsideData(value.left) || readsOutsideData(value.right);
  if (value.type !== "CallExpression") return false;
  const { callee } = value;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  switch (callee.property.name) {
    case "parse":
      return (
        callee.object.type === "Identifier" && callee.object.name === "JSON"
      );
    case "json":
      return true;
    case "catch":
      return readsOutsideData(callee.object);
    case "then": {
      const [callback] = value.arguments;
      return (
        callback?.type === "ArrowFunctionExpression" &&
        callback.body.type !== "BlockStatement" &&
        readsOutsideData(callback.body)
      );
    }
    default:
      return false;
  }
}

/**
 * 문자열을 JSON으로 읽은 결과나 응답 본문에 바로 타입을 단정하면 잘못된 입력이 타입을 믿는 코드까지 내려간다.
 * `as unknown`은 확인 전의 값이라는 뜻이므로 허용한다.
 * 알려진 한계: 읽는 호출에 바로 붙은 단정만 본다. 타입 없는 중간 변수, 조건식, 블록 본문이나 함수 이름으로 넘긴 콜백,
 * `globalThis.JSON`을 거친 값의 단정은 잡지 못하며 그 경우는 리뷰가 본다.
 */
const noAssertionOnParsedData = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow asserting a type directly on parsed JSON or a response body",
    },
    schema: [],
    messages: {
      asserted:
        "읽자마자 타입을 단정하면 잘못된 입력이 그대로 내려갑니다. `const value: unknown = ...`으로 받고 스키마(safeParse)나 필드 확인으로 좁히세요.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (node.typeAnnotation.type === "TSUnknownKeyword") return;
        if (readsOutsideData(node.expression))
          context.report({ node, messageId: "asserted" });
      },
    };
  },
};

const childProcess = new Set(["child_process", "node:child_process"]);
const syncLaunchers = new Set(["execFileSync", "spawnSync", "execSync"]);

/** 상한이 없다는 뜻인 값: Node는 `timeout`이 0이거나 없으면 기다림에 끝을 두지 않는다. */
const unbounded = (value) =>
  (value.type === "Literal" && value.value === 0) ||
  (value.type === "Identifier" && value.name === "undefined");

/** 옵션 객체 리터럴이 `timeout` 속성을 직접 갖는가(`{ timeout: ms }`, `{ timeout }`). 0·undefined는 상한이 아니다. */
const hasTimeout = (node) =>
  node.type === "ObjectExpression" &&
  node.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" &&
        property.key.name === "timeout") ||
        (property.key.type === "Literal" &&
          property.key.value === "timeout")) &&
      !unbounded(property.value)
  );

/**
 * 외부 프로그램을 동기로 띄우면 그 프로그램이 끝날 때까지 이벤트 루프 전체가 멈춘다. 서버 시작·복구 중에 답하지 않는
 * 보조 명령(ps, PowerShell, taskkill)이 서버를 붙잡지 않도록, 동기 실행은 옵션 객체 리터럴에 `timeout`을 둘 때만 허용한다.
 * child_process에서 가져온 이름(바꾼 이름 포함)과 `모듈.execFileSync(...)` 모양의 호출을 본다. 옵션을 변수로 넘기면 상한을
 * 확인할 수 없으므로 짚는다. 계산한 경로로 가져오거나 구조 분해·다른 변수로 함수를 옮겨 부르는 것은 따라가지 않는다.
 */
const syncCommandTimeout = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require a timeout option on synchronous child_process calls in product code",
    },
    schema: [],
    messages: {
      missing:
        "{{name}} 호출은 프로그램이 끝날 때까지 서버·스크립트 전체를 멈춥니다. 비동기 실행(execFile·spawn, runtime 연결 코드는 providers/process.ts의 runProbe)을 쓰거나, 동기 실행이 꼭 필요하면 옵션 객체 리터럴에 timeout을 두고 상한이 지난 결과(error.code === \"ETIMEDOUT\")를 '모름'으로 처리하세요.",
    },
  },
  create(context) {
    /** 이 파일에서 child_process의 동기 실행 함수를 가리키는 지역 이름 → 원래 이름. */
    const imported = new Map();
    return {
      ImportDeclaration(node) {
        if (!childProcess.has(node.source.value)) return;
        for (const specifier of node.specifiers)
          if (
            specifier.type === "ImportSpecifier" &&
            syncLaunchers.has(specifier.imported.name)
          )
            imported.set(specifier.local.name, specifier.imported.name);
      },
      CallExpression(node) {
        const { callee } = node;
        const name =
          callee.type === "Identifier"
            ? imported.get(callee.name)
            : callee.type === "MemberExpression" &&
                !callee.computed &&
                syncLaunchers.has(callee.property.name)
              ? callee.property.name
              : undefined;
        if (!name || node.arguments.some(hasTimeout)) return;
        context.report({ node, messageId: "missing", data: { name } });
      },
    };
  },
};

const ignoredErrorGuide =
  '버려야 하면 @babojubot/contracts(스크립트는 packages/contracts/src/failure.ts)의 이름 붙은 함수를 쓰세요: orIfMissing(없으면 기본값), continueAfterFailure(실패해도 진행), orIfProbeFailed(확인 실패면 안전한 결과, 원인을 남김), orIfUnreadable(동기 해석을 읽을 수 없으면 아님), settled(순서만 지킴). 오류 이벤트 처리기(on("error", …))와 오류를 넘기는 콜백(execFile·close 등)도 같습니다: 상대가 끊어 난 오류(EPIPE·ECONNRESET)만 isDisconnect로 확인해 넘기고, 그 밖의 오류는 원인을 남기거나 드러냅니다. CODING_STANDARDS.md#제품-코드';

/** 오류를 받는 처리기의 자리: `.catch(처리기)`, `.then(성공, 처리기)`. */
const handlerPositions = new Map([
  ["catch", 0],
  ["then", 1],
]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

/** 본문이 다른 오류를 던지는 한 문장뿐인가(`catch { throw new Refusal() }`, `.catch(() => { throw … })`). */
function onlyThrows(body) {
  return (
    body.type === "BlockStatement" &&
    body.body.length === 1 &&
    body.body[0].type === "ThrowStatement"
  );
}

/**
 * 함수가 첫 매개변수로 받는 오류를 버리는 모양. 매개변수가 없거나(다른 오류를 던지는 한 문장뿐이면 아님), 받고도 쓰지 않는다
 * (`_`를 붙였든 아니든). 구조 분해·기본값으로 받는 매개변수는 보지 않는다. `catch` 절은 `{ params, body, scope: 절 }`로 넘긴다.
 */
function droppedError(context, fn) {
  const [param] = fn.params;
  if (!param) return onlyThrows(fn.body) ? undefined : "unnamed";
  if (param.type !== "Identifier") return undefined;
  const used = context.sourceCode
    .getDeclaredVariables(fn.scope ?? fn)
    .some(
      (variable) =>
        variable.name === param.name && variable.references.length > 0
    );
  if (used) return undefined;
  return param.name.startsWith("_") ? "underscore" : "unused";
}

/** 오류 이벤트 처리기를 붙이는 메서드. `x.on("error", 처리기)`의 처리기는 오류를 첫 인수로 받는다. */
const listenerMethods = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
/**
 * 끝날 때 오류(없으면 null)를 첫 인수로 넘기는 마지막 인수 콜백을 받는 호출: child_process의 execFile·exec, 서버·스트림의 close,
 * 쓰기 스트림의 write·end, stream의 pipeline·finished.
 */
const errorFirstCalls = new Set([
  "execFile",
  "exec",
  "close",
  "write",
  "end",
  "pipeline",
  "finished",
]);

/** 호출하는 메서드 이름. `x.catch(...)`와 `x["catch"](...)` 모두 본다. */
function calledMethod(callee) {
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed) return callee.property.name;
  return callee.property.type === "Literal" &&
    typeof callee.property.value === "string"
    ? callee.property.value
    : undefined;
}

/**
 * 오류를 받지 않고 버리면 의도한 처리(파일 없음은 없는 것)와 실수(권한 오류까지 빈 결과로 바꿈)가 코드에서 같아 보인다.
 * 오류 변수가 없는 `catch`, 인자 없는 `.catch` 처리기와 `.then`의 거부 처리기, 오류 이벤트 처리기(`on`·`once` 등의 "error"),
 * 오류를 첫 인수로 넘기는 콜백(`execFile`·`exec`·`close`·`write`·`end`·`pipeline`·`finished`의 마지막 인수), 받고도 쓰지 않는 오류 이름(`_` 포함)을 막는다.
 * 다른 오류를 던지는 한 문장뿐인 처리는 버리는 것이 아니므로 허용한다.
 * 알려진 한계: 이름으로 넘긴 처리기(`.then(settle, settle)`), 기본값·나머지 매개변수로 받는 오류, `void error`처럼 쓰는 척만 하는
 * 처리, 위 목록 밖의 오류 우선 콜백(`fs`의 콜백 등), 글로 넣는 코드(OpenCode plugin·컨테이너 확인 스크립트의
 * 문자열)는 판정하지 않으며 리뷰가 본다. `orIfUnreadable` 콜백 안의 입출력은 `no-io-in-unreadable`이 본다.
 */
const noIgnoredError = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow dropping an error without naming it or the intent in product code",
    },
    schema: [],
    messages: {
      unnamed: `오류를 받지 않고 버리면 왜 버리는지 보이지 않습니다. 오류를 받아 검사하거나 다시 던지세요. ${ignoredErrorGuide}`,
      underscore: `\`_\`를 붙여 쓰지 않는 오류도 버리는 것입니다. 오류를 받아 검사하거나 다시 던지세요. ${ignoredErrorGuide}`,
      unused: `오류를 받고도 쓰지 않으면 버리는 것입니다. 오류를 검사하거나 원인을 남기거나 다시 던지세요. ${ignoredErrorGuide}`,
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const messageId = droppedError(context, {
          params: node.param ? [node.param] : [],
          body: node.body,
          scope: node,
        });
        if (messageId) context.report({ node: node.param ?? node, messageId });
      },
      CallExpression(node) {
        const method = calledMethod(node.callee);
        const name =
          method ??
          (node.callee.type === "Identifier" ? node.callee.name : undefined);
        let handler;
        if (handlerPositions.has(method))
          handler = node.arguments[handlerPositions.get(method)];
        else if (
          listenerMethods.has(method) &&
          node.arguments[0]?.type === "Literal" &&
          node.arguments[0].value === "error"
        )
          handler = node.arguments[1];
        else if (errorFirstCalls.has(name)) handler = node.arguments.at(-1);
        if (!handler || !functionTypes.has(handler.type)) return;
        const messageId = droppedError(context, handler);
        if (messageId)
          context.report({ node: handler.params[0] ?? handler, messageId });
      },
    };
  },
};

const unreadableGuide =
  "읽기는 콜백 밖에서 하세요: 데이터 파일은 orIfMissing(없음만 기본값), 실패하면 안전한 결과로 가는 확인 호출(프로세스 조회·연결·이름 풀이·다른 프로그램의 저장소 열기)은 orIfProbeFailed(원인을 report로 남김)로 감싸고, 읽은 값의 해석만 orIfUnreadable로 감쌉니다. 응답 본문은 await res.text()로 받아 끊김을 드러낸 뒤 해석합니다. CODING_STANDARDS.md#제품-코드";

/** 입출력으로 보는 호출 이름의 앞부분. 파일 읽기·쓰기·열기, 명령 실행이다. `*Sync`(동기 입출력)는 따로 본다. */
const ioPrefix =
  /^(read|write|append|open|exists|realpath|copyFile|mkdir|unlink|rename|spawn|execFile|execSync|fork)/;
/** 입출력으로 보는 호출 이름. 파일 상태, 연결·요청·질의, 이름 풀이, 응답 본문 읽기다. */
const ioNames = new Set([
  "stat",
  "lstat",
  "access",
  "rm",
  "fetch",
  "connect",
  "createConnection",
  "request",
  "query",
  "lookup",
  "json",
  "text",
  "arrayBuffer",
  "blob",
  "formData",
]);

/** 호출 대상의 이름들. `fs.realpathSync.native(…)`는 `native`·`realpathSync`, `readFile(…)`은 `readFile`. 맨 앞 객체 이름은 빼고 본다. */
function calleeNames(callee) {
  if (callee.type === "Identifier") return [callee.name];
  const names = [];
  for (let at = callee; at.type === "MemberExpression"; at = at.object) {
    const name = at.computed
      ? at.property.type === "Literal" && typeof at.property.value === "string"
        ? at.property.value
        : undefined
      : at.property.name;
    if (name) names.push(name);
  }
  return names;
}

/** 입출력 호출로 보는 이름이면 그 이름. 정규식의 `exec`와 겹치는 child_process `exec`는 가져온 이름으로 부를 때만 본다. */
function ioCallName(callee) {
  if (callee.type === "Identifier" && callee.name === "exec") return "exec";
  return calleeNames(callee).find(
    (name) => ioNames.has(name) || ioPrefix.test(name) || /Sync$/.test(name)
  );
}

/**
 * `orIfUnreadable`은 이미 손에 든 값의 동기 해석·확인 한 단계만 감싼다. 콜백 안의 입출력은 권한·디스크·연결 오류까지 아님·없음으로
 * 바꿔 원인을 지우므로(#246 리뷰 S1, #258 리뷰 STD-1), 콜백 안의 `async`·`await`와 파일 읽기·쓰기, 명령·연결·이름 풀이·응답 본문
 * 읽기 직접 호출을 막는다. lint가 안을 보도록 콜백은 그 자리에 쓰게 한다(이름으로 넘긴 함수는 막는다).
 * 가져온 이름을 바꿔 불러도(`import { orIfUnreadable as parse }`) 본다. 판정은 호출 이름으로 하므로 같은 이름의 순수 함수
 * (`text()`·`request()` 등)도 짚는다. 그런 함수는 콜백 밖에서 부르고 결과만 해석한다.
 * 알려진 한계: 콜백이 부르는 함수 안의 동기 입출력(`orIfUnreadable(() => parseConfig(file), …)`의 `parseConfig`가 `readFileSync`를 부름)은
 * 모양으로 보이지 않으며 리뷰가 본다. 비동기 입출력은 promise를 돌려주므로 타입 검사와 실행 중 거부(`AsyncReadError`)가 막는다.
 */
const noIoInUnreadable = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow I/O inside the callback of orIfUnreadable, which only wraps one synchronous parse",
    },
    schema: [],
    messages: {
      io: `orIfUnreadable 콜백 안에서 {{name}}을(를) 부릅니다. orIfUnreadable은 이미 손에 든 값의 동기 해석 한 단계만 감쌉니다. 입출력의 실패(권한·디스크·연결)를 아님·없음으로 바꾸면 원인이 사라집니다. ${unreadableGuide}`,
      async: `orIfUnreadable 콜백이 비동기입니다(async·await). orIfUnreadable은 동기 해석만 받고, promise를 받으면 AsyncReadError를 던집니다. 비동기 입출력은 확인 호출이므로 orIfProbeFailed로 원인을 남기거나 없음만 기본값이면 orIfMissing을 쓰세요. ${unreadableGuide}`,
      named: `orIfUnreadable에 콜백을 이름으로 넘깁니다. lint가 콜백 안의 입출력을 볼 수 있도록 해석을 그 자리에 쓰세요(orIfUnreadable(() => JSON.parse(text), undefined)). ${unreadableGuide}`,
    },
  },
  create(context) {
    /** 이 파일에서 orIfUnreadable을 가리키는 지역 이름. */
    const names = new Set(["orIfUnreadable"]);
    const { visitorKeys } = context.sourceCode;
    /** 콜백 몸 전체를 돌며 `await`와 입출력 호출을 짚는다. 안쪽 함수도 본다. */
    const inspect = (node) => {
      if (node.type === "AwaitExpression")
        context.report({ node, messageId: "async" });
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const name = ioCallName(node.callee);
        if (name) context.report({ node, messageId: "io", data: { name } });
      }
      for (const key of visitorKeys[node.type] ?? []) {
        const child = node[key];
        for (const item of Array.isArray(child) ? child : [child])
          if (item && typeof item.type === "string") inspect(item);
      }
    };
    return {
      ImportSpecifier(node) {
        const imported =
          node.imported.type === "Identifier"
            ? node.imported.name
            : node.imported.value;
        if (imported === "orIfUnreadable") names.add(node.local.name);
      },
      CallExpression(node) {
        const { callee } = node;
        const called =
          callee.type === "Identifier"
            ? names.has(callee.name)
            : calledMethod(callee) === "orIfUnreadable";
        if (!called) return;
        const [read] = node.arguments;
        if (!read) return;
        if (!functionTypes.has(read.type)) {
          context.report({ node: read, messageId: "named" });
          return;
        }
        if (read.async) context.report({ node: read, messageId: "async" });
        inspect(read.body);
      },
    };
  },
};

const chainAlternatives =
  "서로 무관한 정리는 모두 시도하고 실패를 모아 알리세요. 정리마다 catch를 두고 실패를 모아 원래 실패와 함께 던지거나(`AggregateError`, apps/server/src/app.ts의 서버 끄기), 스크립트는 자원을 잡은 직후 withCleanup의 defer로 등록하거나 cleanUpAll(@babojubot/runtime/test-cleanup)로 모두 시도합니다. 실패를 스스로 기록하고 던지지 않는 정리(removeAttemptFolder 등)끼리는 Promise.all로 함께 시작해 한 번 기다립니다. 동기 정리는 정리마다 continueAfterFailure(@babojubot/contracts)로 실패를 남기고 다음 정리로 갑니다. 앞 단계가 끝나야 안전한 단계(서비스를 닫은 뒤 그 이벤트 흐름이 끝나기를 기다림)는 그 순서를 이름으로 드러낸 함수 하나로 묶습니다. CODING_STANDARDS.md#제품-코드";

/**
 * 실패 경로(`finally`·`catch`의 몸)에서 정리를 차례로 기다리면 앞 정리가 실패한 순간 블록이 끝나 뒤 정리(DB 닫기·폴더 지우기)를
 * 건너뛰고, 그 실패가 원래 실패를 가린다. 판정은 시험의 공용 정리 hook 규칙(`tests/no-skipped-cleanup`)과 같다.
 * - 정리 호출(닫기·끄기·풀기·지우기 이름, 반복 변수의 호출, 정리 하나만 하는 Promise)을 기다린 뒤 같은 블록에 다른 기다림이 이어진다.
 * - 반복문 안에서 정리를 기다린다. 한 번 실패하면 남은 차례를 건너뛴다.
 * - 한 try 본문에 정리 기다림이 둘 이상이거나 try가 정리 반복문 전체를 감싼다. catch로 모아도 같은 try의 뒤 정리를 건너뛴다.
 * 정리마다 따로 catch하는 모양, 서로 다른 갈래(if·else), return·throw 뒤의 문, 끄기 뒤에 폴더 지우기(`removeFolder`)만 이어지는 것은
 * 짚지 않는다. 앞 단계가 끝나야 안전한 단계인지는 모양으로 알 수 없어, 그런 단계는 순서를 이름으로 드러낸 함수 하나로 묶게 한다.
 * 던질 수 있는 동기 정리(`process.kill`·`*Sync`, 시험 규칙 `tests/no-cleanup-in-finally`와 같은 판정)도 같은 연쇄로 본다: 동기
 * 정리 뒤에 다른 정리가 이어지거나, 기다린 정리 뒤에 동기 정리가 이어지거나, 동기 정리를 반복문 안에서 부른다. 정리 하나뿐인 블록은
 * 연쇄가 아니다.
 * 알려진 한계: 블록 안에 정의한 함수와 블록이 부르는 함수의 몸, `.catch()` 처리기, 이름으로 알 수 없는 동기 정리(`child.kill()` 등)는
 * 보지 않으며 리뷰가 본다.
 */
const noCleanupChain = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow running independent cleanups one after another in a finally or catch block",
    },
    schema: [],
    messages: {
      skipped: `finally·catch에서 정리를 차례로 기다리거나 던질 수 있는 동기 정리(process.kill·*Sync)를 다른 정리와 차례로 부릅니다. 앞 정리가 실패하면 거기서 블록이 끝나 뒤 자원(서버·DB·폴더)이 남고, 그 실패가 원래 실패를 가립니다. ${chainAlternatives}`,
      caught: `finally·catch에서 정리 여러 개를 한 try…catch로 감쌉니다. 앞 정리가 실패하면 catch로 넘어가, 실패는 받아도 같은 try의 뒤 정리(반복이면 남은 차례)를 건너뜁니다. 정리마다(반복이면 차례마다) catch를 두세요. ${chainAlternatives}`,
    },
  },
  create(context) {
    const reported = new Set();
    const check = (block) => {
      const found =
        skippedCleanupIn(block) ??
        skippedSyncCleanupIn(block, context.sourceCode);
      if (!found || reported.has(found.node)) return;
      reported.add(found.node);
      context.report({ node: found.node, messageId: found.messageId });
    };
    return {
      TryStatement(node) {
        if (node.handler) check(node.handler.body);
        if (node.finalizer) check(node.finalizer);
      },
    };
  },
};

const groupSignalers = new Set(["kill", "killUnlessGone", "processAlive"]);

/**
 * 프로세스 그룹(음수 pid)에 신호를 보내는 일은 packages/runtime/src/providers/recovery.ts만 한다. 그룹 끄기는 생존 확인·SIGTERM·유예·
 * SIGKILL·상한 있는 확인이 한 벌이어야 하고, 손으로 짠 복사본은 신호만 보내고 확인 없이 떠나는 빈틈을 되풀이했다(#255 리뷰 SPEC-3·4).
 * `process.kill(-x, …)`, `killUnlessGone(-x, …)`, `processAlive(-x)`처럼 첫 인수가 음수 부호 식인 호출을 짚는다. 음수 값을 변수에 담아
 * 넘기는 호출은 따라가지 않으며 리뷰가 본다.
 */
const noProcessGroupSignal = {
  meta: {
    type: "problem",
    docs: {
      description:
        "allow signalling a process group (a negative pid) only in the product's process group stop",
    },
    schema: [],
    messages: {
      group:
        "프로세스 그룹(음수 pid)에 직접 신호를 보냅니다. 그룹 끄기는 생존 확인·SIGTERM·유예·SIGKILL·상한 있는 확인을 한곳(packages/runtime/src/providers/recovery.ts)이 맡아, 신호만 보내고 확인 없이 떠나는 끄기가 생기지 않게 합니다. stopProcessGroup(@babojubot/runtime/process-group)을 쓰세요. 그룹이 끝난 것을 확인하지 못하면 던지므로 그 실패를 결과로 다루세요. CODING_STANDARDS.md#제품-코드",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name =
          calledMethod(node.callee) ??
          (node.callee.type === "Identifier" ? node.callee.name : undefined);
        const [target] = node.arguments;
        if (
          groupSignalers.has(name) &&
          target?.type === "UnaryExpression" &&
          target.operator === "-"
        )
          context.report({ node, messageId: "group" });
      },
    };
  },
};

export default {
  rules: {
    "no-assertion-on-parsed-data": noAssertionOnParsedData,
    "sync-command-timeout": syncCommandTimeout,
    "no-ignored-error": noIgnoredError,
    "no-io-in-unreadable": noIoInUnreadable,
    "no-cleanup-chain": noCleanupChain,
    "no-process-group-signal": noProcessGroupSignal,
  },
};
