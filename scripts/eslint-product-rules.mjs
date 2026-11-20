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

/** 옵션 객체 리터럴에서 이름이 `name`인 속성. */
const optionNamed = (node, name) =>
  node.type === "ObjectExpression"
    ? node.properties.find(
        (property) =>
          property.type === "Property" &&
          !property.computed &&
          ((property.key.type === "Identifier" && property.key.name === name) ||
            (property.key.type === "Literal" && property.key.value === name))
      )
    : undefined;
/** 옵션 객체 리터럴이 `timeout` 속성을 직접 갖는가(`{ timeout: ms }`, `{ timeout }`). 0·undefined는 상한이 아니다. */
const hasTimeout = (node) => {
  const timeout = optionNamed(node, "timeout");
  return timeout !== undefined && !unbounded(timeout.value);
};
/** 시한에 강제로 끝내는가(`killSignal: "SIGKILL"`). 기본(SIGTERM)은 무시하는 프로그램을 끝내지 못해 기다림이 끝나지 않는다. */
const killsAtTimeout = (node) => {
  const kill = optionNamed(node, "killSignal");
  return (
    kill !== undefined &&
    kill.value.type === "Literal" &&
    kill.value.value === "SIGKILL"
  );
};

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
        "require a timeout that ends the program on synchronous child_process calls",
    },
    schema: [],
    messages: {
      missing:
        '{{name}} 호출은 프로그램이 끝날 때까지 서버·스크립트 전체를 멈춥니다. 비동기 실행(공용 실행의 runTree, @babojubot/process)을 쓰거나, 동기 실행이 꼭 필요하면 옵션 객체 리터럴에 timeout과 killSignal: "SIGKILL"을 두고 상한이 지난 결과(error.code === "ETIMEDOUT")를 \'모름\'으로 처리하세요.',
      soft: '{{name}}의 timeout은 시한에 신호(기본 SIGTERM)만 보내고 끝날 때까지 기다립니다. 신호를 무시하는 프로그램이면 기다림이 끝나지 않습니다. 옵션 객체 리터럴에 killSignal: "SIGKILL"을 두어 시한에 끝을 보장하세요. CODING_STANDARDS.md#제품-코드',
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
        if (!name) return;
        const options = node.arguments.find(hasTimeout);
        if (!options)
          return context.report({ node, messageId: "missing", data: { name } });
        if (!killsAtTimeout(options))
          context.report({ node, messageId: "soft", data: { name } });
      },
    };
  },
};

const ignoredErrorGuide =
  "버려야 하면 @babojubot/contracts(스크립트는 packages/contracts/src/failure.ts)의 이름 붙은 함수를 쓰세요: orIfMissing(없으면 기본값), continueAfterFailure(실패해도 진행), orIfUnreadable(읽을 수 없으면 아님), settled(순서만 지킴). CODING_STANDARDS.md#제품-코드";

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

/** `_`로 시작해 쓰지 않는다고 표시하고 실제로 쓰지 않는 오류 이름인가. 쓰는 이름이면 버리는 것이 아니다. */
const markedUnused = (context, param) =>
  param?.type === "Identifier" &&
  param.name.startsWith("_") &&
  context.sourceCode
    .getDeclaredVariables(param.parent)
    .some(
      (variable) =>
        variable.name === param.name && variable.references.length === 0
    );

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
 * 오류 변수가 없는 `catch`, 인자 없는 `.catch` 처리기와 `.then`의 거부 처리기, `_`를 붙인 오류 이름을 막는다.
 * 다른 오류를 던지는 한 문장뿐인 처리는 버리는 것이 아니므로 허용한다. 받고 쓰지 않는 오류는 `no-unused-vars`가 막는다.
 * 알려진 한계: 이름으로 넘긴 처리기(`.then(settle, settle)`), 기본값·나머지 매개변수로 받는 오류, `void error`처럼 쓰는 척만 하는
 * 처리, 이름 붙은 함수를 의도와 다르게 쓰는 것(권한 오류까지 `orIfUnreadable`로 덮기)은 판정하지 않으며 리뷰가 본다.
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
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        if (markedUnused(context, node.param))
          context.report({ node: node.param, messageId: "underscore" });
        else if (!node.param && !onlyThrows(node.body))
          context.report({ node, messageId: "unnamed" });
      },
      CallExpression(node) {
        const position = handlerPositions.get(calledMethod(node.callee));
        const handler =
          position === undefined ? undefined : node.arguments[position];
        if (!handler || !functionTypes.has(handler.type)) return;
        if (markedUnused(context, handler.params[0]))
          context.report({ node: handler.params[0], messageId: "underscore" });
        else if (handler.params.length === 0 && !onlyThrows(handler.body))
          context.report({ node: handler, messageId: "unnamed" });
      },
    };
  },
};

