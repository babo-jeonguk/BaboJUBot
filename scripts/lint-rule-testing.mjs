// lint 규칙 시험(scripts/*lint-rules.test.mjs)이 짧은 코드를 저장소 lint 설정(eslint.config.js)으로 검사하는 도구.
// 타입 정보를 쓰는 검사는 코드를 바꿀 때마다 TypeScript 프로그램을 다시 만들어 한 번에 100ms 가까이 든다. 그래서 확인할 규칙만 켜고,
// 그 규칙 중 하나라도 타입 정보를 쓸 때(`meta.docs.requiresTypeChecking`)만 타입 정보를 만든다. 파일별 범위(files·ignores)와
// 규칙 설정은 저장소 설정 그대로다.
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";

const withoutTypes = {
  languageOptions: { parserOptions: { projectService: false, project: null } },
};

/** 설정이 거는 규칙 이름 → 그 규칙의 meta. 플러그인 규칙은 `<이름공간>/<규칙>`이고, ESLint 기본 규칙은 타입 정보를 쓰지 않는다. */
async function configuredRules(repository) {
  const configs = (
    await import(pathToFileURL(`${repository}/eslint.config.js`).href)
  ).default;
  const plugins = new Map();
  for (const config of configs)
    for (const [space, plugin] of Object.entries(config.plugins ?? {}))
      for (const [name, rule] of Object.entries(plugin.rules ?? {}))
        plugins.set(`${space}/${name}`, rule.meta);
  const rules = new Map();
  for (const config of configs)
    for (const id of Object.keys(config.rules ?? {}))
      rules.set(id, plugins.get(id) ?? {});
  return rules;
}

/**
 * `lint(code, filePath, rules)`: `filePath` 자리에 둔 `code`를 검사해 `rules`의 메시지만 돌려준다. 파일은 만들지 않는다.
 * 읽지 못한 코드(fatal)는 그 자리에서 실패로 드러낸다. `rules`를 빼면 설정 전체(타입 정보 포함)로 검사해 모든 메시지를 돌려준다.
 */
export function ruleLinter(repository) {
  const everything = new ESLint({ cwd: repository });
  const known = configuredRules(repository);
  /** 규칙 묶음마다 하나씩 만든다. 같은 묶음은 타입 정보 프로그램을 함께 쓴다. */
  const linters = new Map();

  async function linterFor(rules) {
    const key = [...rules].sort().join(" ");
    if (!linters.has(key))
      linters.set(
        key,
        known.then((configured) => {
          const typed = rules.some((id) => {
            const meta = configured.get(id);
            // 설정이 걸지 않는 규칙을 고르면 아무것도 잡지 않아 "잡지 않는다"는 확인이 저절로 통과한다.
            if (!meta) throw new Error(`eslint.config.js sets no rule ${id}`);
            return meta.docs?.requiresTypeChecking === true;
          });
          return new ESLint({
            cwd: repository,
            ruleFilter: ({ ruleId }) => rules.includes(ruleId),
            overrideConfig: typed ? [] : [withoutTypes],
          });
        })
      );
    return linters.get(key);
  }

  return async function lint(code, filePath, rules) {
    const eslint = rules ? await linterFor(rules) : everything;
    const [result] = await eslint.lintText(code, { filePath });
    const fatal = result.messages.filter((m) => m.fatal);
    if (fatal.length)
      throw new Error(`${filePath}: parsing failed: ${fatal[0].message}`);
    return rules
      ? result.messages.filter((m) => rules.includes(m.ruleId))
      : result.messages;
  };
}
