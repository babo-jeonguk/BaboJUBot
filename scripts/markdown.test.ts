// 문서·게시문의 링크 대상(linkTargets)을 렌더러와 같은 구문 트리로 읽는지 본다. raw HTML은 읽지 않는다: HTML 문법을 손으로
// 흉내 내면 브라우저와 다르게 읽는 곳(같은 이름 속성, 문자 참조, `--!>` 주석, NBSP)이 남는다. raw HTML 글에 `href`가 있으면
// 그 자리는 판정할 수 없음이고, 링크는 Markdown 링크로 쓴다(#286 병합분 감사 항목 1, #295 외부 리뷰 1회차 STD-1·SPEC-1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTargets, parseMarkdown } from "./markdown.mjs";

const reason = "href in raw HTML (write the link in Markdown)";

test("reads Markdown links, images, autolinks and reference definitions with their lines", () => {
  assert.deepEqual(
    linkTargets(
      parseMarkdown(
        [
          "[a](inline.md) ![b](image.png)",
          "",
          "<https://example.com/auto> https://example.com/bare",
          "",
          "[c][r]",
          "",
          "[r]: defined.md",
        ].join("\n")
      )
    ),
    {
      links: [
        { url: "inline.md", line: 1 },
        { url: "image.png", line: 1 },
        { url: "https://example.com/auto", line: 3 },
        { url: "https://example.com/bare", line: 3 },
        { url: "defined.md", line: 7 },
      ],
      undecidable: [],
    }
  );
});

test("reports every href in raw HTML as undecidable and reads no link from it", () => {
  const markdown = [
    '<a href = "spaced.md">a</a>',
    "",
    "<p><a HREF=bare.md>b</a></p>",
    "",
    "글 <a title='x' href='inline.md'>c</a> 끝",
    "",
    '<span data-href="data.md">d</span>',
    "",
    '<!-- <a href="commented.md">old</a> -->',
    "",
    '<a href="first.md" href="second.md">e</a>',
    "",
    '<a href="docs&#47;hidden.md">f</a>',
  ].join("\n");
  assert.deepEqual(linkTargets(parseMarkdown(markdown)), {
    links: [],
    undecidable: [1, 3, 5, 7, 9, 11, 11, 13].map((line) => ({ reason, line })),
  });
});

// 리뷰 반례 A: NBSP는 HTML에서 공백이 아니어서 속성 경계가 아니다. 손으로 짠 문법은 `\s`로 그것을 경계로 읽어, 한 값에 삼켜진
// href를 따로 읽거나 다른 href를 놓쳤다.
test("reports an href next to a non-breaking space or across lines in raw HTML", () => {
  const markdown = [
    "<div>",
    "<a title=x href=swallowed.md>a</a>",
    '<a href="named.md">b</a>',
    "<a",
    '  href="second-line.md">c</a>',
    "</div>",
  ].join("\n");
  assert.deepEqual(linkTargets(parseMarkdown(markdown)), {
    links: [],
    undecidable: [2, 3, 5].map((line) => ({ reason, line })),
  });
});

test("passes raw HTML that holds no href", () => {
  assert.deepEqual(
    linkTargets(
      parseMarkdown(
        [
          "<!-- 양식 안내: https://example.com 참고 -->",
          "",
          '<a id="e17"></a>',
          "",
          "[kept](kept.md)",
        ].join("\n")
      )
    ),
    { links: [{ url: "kept.md", line: 5 }], undecidable: [] }
  );
});