const chainAlternatives =
  "서로 무관한 정리는 모두 시도하고 실패를 모아 알리세요. 정리마다 catch를 두고 실패를 모아 원래 실패와 함께 던지거나(`AggregateError`, apps/server/src/app.ts의 서버 끄기), 스크립트는 자원을 잡은 직후 withCleanup의 defer로 등록하거나 attemptAll(@babojubot/contracts)로 모두 시도합니다. 실패를 스스로 기록하고 던지지 않는 정리(removeAttemptFolder 등)끼리는 Promise.all로 함께 시작해 한 번 기다립니다. 동기 정리는 정리마다 continueAfterFailure(@babojubot/contracts)로 실패를 남기고 다음 정리로 갑니다. 앞 단계가 끝나야 안전한 단계(서비스를 닫은 뒤 그 이벤트 흐름이 끝나기를 기다림)는 그 순서를 이름으로 드러낸 함수 하나로 묶습니다. CODING_STANDARDS.md#제품-코드";

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
 * 프로세스 그룹(음수 pid)에 신호를 보내는 일은 packages/process/src/group.ts만 한다. 그룹 끄기는 생존 확인·SIGTERM·유예·
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
        "프로세스 그룹(음수 pid)에 직접 신호를 보냅니다. 그룹 끄기는 생존 확인·SIGTERM·유예·SIGKILL·상한 있는 확인을 한곳(packages/process/src/group.ts)이 맡아, 신호만 보내고 확인 없이 떠나는 끄기가 생기지 않게 합니다. 프로그램은 launchTree(@babojubot/process)로 띄우고 그 stop()으로 끄세요. 트리 전체가 끝난 것을 확인하지 못하면 던지므로 그 실패를 결과로 다루세요. CODING_STANDARDS.md#제품-코드",
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

const asyncLaunchers = new Set(["spawn", "fork", "exec", "execFile"]);
const crossSpawn = "cross-spawn";
const launchAlternatives =
  "오래 도는 자식은 공용 실행으로 띄우세요: launchTree(@babojubot/process, 그 패키지 안은 launch.ts)가 띄우면서 그 트리를 끄는 stop()을 함께 돌려줍니다(Linux·macOS는 프로세스 그룹과 표식, Windows는 묶음). 끝까지 돌릴 짧은 명령은 runTree가 상한·취소에서 트리를 끄고 확인합니다. 결과를 기다려도 되는 짧은 명령은 timeout을 둔 동기 실행(execFileSync·spawnSync)을 씁니다. 트리를 끄면 안 되는 실행(그 자체가 데몬을 띄움)만 eslint.config.js의 launchOwners에 이유와 함께 올립니다. CODING_STANDARDS.md#제품-코드";

/** 가져오는 곳이 child_process인가, cross-spawn인가. */
const launchModule = (source) =>
  childProcess.has(source)
    ? "child_process"
    : source === crossSpawn
      ? crossSpawn
      : undefined;

/** 호출·읽기에 쓴 속성 이름. 계산한 이름이면 `undefined`, 문자열 그대로면 그 값. */
function propertyName(member) {
  if (!member.computed) return member.property.name;
  return member.property.type === "Literal" &&
    typeof member.property.value === "string"
    ? member.property.value
    : undefined;
}

/**
 * 오래 도는 자식을 child_process(`spawn`·`fork`·`exec`·`execFile`)나 cross-spawn(비동기 기본 함수·`spawn`)으로 직접 띄우는 것을 막는다.
 * 직접 띄우면 끄기를 따로 짜야 하고, 그 복사본이 신호만 보내고 떠나기·대표만 기다리기·Windows에서 아무것도 끄지 않기를 되풀이했다
 * (#255, #262). 이름 그대로·바꿔 가져오기, 모듈 객체(`* as cp`·기본 가져오기)에서 읽기, 다시 내보내기, 문자열 경로의 dynamic import,
 * `require`·`getBuiltinModule`로 불러오기를 본다. 동기 실행(`*Sync`, cross-spawn `.sync`)은 막지 않는다(상한은 `sync-command-timeout`).
 * 알려진 한계: 계산한 경로의 dynamic import, 모듈 객체를 다른 변수·함수로 넘긴 뒤의 호출은 따라가지 않는다.
 */
