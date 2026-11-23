// package.json `exports`의 입구를 Node의 해석 규칙(https://nodejs.org/api/esm.html#resolution-algorithm-specification,
// PACKAGE_EXPORTS_RESOLVE)으로 푼다. 코드 지도 검사(scripts/check-code-map.mjs)와 lint의 가져오기 대상 판정(scripts/eslint-imports.mjs)이
// 함께 쓴다. 입구 이름이 exports에 있는지만 보면 null로 막은 입구, 이 저장소의 조건으로 풀리지 않는 입구, 대상 파일이 없는 입구도
// 쓸 수 있는 것으로 읽는다.

/** exports를 풀 때 쓰는 조건. 이 저장소의 패키지는 Node(ESM)로 가져온다(https://nodejs.org/api/packages.html#conditional-exports). */
export const exportConditions = new Set(["node", "import", "default"]);

/** exports를 입구(`.`·`./…`) 표로 읽는다: 키가 `.`로 시작하면 입구 표, 아니면 `.` 하나의 대상이다. */
export function exportsMap(exports: unknown): Map<string, unknown> {
  if (
    exports !== null &&
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."))
  )
    return new Map(Object.entries(exports));
  return new Map([[".", exports]]);
}

/**
 * exports의 대상 하나를 PACKAGE_TARGET_RESOLVE처럼 푼다. 문자열은 `./`로 시작하는 패키지 안 경로(`*`는 맞춘 부분으로 바꿈), null은
 * 막힘, 배열은 앞에서부터 풀리는 첫 대상, 객체는 적힌 순서대로 고른 조건(exportConditions)의 대상이다. 풀리지 않으면 undefined.
 */
function resolveTarget(
  target: unknown,
  star: string | undefined
): string | null | undefined {
  if (typeof target === "string") {
    if (!target.startsWith("./")) return undefined;
    return star === undefined ? target : target.replaceAll("*", star);
  }
  if (target === null) return null;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveTarget(item, star);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === "object")
    for (const [condition, value] of Object.entries(target))
      if (exportConditions.has(condition)) {
        const resolved = resolveTarget(value, star);
        if (resolved !== undefined) return resolved;
      }
  return undefined;
}

/**
 * 입구 풀이의 결과. listed: 입구가 exports의 키(같은 키나 `*` 무늬)와 맞는가. target: 패키지 폴더 기준 대상 경로(`./src/a.ts`),
 * 막혔으면 null, 조건으로 풀리지 않으면 undefined.
 */
export type ExportResolution =
  { listed: false } | { listed: true; target: string | null | undefined };

/**
 * 입구(`.`, `./testing`)를 exports로 푼다. 같은 키가 먼저이고, 없으면 `*` 하나인 키 중 `*` 앞이 가장 긴 키다
 * (PACKAGE_IMPORTS_EXPORTS_RESOLVE·PATTERN_KEY_COMPARE).
 */
export function resolveExport(
  exports: unknown,
  entry: string
): ExportResolution {
  const map = exportsMap(exports);
  if (map.has(entry) && !entry.includes("*"))
    return { listed: true, target: resolveTarget(map.get(entry), undefined) };
  let best: { key: string; prefix: string; match: string } | undefined;
  for (const key of map.keys()) {
    const star = key.indexOf("*");
    if (star === -1 || key.includes("*", star + 1)) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      entry.length >= key.length &&
      entry.startsWith(prefix) &&
      entry.endsWith(suffix) &&
      (best === undefined || prefix.length > best.prefix.length)
    )
      best = {
        key,
        prefix,
        match: entry.slice(prefix.length, entry.length - suffix.length),
      };
  }
  if (best === undefined) return { listed: false };
  return { listed: true, target: resolveTarget(map.get(best.key), best.match) };
}
