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

// raw HTML은 읽지 않는다. 브라우저는 HTML 문법으로 읽고, 그 문법을 손으로 흉내 내면 다르게 읽는 곳(같은 이름 속성, 문자 참조,
// `--!>` 주석, NBSP)이 남는다. raw HTML 글에 `href`(대소문자 무관)가 있으면 그 자리는 판정할 수 없음이다. 링크는 Markdown으로 쓴다.
const hrefText = /href/gi;

/**
 * 트리 안의 링크 대상과 그 줄: 인라인 링크·이미지, 자동 링크(`<…>`, GFM의 맨 주소), 참조식 링크 정의(`[이름]: 대상`).
 * 참조식 링크(`[글][이름]`)는 그 정의로 센다. raw HTML 글의 `href`는 `undecidable`로 따로 낸다. 호출자는 그것을 실패로 다룬다.
 * @returns {{ links: { url: string, line: number }[], undecidable: { reason: string, line: number }[] }}
 */
export function linkTargets(tree) {
  const links = [];
  const undecidable = [];
  visit(tree, (node) => {
    if (["link", "image", "definition"].includes(node.type))
      links.push({ url: node.url, line: node.position.start.line });
    else if (node.type === "html")
      for (const { index } of node.value.matchAll(hrefText))
        undecidable.push({
          reason: "href in raw HTML (write the link in Markdown)",
          line:
            node.position.start.line +
            (node.value.slice(0, index).match(/\n/g) ?? []).length,
        });
  });
  return { links, undecidable };
}