const noDirectLaunch = {
  meta: {
    type: "problem",
    docs: {
      description:
        "launch long-running children only through the shared launch that returns their stop",
    },
    schema: [],
    messages: {
      direct: `{{name}}으로 자식을 직접 띄웁니다. 띄우기와 끄기를 따로 짜면 끄기가 띄운 방법과 맞지 않습니다(Windows에서 아무것도 끄지 않음, 새 세션으로 나간 자식을 놓침, 신호만 보내고 떠남). ${launchAlternatives}`,
      loaded: `{{name}}을 import 밖에서 불러오면 무엇을 쓰는지 lint가 따라가지 못합니다. ${launchAlternatives}`,
    },
  },
  create(context) {
    /** 이 파일에서 모듈 객체를 가리키는 지역 이름 → 모듈 종류. */
    const modules = new Map();
    const report = (node, name, messageId = "direct") =>
      context.report({ node, messageId, data: { name } });
    const banned = (module, name) =>
      module === crossSpawn
        ? name === "spawn" || name === "default"
        : asyncLaunchers.has(name);
    const reExport = (node) => {
      const module = launchModule(node.source?.value);
      if (!module) return;
      if (node.type === "ExportAllDeclaration")
        return report(node, `${node.source.value}의 export *`);
      for (const specifier of node.specifiers)
        if (banned(module, specifier.local.name ?? specifier.local.value))
          report(specifier, `${node.source.value}의 ${specifier.local.name}`);
    };
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const module = launchModule(node.source.value);
        if (!module) return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === "type") continue;
          if (specifier.type === "ImportSpecifier") {
            const name = specifier.imported.name ?? specifier.imported.value;
            if (banned(module, name))
              report(specifier, `${node.source.value}의 ${name}`);
          } else modules.set(specifier.local.name, module);
        }
      },
      ExportNamedDeclaration: reExport,
      ExportAllDeclaration: reExport,
      ImportExpression(node) {
        const module = launchModule(node.source.value);
        if (module)
          report(node, `${node.source.value}의 dynamic import`, "loaded");
      },
      CallExpression(node) {
        const { callee } = node;
        const [first] = node.arguments;
        const loader =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression"
              ? propertyName(callee)
              : undefined;
        if (
          (loader === "require" || loader === "getBuiltinModule") &&
          first?.type === "Literal" &&
          launchModule(first.value)
        )
          return report(node, `${loader}("${first.value}")`, "loaded");
        // cross-spawn의 기본 함수 자체를 부른다(`spawn(...)`).
        if (
          callee.type === "Identifier" &&
          modules.get(callee.name) === crossSpawn
        )
          report(node, `${crossSpawn}`);
      },
      MemberExpression(node) {
        if (node.object.type !== "Identifier") return;
        const module = modules.get(node.object.name);
        if (!module) return;
        const name = propertyName(node);
        if (name === undefined) report(node, `${node.object.name}[…]`);
        else if (banned(module, name))
          report(node, `${node.object.name}.${name}`);
      },
    };
  },
};

/**
 * 실행 소유 파일에서 Node.js의 시한에 끝을 맡기는 비동기 실행을 막는다. 비동기 `execFile`·`exec`는 시한에 신호만 보내고 출력이 닫히기를
 * 기다려, 신호를 무시하거나 출력을 물려받은 자손이 남으면 끝나지 않는다. `spawn`·`fork`의 `timeout`도 신호만 보낸다(#262).
 * 짧은 명령은 runCommand·boundChild(providers/bounded-command.ts, 시한에 SIGKILL과 끝 보장), 트리를 끌 명령은 runTree를 쓴다.
 * 알려진 한계: 모듈 객체를 다른 변수로 넘긴 뒤의 호출, 옵션을 변수로 넘긴 `spawn`의 `timeout`은 보지 않는다.
 */
