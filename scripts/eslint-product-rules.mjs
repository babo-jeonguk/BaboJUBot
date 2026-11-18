// 제품 코드 전용 lint 규칙. 선택자만으로는 판단할 수 없는 규칙(호출의 옵션에 무엇이 있는지)을 둔다.
// 설정은 eslint.config.js의 `productFiles` 범위에 걸고, 회귀 시험은 scripts/product-lint-rules.test.mjs가 맡는다.

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
        "{{name}} 호출은 프로그램이 끝날 때까지 서버 전체를 멈춥니다. 비동기 실행(execFile·spawn, runtime 연결 코드는 providers/process.ts의 runProbe)을 쓰거나, 동기 실행이 꼭 필요하면 옵션 객체 리터럴에 timeout을 두고 상한이 지난 결과(error.code === \"ETIMEDOUT\")를 '모름'으로 처리하세요.",
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

export default {
  meta: { name: "babojubot-product" },
  rules: { "sync-command-timeout": syncCommandTimeout },
};
