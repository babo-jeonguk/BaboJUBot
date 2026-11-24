// 문서·게시문의 Markdown을 CommonMark·GFM 구문 트리(mdast)로 읽는다. 검사 스크립트는 Markdown을 손으로 해석하지 않는다.
// 파서는 웹 앱(react-markdown·remark-gfm)과 같은 micromark 계열·같은 판이다(mdast-util-from-markdown, micromark-extension-gfm,
// mdast-util-gfm). 코드 블록·코드 스팬 안 글은 링크가 아니다.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

export { SKIP, visit } from "unist-util-visit";

/** CommonMark·GFM 구문 트리. 노드의 `position.start.line`이 원문 줄 번호다. */
export function parseMarkdown(text) {
  return fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

// raw HTML의 태그는 CommonMark(0.31.2 §6.6 Raw HTML, https://spec.commonmark.org/0.31.2/#raw-html)가 정한 문법으로 읽는다.
// 파서(micromark)가 HTML을 알아보는 규칙과 같다. 속성 이름은 그 문법의 이름 전체이고(`data-href`는 `href`가 아님), 값은 `=` 둘레의
// 공백과 따옴표 없는 값도 받는다. 주석·처리 지시·선언·CDATA 안의 글과 raw text 요소(script·style·textarea·title)의 내용은 태그가 아니다.
// 브라우저는 HTML 문법으로 읽어 이 문법과 다르게 읽을 수 있다(같은 이름 속성은 첫 것만, 값의 문자 참조를 풂, `--!>`로 끝나는 주석,
// `>`에서 끝나는 처리 지시, `<a/href=…>`). 그 문법을 더 흉내 내지 않고, 아는 모양(문법에 맞는 태그의 href 하나, `&` 없는 값)만 링크로
// 읽는다. 문법이 건너뛰는 글이나 읽지 못한 태그에 `href`라는 글자가 있으면 판정할 수 없음으로 낸다.
const attributeName = "[A-Za-z_:][A-Za-z0-9_.:-]*";
const attributeValue = `(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*")`;
const attribute = new RegExp(
  `\\s+(${attributeName})(?:\\s*=\\s*(${attributeValue}))?`,
  "gy"
);
const tagStart = /<([A-Za-z][A-Za-z0-9-]*)/y;
const tagEnd = /\s*\/?>/y;
/**
 * 태그가 아닌 `<` 구문: 주석, 처리 지시, CDATA, 선언, 닫는 태그. `end`는 그 구문을 끝내는 글이고, 빈 글이면 `start`가 구문 전체다.
 * @type {{ start: RegExp, end: string }[]}
 */
const skipped = [
  { start: /<!--(?:>|->)/y, end: "" },
  { start: /<!--/y, end: "-->" },
  { start: /<\?/y, end: "?>" },
  { start: /<!\[CDATA\[/y, end: "]]>" },
  { start: /<![A-Za-z]/y, end: ">" },
  { start: /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y, end: "" },
];
const rawTextElements = new Set(["script", "style", "textarea", "title"]);
const hrefText = /href/i;

/**
 * HTML 글의 여는 태그에서 읽은 `href` 값과, 판정할 수 없는 곳. `index`는 그 글 안 위치다(값의 첫 글자, 판정할 수 없는 구문의 `<`).
 * @returns {{ hrefs: { url: string, index: number }[], undecidable: { reason: string, index: number }[] }}
 */
function htmlHrefs(html) {
  const hrefs = [];
  const undecidable = [];
  /** 문법이 태그로 읽지 않고 건너뛰는 글. href 글자가 있으면 브라우저가 링크로 읽을 수 있다. */
  const skip = (from, to, what) => {
    if (hrefText.test(html.slice(from, to)))
      undecidable.push({ reason: `href in ${what}`, index: from });
  };
  let at = 0;
  while ((at = html.indexOf("<", at)) !== -1) {
    const other = skipped.find(({ start }) => {
      start.lastIndex = at;
      return start.test(html);
    });
    if (other) {
      const close = other.end
        ? html.indexOf(other.end, other.start.lastIndex)
        : -1;
      const next = !other.end
        ? other.start.lastIndex
        : close === -1
          ? html.length
          : close + other.end.length;
      skip(at, next, "a comment, processing instruction, declaration or CDATA");
      at = next;
      continue;
    }
    tagStart.lastIndex = at;
    const name = tagStart.exec(html)?.[1];
    if (name === undefined) {
      at += 1;
      continue;
    }
    const attributes = [];
    attribute.lastIndex = tagStart.lastIndex;
    let position = attribute.lastIndex;
    for (
      let match;
      (match = attribute.exec(html));
      position = attribute.lastIndex
    )
      attributes.push({
        match,
        valueAt: attribute.lastIndex - (match[2]?.length ?? 0),
      });
    tagEnd.lastIndex = position;
    if (!tagEnd.test(html)) {
      // 문법에 맞지 않는 태그를 브라우저는 태그로 읽을 수 있다. 그 뒤 글 어디까지가 태그인지 이 문법으로는 모른다.
      skip(at, html.length, "a tag outside the CommonMark grammar");
      at += 1;
      continue;
    }
    const named = attributes.filter(
      ({ match }) => match[1]?.toLowerCase() === "href"
    );
    if (named.length > 1)
      undecidable.push({ reason: "href given twice in one tag", index: at });
    else
      for (const { match, valueAt } of named) {
        const value = match[2];
        if (value === undefined) continue;
        const url = /^["']/.test(value) ? value.slice(1, -1) : value;
        if (url.includes("&"))
          undecidable.push({
            reason: "href value with a character reference (&)",
            index: at,
          });
        else hrefs.push({ url, index: valueAt });
      }
    at = tagEnd.lastIndex;
    if (rawTextElements.has(name.toLowerCase())) {
      // 같은 이름의 닫는 태그에서 끝난다: 이름 뒤가 공백·`/`·`>`여야 한다(`</script-other>`는 아니다).
      const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
      close.lastIndex = at;
      const end = close.exec(html)?.index ?? html.length;
      skip(at, end, `raw text of <${name}>`);
      at = end;
    }
  }
  return { hrefs, undecidable };
}

/**
 * 트리 안의 링크 대상과 그 줄: 인라인 링크·이미지, 자동 링크(`<…>`, GFM의 맨 주소), 참조식 링크 정의(`[이름]: 대상`),
 * raw HTML 여는 태그의 `href`. 참조식 링크(`[글][이름]`)는 그 정의로 센다. raw HTML에서 대상을 판정할 수 없는 곳은 `undecidable`로
 * 따로 낸다. 호출자는 그것을 실패로 다룬다.
 * @returns {{ links: { url: string, line: number }[], undecidable: { reason: string, line: number }[] }}
 */
export function linkTargets(tree) {
  const links = [];
  const undecidable = [];
  visit(tree, (node) => {
    if (["link", "image", "definition"].includes(node.type))
      links.push({ url: node.url, line: node.position.start.line });
    else if (node.type === "html") {
      const lineOf = (index) =>
        node.position.start.line +
        (node.value.slice(0, index).match(/\n/g) ?? []).length;
      const found = htmlHrefs(node.value);
      for (const { url, index } of found.hrefs)
        links.push({ url, line: lineOf(index) });
      for (const { reason, index } of found.undecidable)
        undecidable.push({ reason, line: lineOf(index) });
    }
  });
  return { links, undecidable };
}