const boundedCommand = {
  meta: {
    type: "problem",
    docs: {
      description:
        "end short commands at their time limit instead of leaving it to Node's timeout signal",
    },
    schema: [],
    messages: {
      callback:
        "비동기 {{name}}은 시한에 신호만 보내고 출력이 닫히기를 기다립니다. 신호를 무시하거나 출력을 물려받은 자손이 남으면 끝나지 않습니다. 짧은 명령은 runCommand(@babojubot/process, 그 패키지 안은 bounded-command.ts)로 돌려 시한에 SIGKILL로 끝내고 끝을 보장하세요. 트리를 끌 명령은 runTree(@babojubot/process)를 씁니다. CODING_STANDARDS.md#제품-코드",
      timeout:
        "{{name}}의 timeout은 시한에 신호만 보내고 끝을 보장하지 않습니다. timeout 없이 띄우고 boundChild(providers/bounded-command.ts)로 시한에 SIGKILL을 보내고 끝을 기다리세요. CODING_STANDARDS.md#제품-코드",
    },
  },
  create(context) {
    /** child_process에서 가져온 비동기 실행의 지역 이름 → 원래 이름, 그리고 모듈 객체의 지역 이름. */
    const named = new Map();
    const modules = new Set();
    const launcherOf = (callee) => {
      if (callee.type === "Identifier") return named.get(callee.name);
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        modules.has(callee.object.name)
      ) {
        const name = propertyName(callee);
        return asyncLaunchers.has(name) ? name : undefined;
      }
      return undefined;
    };
    return {
      ImportDeclaration(node) {
        if (!childProcess.has(node.source.value) || node.importKind === "type")
          return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === "type") continue;
          if (specifier.type === "ImportSpecifier") {
            const name = specifier.imported.name ?? specifier.imported.value;
            if (asyncLaunchers.has(name)) named.set(specifier.local.name, name);
          } else modules.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const name = launcherOf(node.callee);
        if (!name) return;
        if (name === "execFile" || name === "exec")
          return context.report({
            node,
            messageId: "callback",
            data: { name },
          });
        if (node.arguments.some(hasTimeout))
          context.report({ node, messageId: "timeout", data: { name } });
      },
    };
  },
};

/**
 * 다른 영역이 runtime·프로세스 패키지에서 가져올 수 있는 입구를 묶는다(#262, #266). `packages`는 패키지 이름마다 이 자리에서 가져와도
 * 되는 입구(패키지 이름 경로)의 목록이고, 빈 목록이면 그 패키지를 가져오지 않는다. 상대 경로도 풀어서 본다: 그 패키지의
 * `src/index.ts`는 패키지 이름과 같게 보고, 그 밖의 파일(`packages/<폴더>/…`)은 어느 목록에도 들지 않는다. 패키지 자신의 파일은 보지 않는다.
 */
const importScopeAlternatives =
  "프로세스 띄우기·끄기와 짧은 명령은 @babojubot/process(launchTree·runTree·runCommand), 시험의 정리 도움은 @babojubot/process/test-cleanup·/remove-folder·/lifelines·/testing에 있습니다. 그룹 끄기·표식 정리 입구(@babojubot/process/recovery)는 runtime의 재시작 복구만 씁니다. 다른 곳은 띄울 때 launchTree가 돌려준 stop()으로 끕니다(docs/architecture.md 패키지 구성).";
const packageImportScope = {
  meta: {
    type: "problem",
    docs: {
      description:
        "allow only the listed entry points of runtime and the process package outside them",
    },
    schema: [
      {
        type: "object",
        properties: {
          packages: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
          why: { type: "string" },
        },
        required: ["packages", "why"],
        additionalProperties: false,
      },
    ],
    messages: {
      outside: `{{source}}: {{why}} 이 자리에서 {{name}}은 {{allowed}}만 가져옵니다. ${importScopeAlternatives}`,
      none: `{{source}}: {{why}} 이 자리에서는 {{name}}을 가져오지 않습니다. ${importScopeAlternatives}`,
    },
  },
  create(context) {
    const { packages, why } = context.options[0];
    const file = context.filename.replaceAll("\\", "/");
    const dir = file.replace(/\/[^/]*$/, "");
    /** 패키지 이름과 그 폴더(`packages/<폴더>/`). 이 파일이 든 패키지는 뺀다. */
    const scoped = Object.keys(packages)
      .map((name) => ({ name, folder: `packages/${name.split("/")[1]}/` }))
      .filter(
        ({ folder }) => !file.includes(`/${folder}`) && !file.startsWith(folder)
      );
    /** 범위 안 패키지를 가리키면 그 패키지와 입구, 아니면 undefined. */
    const target = (source) => {
      if (typeof source !== "string") return undefined;
      for (const { name, folder } of scoped) {
        if (source === name || source.startsWith(`${name}/`))
          return { name, entry: source };
        if (!source.startsWith(".")) continue;
        const parts = [];
        for (const part of `${dir}/${source}`.split("/"))
          if (part === "..") parts.pop();
          else if (part !== ".") parts.push(part);
        const resolved = parts.join("/");
        const at = resolved.indexOf(folder);
        if (at < 0) continue;
        const inside = resolved.slice(at + folder.length);
        return {
          name,
          entry: inside === "src/index.ts" ? name : `${folder}${inside}`,
        };
      }
      return undefined;
    };
    const check = (node, source) => {
      const found = target(source);
      if (!found || packages[found.name].includes(found.entry)) return;
      const allowed = packages[found.name];
      context.report({
        node,
        messageId: allowed.length ? "outside" : "none",
        data: { source, why, name: found.name, allowed: allowed.join(", ") },
      });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) =>
        node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) =>
        node.source.type === "Literal" && check(node, node.source.value),
    };
  },
};

