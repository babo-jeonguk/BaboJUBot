import type { ComponentProps, HTMLAttributes, ReactNode, Ref } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import "./markdown.css";

/*
 * 에이전트·사용자가 쓴 긴 글(산출물·자기 보고·댓글·대화·계획·Role·Soul·Skill 사본 등)을 읽기 좋게 보여 준다.
 * 편집 폼은 이 컴포넌트를 쓰지 않고 원문을 그대로 textarea에 둔다.
 *
 * 안전: 모델 출력의 HTML은 그리지 않는다. react-markdown은 rehype-raw 없이 HTML을 글자로 남기고,
 * 기본 urlTransform이 http(s)·mailto 등 안전한 protocol 밖의 주소(javascript: 등)를 비운다.
 * 바깥 이미지는 자동으로 불러오지 않고 링크로 보인다.
 */

// "1~3개"처럼 물결표 하나로 범위를 적는 글이 취소선이 되지 않게 `~~`만 취소선으로 본다.
const remarkPlugins = [
  [remarkGfm, { singleTilde: false }],
  remarkBreaks,
] satisfies ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

const external = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  // urlTransform이 막은 주소는 빈 값이 된다. 누를 곳 없는 글자로 남긴다.
  if (!href) return <span className="md-dead-link">{children}</span>;
  return external(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <a href={href}>{children}</a>
  );
}

/**
 * 글 속 제목은 화면 제목(h1)·구역 제목(h2) 아래에 놓이도록 두 단계 내려 그린다(# → h3, ## → h4 …, 최대 h6).
 * 보이는 크기는 원래 단계를 따른다.
 */
const headingTags = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;
const headings = Object.fromEntries(
  headingTags.map((Tag, i) => [
    `h${i + 1}`,
    ({ children }: { children?: ReactNode }) => (
      <Tag className={`md-h${Math.min(i + 1, 4)}`}>{children}</Tag>
    ),
  ])
) as Components;

const components: Components = {
  ...headings,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ src, alt }) => (
    <SafeLink href={typeof src === "string" ? src : undefined}>
      {alt || (typeof src === "string" ? src : "이미지")}
    </SafeLink>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/** 문서 맨 앞 YAML frontmatter(SKILL.md의 name·description)는 제목으로 잘못 읽히지 않게 코드 블록으로 보인다. */
function frontmatterAsCode(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? `\`\`\`yaml\n${m[1]}\n\`\`\`\n\n${text.slice(m[0].length)}` : text;
}

/** GFM Markdown 보기. `tone="inverse"`는 진한 바탕(내 대화 말풍선) 위의 글이다. */
export function Markdown({
  text,
  tone = "default",
  className = "",
  ...rest
}: {
  text: string;
  tone?: "default" | "inverse";
  ref?: Ref<HTMLDivElement>;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={["md", tone === "inverse" && "md-inverse", className]
        .filter(Boolean)
        .join(" ")}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {frontmatterAsCode(text)}
      </ReactMarkdown>
    </div>
  );
}
