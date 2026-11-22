// 접근 모양 생성기(scripts/lint-access-shapes.mjs)가 만든 모양이 실제로 정식 이름과 같은 값에 닿는지 본다(#266 리뷰 SPEC-10).
// 생성한 사례를 실제 모듈로 평가해(가져오기·require·전역 읽기만, 무거운 실행 없음) 같은 값인지 비교한다. 같은 이름의 지역 값 사례는
// 다른 값이어야 한다. 모듈 형식마다 대표 하나씩: Node 내장, module.exports가 함수인 CJS(cross-spawn), ESM 전용(vitest), CJS와 ESM
// 입구를 함께 둔 패키지(@playwright/test), 저장소 패키지.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { accessShapes } from "./lint-access-shapes.mjs";

const repository = path.resolve(import.meta.dirname, "..");

/**
 * 값마다 그 모듈을 찾을 수 있는 폴더(그 모듈을 의존성으로 선언한 workspace 패키지). 평가 파일은 그 폴더의 node_modules 아래에 두어
 * 맨 이름 가져오기가 그 패키지에 설치된 판으로 풀린다.
 */
const values = [
  { value: { module: "node:timers", path: ["setTimeout"] }, home: "." },
  { value: { module: "node:assert", path: ["strict", "ok"] }, home: "." },
  { value: { module: "node:process", path: ["kill"] }, home: "." },
  {
    value: { module: "cross-spawn", path: ["default"] },
    home: "packages/process",
  },
  { value: { module: "vitest", path: ["expect"] }, home: "apps/server" },
  {
    value: { module: "vitest", path: ["chai", "assert"] },
    home: "apps/server",
  },
  {
    value: { module: "@playwright/test", path: ["test", "afterAll"] },
    home: "apps/web",
  },
  {
    value: { module: "@babojubot/contracts", path: ["orIfUnreadable"] },
    home: ".",
  },
  {
    value: {
      module: "@babojubot/process/test-cleanup",
      path: ["awaitedLater"],
    },
    home: ".",
  },
  { value: { global: "process", path: ["kill"] }, home: "." },
  { value: { global: "JSON", path: ["parse"] }, home: "." },
  { value: { global: "setTimeout", path: [] }, home: "." },
];

// 평가 파일의 앞부분: CJS 파일처럼 `require`를 쓸 수 있게 하고(생성기의 require 모양은 CJS 파일·createRequire 함수에서 쓰는 모양이다),
// 같은 이름의 지역 값이 가리킬 값을 둔다.
const prelude = `import { createRequire as makeRequire } from "node:module";\nconst require = makeRequire(import.meta.url);\nconst fakeValue = Symbol("fake");\n`;

test("every access shape the generator makes reaches the same value as the canonical name", async () => {
  const wrong = [];
  for (const entry of values) {
    const { value, home } = entry;
    const folder = path.join(
      repository,
      home,
      "node_modules",
      `.access-shapes-${process.pid}`
    );
    mkdirSync(folder, { recursive: true });
    try {
      const cases = accessShapes({
        value,
        use: (ref) => `export const value = ${ref};\n`,
      });
      const evaluated = [];
      for (const [index, { shape, code, same }] of cases.entries()) {
        // 같은 경로를 다시 쓰면 ESM 캐시가 앞 값의 모듈을 돌려주므로 값마다 다른 파일 이름을 쓴다.
        const file = path.join(
          folder,
          `case-${values.indexOf(entry)}-${index}.mjs`
        );
        writeFileSync(file, `${prelude}${code}`);
        try {
          const loaded = await import(pathToFileURL(file).href);
          evaluated.push({ shape, same, value: loaded.value });
        } catch (error) {
          evaluated.push({ shape, same, error: String(error).split("\n")[0] });
        }
      }
      const [canonical] = evaluated;
      const name = value.module ?? `global ${value.global}`;
      assert.equal(canonical.error, undefined, `${name}: ${canonical.error}`);
      assert.notEqual(canonical.value, undefined, `${name}: no value`);
      for (const each of evaluated.slice(1))
        if (each.error)
          wrong.push(
            `${name} ${value.path.join(".")} ${each.shape}: ${each.error}`
          );
        else if ((each.value === canonical.value) !== each.same)
          wrong.push(
            `${name} ${value.path.join(".")} ${each.shape}: ${each.same ? "another value" : "the same value"}`
          );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  assert.deepEqual(wrong, []);
});