/** 노드 아래(안쪽 함수 포함)를 차례로 돈다. `parent`는 따라가지 않는다. */
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}

/** 식 안 어디에든(감싼 오류·객체·배열·템플릿·안쪽 함수 포함) `names` 중 하나를 읽는가. 속성 이름 자리는 빼고 본다. */
function mentions(node, names) {
  let found = false;
  walk(node, (inner) => {
    if (found || inner.type !== "Identifier" || !names.has(inner.name)) return;
    const parent = inner.parent;
    const propertyName =
      (parent?.type === "MemberExpression" &&
        parent.property === inner &&
        !parent.computed) ||
      (parent?.type === "Property" &&
        parent.key === inner &&
        !parent.computed &&
        !parent.shorthand);
    if (!propertyName) found = true;
  });
  return found;
}

/**
 * 모으는 호출에서 넣는 값 자리: 배열의 `push`·`unshift`는 모든 인수, `splice`는 셋째부터, Map의 `set`·Set의 `add`는 모든 인수.
 */
const insertedArguments = (call) => {
  if (call.callee.type !== "MemberExpression" || call.callee.computed)
    return [];
  switch (call.callee.property.name) {
    case "push":
    case "unshift":
    case "set":
    case "add":
      return call.arguments;
    case "splice":
      return call.arguments.slice(2);
    default:
      return [];
  }
};

/** 부른 함수 이름(`continueAfterFailure(…)`)이나 메서드 이름(`.catch(…)`). */
const calleeName = (callee) =>
  callee.type === "Identifier" ? callee.name : calledMethod(callee);

/**
 * 호출이 실패 처리기를 받는 자리면 그 인수: `.catch(처리기)`, `.then(_, 처리기)`, `continueAfterFailure(일, 처리기)`,
 * `.on("error", 처리기)`·`.once("error", 처리기)`.
 */
function failureHandlerArgument(call) {
  const name = calleeName(call.callee);
  if (call.callee.type === "MemberExpression") {
    const position = handlerPositions.get(name);
    if (position !== undefined) return call.arguments[position];
    if (
      (name === "on" || name === "once") &&
      call.arguments[0]?.type === "Literal" &&
      call.arguments[0].value === "error"
    )
      return call.arguments[1];
    return undefined;
  }
  return name === "continueAfterFailure" ? call.arguments[1] : undefined;
}

/** 이름이 가리키는 변수. 찾지 못하면 undefined. */
function resolveName(sourceCode, identifier) {
  for (
    let scope = sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
  }
  return undefined;
}

/** 처리기 자리의 값이 함수면 그 함수. 이름이면 같은 파일에서 그 이름으로 정의한 함수(`function f`·`const f = () => …`)를 찾는다. */
function handlerFunction(sourceCode, node) {
  if (!node) return undefined;
  if (functionTypes.has(node.type)) return node;
  if (node.type !== "Identifier") return undefined;
  const definition = resolveName(sourceCode, node)?.defs[0]?.node;
  if (definition?.type === "FunctionDeclaration") return definition;
  if (
    definition?.type === "VariableDeclarator" &&
    definition.init &&
    functionTypes.has(definition.init.type)
  )
    return definition.init;
  return undefined;
}

const encloses = (outer, inner) =>
  outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

/** 대입·증감 뒤 같은 처리기 안에서 반드시 다시 던지는가(감싼 문장 목록에서 그 문장 뒤에 `throw`가 있다). 그 실패는 이어지지 않는다. */
function rethrownAfter(node, handler) {
  for (let current = node; current && current !== handler;) {
    const parent = current.parent;
    if (parent?.type === "BlockStatement") {
      const after = parent.body.slice(parent.body.indexOf(current) + 1);
      if (after.some((statement) => statement.type === "ThrowStatement"))
        return true;
    }
    current = parent;
  }
  return false;
}

