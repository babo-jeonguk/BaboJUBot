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

/**
 * 트리 안의 링크 대상과 그 줄: 인라인 링크·이미지, 자동 링크(`<…>`, GFM의 맨 주소), 참조식 링크 정의(`[이름]: 대상`),
 * raw HTML의 `href`. 참조식 링크(`[글][이름]`)는 그 정의로 센다.
 * @returns {{ url: string, line: number }[]}
 */
export function linkTargets(tree) {
  const targets = [];
  visit(tree, (node) => {
    if (["link", "image", "definition"].includes(node.type))
      targets.push({ url: node.url, line: node.position.start.line });
    else if (node.type === "html") {
      const lines = node.value.split("\n");
      lines.forEach((text, offset) => {
        for (const match of text.matchAll(/href=["']([^"']+)["']/gi))
          targets.push({
            url: match[1],
            line: node.position.start.line + offset,
          });
      });
    }
  });
  return targets;
}
