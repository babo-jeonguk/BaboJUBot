import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Markdown } from "./markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  test("renders GFM structure instead of leaving the symbols as text", () => {
    const out = html(
      [
        "# 제목",
        "## 소제목",
        "",
        "**굵게** *기울임* ~~취소~~ `코드`",
        "",
        "- 하나",
        "- 둘",
        "",
        "1. 첫째",
        "",
        "- [x] 끝남",
        "- [ ] 남음",
        "",
        "| 열 | 값 |",
        "| --- | --- |",
        "| a | 1 |",
        "",
        "> 인용",
        "",
        "```",
        "x = 1",
        "```",
      ].join("\n")
    );
    // 화면 h1·구역 h2 아래에 놓이게 두 단계 내린다.
    expect(out).toContain('<h3 class="md-h1">제목</h3>');
    expect(out).toContain('<h4 class="md-h2">소제목</h4>');
    expect(out).toContain("<strong>굵게</strong>");
    expect(out).toContain("<em>기울임</em>");
    expect(out).toContain("<del>취소</del>");
    expect(out).toContain("<code>코드</code>");
    expect(out).toMatch(/<ul>\s*<li>하나<\/li>\s*<li>둘<\/li>\s*<\/ul>/);
    expect(out).toMatch(/<ol>\s*<li>첫째<\/li>/);
    expect(out).toMatch(
      /<input type="checkbox" disabled="" checked=""\/> ?끝남/
    );
    expect(out).toContain('<div class="md-table"><table>');
    expect(out).toMatch(/<th>열<\/th>/);
    expect(out).toMatch(/<td>a<\/td>/);
    expect(out).toMatch(/<blockquote>\s*<p>인용<\/p>/);
    expect(out).toContain("<pre><code>x = 1\n</code></pre>");
    expect(out).not.toMatch(/[#*]|~~/);
  });

  test("keeps single line breaks and does not strike through a single tilde range", () => {
    const out = html("첫 줄\n둘째 줄 1~3개, 5~6일");
    expect(out).toMatch(/첫 줄<br\/>\s*둘째 줄 1~3개, 5~6일/);
    expect(out).not.toContain("<del>");
  });

  test("never renders raw HTML from the text", () => {
    const out = html(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n안녕 <b>굵게</b>'
    );
    expect(out).not.toMatch(/<script|<img|<b>/);
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;굵게&lt;/b&gt;");
  });

  test("drops javascript: links and opens external links safely", () => {
    const out = html(
      "[나쁨](javascript:alert(1)) [바깥](https://example.com) [안](/orgs/a) ![그림](https://example.com/a.png)"
    );
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<span class="md-dead-link">나쁨</span>');
    expect(out).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">바깥</a>'
    );
    expect(out).toContain('<a href="/orgs/a">안</a>');
    // 바깥 이미지는 불러오지 않고 링크로 둔다.
    expect(out).not.toContain("<img");
    expect(out).toContain(
      '<a href="https://example.com/a.png" target="_blank" rel="noopener noreferrer">그림</a>'
    );
  });

  test("shows leading frontmatter as a code block, not as a heading", () => {
    const out = html("---\nname: x\ndescription: y\n---\n\n# 본문");
    expect(out).toContain(
      '<pre><code class="language-yaml">name: x\ndescription: y\n</code></pre>'
    );
    expect(out).toContain('<h3 class="md-h1">본문</h3>');
    expect(out).not.toContain("<h4");
  });

  test("marks the inverse tone for dark bubbles", () => {
    expect(
      renderToStaticMarkup(
        <Markdown text="글" tone="inverse" data-testid="m" />
      )
    ).toMatch(/^<div data-testid="m" class="md md-inverse">/);
  });
});