/**
 * 실패를 모으는 일을 직접 짜지 않는다. "모두 시도하고 실패를 모아 알리기"를 다시 짜는 두 모양을 본다. 같은 일을 하는 도구가 이름만
 * 달리 여럿 생겼고(#263 외부 리뷰 1회차 뒤), 손으로 짠 모으기가 앞 실패에 뒤 정리를 건너뛰거나 실패를 놓쳤다.
 * `attemptAll`(던짐)·`attemptEach`(실패 목록)·`combinedFailure`(목록을 하나로, `@babojubot/contracts`의 failure.ts)를 쓴다. 문맥을 더한
 * 오류는 그 단계 안에서 던진다.
 *
 * 실패 처리기는 `catch` 절, `.catch`·`.then`의 거부 처리기, `continueAfterFailure`의 처리기, `"error"` 이벤트 처리기다. 이름으로 넘긴
 * 처리기(`.catch(fail)`)와 `catch` 안에서 받은 오류를 넘겨 부르는 함수(`keep(error)`)는 같은 파일의 그 함수 본문을 본다.
 * - `collected`: 받은 오류를 넣는 값 안 어디에든 담아(감싼 `new Error(…, { cause })`, 객체·배열·템플릿, 그것으로 만든 지역 이름)
 *   모은다. 넣는 방법은 `push`·`unshift`·`splice`·Map의 `set`·Set의 `add`와 계산한 자리 대입(`failures[i] = …`)이다.
 * - `flagged`: 처리기 밖에서 만든 같은 변수·속성을 실패 처리 자리 둘 이상에서 바꾼다(실패 표시 `failed = true`, 셈 `problems++`,
 *   이어 붙이기 `report += …`). 한 처리기를 여러 자리에 넘겨도 자리마다 센다. 바꾼 뒤 반드시 다시 던지는 대입은 실패가 이어지지
 *   않으므로 세지 않는다. 한 자리에서 갈래마다 대입하는 결과 기록(`outcome = "failed"`)은 한 자리다.
 * - `combined`: `AggregateError`를 직접 만든다(본문 실패와 정리 실패를 손으로 묶기). 묶기는 `combinedFailure` 한 곳이 한다.
 * 알려진 한계: 본문 실패를 처리기 밖 변수에 담아 두고 뒤 단계의 실패를 로그로만 남기거나 버리는 모양은 보지 않는다. 한 실패의 결과를
 * 값으로 넘기는 한 번 기록(시작 줄 해석 실패, 알림 결과, 실행 결과)과 모양이 같아, 받은 오류를 처리기 밖 변수에 담는 22자리 중 진짜
 * 모으기는 3자리였다(CODING_STANDARDS.md#제품-코드).
 */
