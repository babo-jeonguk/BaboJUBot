// 문서·게시문의 링크 대상(linkTargets)을 렌더러와 같은 규칙으로 읽는지 본다. raw HTML의 href는 CommonMark(§6.6 Raw HTML)의 태그
// 문법으로 읽는다: `=` 둘레의 공백과 따옴표 없는 값도 속성 값이고, `data-href`는 href가 아니며, 주석 안의 태그는 태그가 아니다
// (#286 항목 23).
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTargets, parseMarkdown } from "./markdown.mjs";

const urls = (markdown: string) =>
  linkTargets(parseMarkdown(markdown)).map(({ url }) => url);

test("reads an href written with spaces around = or without quotes, in HTML blocks and inline HTML", () => {
  assert.deepEqual(
    urls(
      [
        '<a href = "spaced.md">a</a>',
        "",
        "<p><a HREF=bare.md>b</a></p>",
        "",
        "글 <a title='x' href='inline.md'>c</a> 끝",
      ].join("\n")
    ),
    ["spaced.md", "bare.md", "inline.md"]
  );
});

test("does not read other attributes that end in href, or tags inside an HTML comment", () => {
  assert.deepEqual(
    urls(
      [
        '<span data-href="data.md" title="href=title.md">a</span>',
        "",
        '<!-- <a href="commented.md">old</a> -->',
        "",
        '<a href="kept.md">b</a>',
      ].join("\n")
    ),
    ["kept.md"]
  );
});

test("gives the line of each HTML href", () => {
  assert.deepEqual(
    linkTargets(parseMarkdown('<div>\n<a\n  href="second.md">x</a>\n</div>')),
    [{ url: "second.md", line: 3 }]
  );
});
