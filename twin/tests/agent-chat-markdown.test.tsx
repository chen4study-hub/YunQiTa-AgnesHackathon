import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "../src/pages/agent/ChatMarkdown";
import { ChatReply } from "../src/pages/agent/ChatAnswerText";
it("renders bold, italic, ordered/unordered lists, paragraphs, linebreaks, code and emoji safely", () => {
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text={
        "**加粗**和*斜体* 🙂\n第二行\n\n1. 第一项\n2. 第二项\n\n- 项目\n- `代码`"
      }
    />,
  );
  for (const expected of [
    "<strong>加粗</strong>",
    "<em>斜体</em>",
    "🙂",
    "<br",
    '<ol start="1">',
    "<li>第一项</li>",
    "<ul>",
    "<code>代码</code>",
  ])
    expect(html).toContain(expected);
});
it("only HTTP(S) links open safely; malicious HTML and dangerous protocols remain escaped text", () => {
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text={
        "[官网](https://example.com) [恶意](javascript:alert(1)) <img src=x onerror=alert(1)> <script>alert(1)</script>"
      }
    />,
  );
  expect(html).toContain('target="_blank" rel="noreferrer"');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;img");
  expect(html.match(/<a /g)).toHaveLength(1);
});
it("unclosed streamed bold markers do not show as asterisks and settle into the same markup", () => {
  for (const text of ["**", "**正在", "**正在组织*"])
    expect(
      renderToStaticMarkup(<ChatMarkdown text={text} pending />),
    ).not.toContain("*");
  expect(
    renderToStaticMarkup(<ChatMarkdown text="**完成**" pending />),
  ).toContain("<strong>完成</strong>");
  const final = renderToStaticMarkup(
    <ChatReply text={"**答复**\n1. 项目\n\n[官网](https://example.com)"} />,
  );
  expect(final).toContain("<strong>答复</strong>");
  expect(final).toContain('aria-label="回答来源"');
});