const noFailureCollecting = {
  meta: {
    type: "problem",
    docs: {
      description:
        "collect failures only through attemptAll, attemptEach and combinedFailure",
    },
    schema: [],
    messages: {
      collected:
        "받은 오류를 배열·Map·Set에 모아 '모두 시도하고 실패를 모아 알리기'를 직접 짭니다(감싼 오류, 이름 붙은 처리기도 같습니다). 서로 독립인 단계는 attemptAll(던짐)·attemptEach(실패 목록을 돌려줌), 모은 실패를 하나로 만들기는 combinedFailure(@babojubot/contracts, 스크립트는 packages/contracts/src/failure.ts)를 쓰세요. 문맥을 더할 오류는 그 단계 안에서 던지고, 단계가 값을 내야 하면 그 단계 안에서 바깥 변수에 담습니다. CODING_STANDARDS.md#제품-코드",
      flagged:
        "실패 처리 자리 {{count}}곳(줄 {{lines}})에서 같은 바깥 값 `{{name}}`을 바꿔 실패를 표시·셈·이어 붙여 모읍니다. 서로 독립인 단계는 attemptEach로 돌려 돌려받은 실패 목록으로 판단하고(남길 진단은 목록을 돌며 한 번씩), 던져야 하면 attemptAll, 원래 실패와 묶기는 combinedFailure(@babojubot/contracts, 스크립트는 packages/contracts/src/failure.ts)를 쓰세요. 단계마다 다른 문구는 그 단계 안에서 감싸 던집니다. CODING_STANDARDS.md#제품-코드",
      combined:
        "AggregateError를 직접 만들어 실패를 손으로 묶습니다. 서로 독립인 단계의 실패만 알리면 attemptAll, 원래 실패와 정리 실패를 함께 알리려면 정리를 attemptEach로 돌려 combinedFailure([원래 실패, ...정리 실패], 문구, { cause: 원래 실패 })로 던지세요(@babojubot/contracts, 스크립트는 packages/contracts/src/failure.ts). 묶는 곳이 하나여야 문구 모양(목록을 펼치지 않는 출력에서도 모든 실패가 보임)이 같습니다. CODING_STANDARDS.md#제품-코드",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const reported = new Set();
    const report = (node, messageId, data) => {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId, data });
    };
    /** 실패 처리 자리: `{ owner, body, at }`. owner 밖에서 만든 값만 바깥 값이다. */
    const points = [];
    const checked = new Set();
    /** 넣는 곳(`failures.push`의 `failures`)이 처리기(`owner`) 밖에서 만든 값인가. `this`·호출 결과에서 시작하면 밖으로 본다. */
    const outside = (target, owner) => {
      let root = target;
      while (root.type === "MemberExpression" || root.type === "CallExpression")
        root = root.type === "MemberExpression" ? root.object : root.callee;
      if (root.type !== "Identifier") return root.type === "ThisExpression";
      const definition = resolveName(sourceCode, root)?.defs[0]?.name;
      return !definition || !encloses(owner, definition);
    };
    /**
     * 처리기(`owner`) 본문에서 받은 오류(`param`)를 바깥 값에 모으는가. 받은 오류를 넘겨 부르는 같은 파일의 함수는 한 단계만 따라간다
     * (`follow`). 그 함수가 다시 부르는 함수는 처리기가 아니라 받은 값을 쓰는 일반 함수다(저장 쿼리의 `.set` 등).
     */
    const check = (param, body, owner, follow = true) => {
      if (param?.type !== "Identifier") return;
      const key = `${param.range[0]}`;
      if (checked.has(key)) return;
      checked.add(key);
      // 받은 오류와, 처리기 안에서 그것으로 만든 지역 이름.
      const names = new Set([param.name]);
      for (let grew = true; grew;) {
        grew = false;
        walk(body, (node) => {
          if (
            node.type === "VariableDeclarator" &&
            node.id.type === "Identifier" &&
            !names.has(node.id.name) &&
            node.init &&
            mentions(node.init, names)
          ) {
            names.add(node.id.name);
            grew = true;
          }
        });
      }
      walk(body, (node) => {
        const collected =
          (node.type === "CallExpression" &&
            insertedArguments(node).some((arg) => mentions(arg, names)) &&
            outside(node.callee.object, owner)) ||
          (node.type === "AssignmentExpression" &&
            node.left.type === "MemberExpression" &&
            node.left.computed &&
            mentions(node.right, names) &&
            outside(node.left.object, owner));
        if (collected) report(node, "collected");
        if (
          !follow ||
          node.type !== "CallExpression" ||
          node.callee.type !== "Identifier"
        )
          return;
        const called = handlerFunction(sourceCode, node.callee);
        if (!called) return;
        node.arguments.forEach((arg, index) => {
          if (mentions(arg, names))
            check(called.params[index], called.body, called, false);
        });
      });
    };
    /** 처리기 본문에서 바깥 값을 바꾸는 곳(다시 던지는 대입은 빼고). */
    const updates = ({ owner, body }) => {
      const found = [];
      walk(body, (node) => {
        const target =
          node.type === "AssignmentExpression"
            ? node.left
            : node.type === "UpdateExpression"
              ? node.argument
              : undefined;
        if (!target) return;
        let root = target;
        while (root.type === "MemberExpression") root = root.object;
        if (root.type !== "Identifier") return;
        const definition = resolveName(sourceCode, root)?.defs[0]?.name;
        if (!definition || encloses(owner, definition)) return;
        if (rethrownAfter(node, body)) return;
        found.push({
          node,
          key: `${sourceCode.getText(target)}@${definition.range[0]}`,
          name: sourceCode.getText(target),
        });
      });
      return found;
    };
    return {
      CatchClause(node) {
        check(node.param, node.body, node);
        points.push({ owner: node, body: node.body, at: node });
        // catch 안에서 받은 오류를 넘겨 부르는 같은 파일의 함수는 이 자리의 처리기다.
        walk(node.body, (inner) => {
          if (
            inner.type !== "CallExpression" ||
            inner.callee.type !== "Identifier" ||
            node.param?.type !== "Identifier" ||
            !inner.arguments.some((arg) =>
              mentions(arg, new Set([node.param.name]))
            )
          )
            return;
          const called = handlerFunction(sourceCode, inner.callee);
          if (called)
            points.push({ owner: called, body: called.body, at: node });
        });
      },
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "AggregateError"
        )
          report(node, "combined");
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "AggregateError"
        )
          report(node, "combined");
        const handler = handlerFunction(
          sourceCode,
          failureHandlerArgument(node)
        );
        if (!handler) return;
        check(handler.params[0], handler.body, handler);
        points.push({ owner: handler, body: handler.body, at: node });
      },
      "Program:exit"() {
        const byValue = new Map();
        for (const point of points)
          for (const update of updates(point)) {
            const entry = byValue.get(update.key) ?? {
              update,
              at: new Set(),
            };
            entry.at.add(point.at);
            byValue.set(update.key, entry);
          }
        for (const { update, at } of byValue.values())
          if (at.size >= 2)
            report(update.node, "flagged", {
              name: update.name,
              count: String(at.size),
              lines: [...at].map((point) => point.loc.start.line).join(", "),
            });
      },
    };
  },
};

