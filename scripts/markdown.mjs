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

/** HTML 글의 여는 태그에서 `href` 속성 값과 그 글 안 위치(첫 글자 위치). */
function htmlHrefs(html) {
  const found = [];
  let at = 0;
  while ((at = html.indexOf("<", at)) !== -1) {
    const skip = skipped.find(({ start }) => {
      start.lastIndex = at;
      return start.test(html);
    });
    if (skip) {
      const close = skip.end
        ? html.indexOf(skip.end, skip.start.lastIndex)
        : -1;
      if (!skip.end) at = skip.start.lastIndex;
      else at = close === -1 ? html.length : close + skip.end.length;
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
      at += 1;
      continue;
    }
    for (const { match, valueAt } of attributes) {
      const value = match[2];
      if (match[1]?.toLowerCase() !== "href" || value === undefined) continue;
      const quoted = /^["']/.test(value);
      found.push({
        url: quoted ? value.slice(1, -1) : value,
        index: valueAt,
      });
    }
    at = tagEnd.lastIndex;
    if (rawTextElements.has(name.toLowerCase())) {
      const close = html.toLowerCase().indexOf(`</${name.toLowerCase()}`, at);
      at = close === -1 ? html.length : close;
    }
  }
  return found;
}

/**
 * 트리 안의 링크 대상과 그 줄: 인라인 링크·이미지, 자동 링크(`<…>`, GFM의 맨 주소), 참조식 링크 정의(`[이름]: 대상`),
 * raw HTML 여는 태그의 `href`. 참조식 링크(`[글][이름]`)는 그 정의로 센다.
 * @returns {{ url: string, line: number }[]}
 */
export function linkTargets(tree) {
  const targets = [];
  visit(tree, (node) => {
    if (["link", "image", "definition"].includes(node.type))
      targets.push({ url: node.url, line: node.position.start.line });
    else if (node.type === "html")
      for (const { url, index } of htmlHrefs(node.value))
        targets.push({
          url,
          line:
            node.position.start.line +
            (node.value.slice(0, index).match(/\n/g) ?? []).length,
        });
  });
  return targets;
}
