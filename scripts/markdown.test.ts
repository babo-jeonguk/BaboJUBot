// 문서·게시문의 링크 대상(linkTargets)을 렌더러와 같은 규칙으로 읽는지 본다. raw HTML의 href는 CommonMark(§6.6 Raw HTML)의 태그
// 문법으로 읽는다: `=` 둘레의 공백과 따옴표 없는 값도 속성 값이고, `data-href`는 href가 아니다(#286 항목 23). 그 문법이 HTML과
// 다르게 읽을 수 있는 href는 판정할 수 없음으로 낸다(#286 병합분 감사 항목 1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTargets, parseMarkdown } from "./markdown.mjs";

const urls = (markdown: string) =>
  linkTargets(parseMarkdown(markdown)).links.map(({ url }) => url);
const undecidableLines = (markdown: string) =>
  linkTargets(parseMarkdown(markdown)).undecidable.map(({ line }) => line);

test("reads an href written with spaces around = or without quotes, in HTML blocks and inline HTML", () => {
  assert.deepEqual(
    linkTargets(
      parseMarkdown(
        [
          '<a href = "spaced.md">a</a>',
          "",
          "<p><a HREF=bare.md>b</a></p>",
          "",
          "글 <a title='x' href='inline.md'>c</a> 끝",
        ].join("\n")
      )
    ),
    {
      links: [
        { url: "spaced.md", line: 1 },
        { url: "bare.md", line: 3 },
        { url: "inline.md", line: 5 },
      ],
      undecidable: [],
    }
  );
});

test("does not read other attributes that end in href", () => {
  assert.deepEqual(
    linkTargets(
      parseMarkdown(
        [
          '<span data-href="data.md" title="href=title.md">a</span>',
          "",
          '<a href="kept.md">b</a>',
        ].join("\n")
      )
    ),
    { links: [{ url: "kept.md", line: 3 }], undecidable: [] }
  );
});

test("gives the line of each HTML href", () => {
  assert.deepEqual(
    linkTargets(parseMarkdown('<div>\n<a\n  href="second.md">x</a>\n</div>')),
    { links: [{ url: "second.md", line: 3 }], undecidable: [] }
  );
});

// 브라우저는 같은 이름의 속성 중 첫 것만 쓰고, 속성 값의 문자 참조(`&#47;`·`&amp;`)를 풀어 읽는다. 손으로 짠 문법은 둘 다 하지
// 않으므로 그 값을 링크로 판정하지 않고 판정할 수 없음으로 낸다.
test("reports an href that HTML could read differently instead of reading it", () => {
  const markdown = [
    '<a href="first.md" HREF="second.md">a</a>',
    "",
    '<a href="docs&#47;hidden.md">b</a>',
    "",
    "글 <a href='page.md?a=1&amp;b=2'>c</a> 끝",
    "",
    '<a href="kept.md">d</a>',
  ].join("\n");
  assert.deepEqual(urls(markdown), ["kept.md"]);
  assert.deepEqual(undecidableLines(markdown), [1, 3, 5]);
});

// 문법이 태그로 읽지 않는 글(주석·처리 지시·CDATA·선언, raw text 요소의 내용, 문법에 맞지 않는 태그)은 브라우저가 다른 곳에서
// 끝내거나 태그로 읽을 수 있다(`--!>`로 끝나는 주석, `>`에서 끝나는 처리 지시, `<a/href=…>`). 그 안에 href가 있으면 판정할 수 없음이다.
test("reports href text in what the grammar skips instead of skipping it silently", () => {
  const markdown = [
    '<!-- old --!> <a href="comment.md">x</a> -->',
    "",
    '<?note > <a href="instruction.md">x</a> ?>',
    "",
    '<div>\n<a/href="slash.md">x</a>\n</div>',
    "",
    "<div>\n<a href=bad'quote.md>x</a>\n</div>",
    "",
    "<script>const x = \"</script-other> <a href='inside.md'>\";</script>",
    "",
    '<a href="kept.md">d</a>',
  ].join("\n");
  assert.deepEqual(urls(markdown), ["kept.md"]);
  assert.deepEqual(undecidableLines(markdown), [1, 3, 6, 10, 13]);
});

test("passes over skipped text and unreadable tags that hold no href", () => {
  assert.deepEqual(
    linkTargets(
      parseMarkdown(
        [
          "<!-- 양식 안내: https://example.com 참고 -->",
          "",
          "<div>\n값이 a <b 보다 작다\n</div>",
          "",
          '<a href="kept.md">d</a>',
        ].join("\n")
      )
    ),
    { links: [{ url: "kept.md", line: 7 }], undecidable: [] }
  );
});