const groupStoppers = new Set(["stopProcessGroup", "interruptProcessGroup"]);
const groupFile = "packages/process/src/group";

/**
 * 그룹 끄기의 반쪽(`stopProcessGroup`·`interruptProcessGroup`)만 가져다 쓰지 못하게 한다. 그룹 끄기는 그룹으로 띄운 트리에만 맞고,
 * 띄운 방법을 모르는 쪽이 빌려 쓰면 Windows에서 아무것도 끄지 않고 성공하거나 새 세션으로 나간 자식을 놓친다(#262).
 * - `outside: true`(프로세스 패키지 밖): 어디서든 그 두 이름을 가져오거나 다시 내보내는 것. 그 입구(@babojubot/process/recovery)를
 *   가져오는 것 자체는 product/package-import-scope가 본다.
 * - `outside: false`(프로세스 패키지 안, 공용 실행·복구 입구 밖): group.ts에서 그 두 이름을 가져오거나 다시 내보내는 것과 `export *`.
 */
const noGroupStopImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "keep the process group stop inside the shared launch and the restart recovery",
    },
    schema: [
      {
        type: "object",
        properties: { outside: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
    messages: {
      half: "{{name}}만 가져다 쓰면 띄운 방법과 맞지 않는 끄기가 됩니다(Windows에서 아무것도 끄지 않고 성공, 새 세션으로 나간 자식을 놓침). 띄울 때 launchTree(@babojubot/process)가 돌려준 stop()·interrupt()를 쓰세요. 그룹 끄기는 공용 실행(@babojubot/process의 launch.ts)과 runtime의 재시작 복구(providers/recovery.ts)만 씁니다. CODING_STANDARDS.md#제품-코드",
    },
  },
  create(context) {
    const outside = context.options[0]?.outside ?? true;
    const dir = context.filename.replaceAll("\\", "/").replace(/\/[^/]*$/, "");
    /** 가져오는 곳이 프로세스 패키지의 group.ts인가(상대 경로를 풀어 본다). */
    const isGroup = (source) => {
      if (typeof source !== "string" || !source.startsWith(".")) return false;
      const parts = [];
      for (const part of `${dir}/${source}`.split("/"))
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
      return parts
        .join("/")
        .replace(/\.(ts|js|mjs)$/, "")
        .endsWith(groupFile);
    };
    const check = (node, specifiers = []) => {
      const fromGroup = isGroup(node.source?.value);
      if (node.type === "ExportAllDeclaration" && fromGroup)
        return context.report({
          node,
          messageId: "half",
          data: { name: "group.ts의 export *" },
        });
      for (const specifier of specifiers) {
        const name =
          specifier.type === "ImportSpecifier"
            ? (specifier.imported.name ?? specifier.imported.value)
            : specifier.type === "ExportSpecifier"
              ? specifier.local.name
              : undefined;
        if (groupStoppers.has(name) && (outside || fromGroup))
          context.report({
            node: specifier,
            messageId: "half",
            data: { name },
          });
      }
    };
    return {
      ImportDeclaration: (node) => check(node, node.specifiers),
      ExportNamedDeclaration: (node) =>
        node.source && check(node, node.specifiers),
      ExportAllDeclaration: (node) => check(node),
    };
  },
};

export default {
  rules: {
    "no-assertion-on-parsed-data": noAssertionOnParsedData,
    "sync-command-timeout": syncCommandTimeout,
    "no-ignored-error": noIgnoredError,
    "no-cleanup-chain": noCleanupChain,
    "no-process-group-signal": noProcessGroupSignal,
    "no-direct-launch": noDirectLaunch,
    "bounded-command": boundedCommand,
    "package-import-scope": packageImportScope,
    "no-failure-collecting": noFailureCollecting,
    "no-group-stop-import": noGroupStopImport,
  },
};
