// 실제 녹화 정제본은 공개 저장소에 들어간다. 값만이 아니라 객체 키에도 실제 실행의 식별자가 남지 않아야 한다(PR #130 리뷰 STD-03).
// 정제는 허용 목록 방식이고 이 검사는 사람의 검토를 대신하지 않는다. 알려진 식별자 모양이 다시 새는 것만 막는다.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

const directory = path.resolve("test-fixtures");
const identifier =
  /\b(?:toolu|srvtoolu|msg|req|ses|call)_[A-Za-z0-9]{8,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function leaks(value: unknown, at: string, found: string[]) {
  if (Array.isArray(value))
    value.forEach((item, i) => leaks(item, `${at}[${i}]`, found));
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (identifier.test(key)) found.push(`${at} key ${key}`);
      leaks(child, `${at}.${key}`, found);
    }
  else if (typeof value === "string" && identifier.test(value))
    found.push(`${at} ${value}`);
}

it("keeps real identifiers out of every recorded fixture, in keys and values", async () => {
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith("-recorded.json")
  );
  expect(files.length).toBeGreaterThan(0);
  const found: string[] = [];
  for (const name of files)
    leaks(
      JSON.parse(await readFile(path.join(directory, name), "utf8")),
      name,
      found
    );
  expect(found).toEqual([]);
});
