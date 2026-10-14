import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChatAnswerText,
  safeSourceUrl,
  ChatReply,
  splitAnswerSources,
} from "../src/pages/agent/ChatAnswerText";
import { eventLine } from "../src/pages/agent/chat-stream";
it("validates done reason without breaking legacy or accepting unknown enum values", () => {
  for (const reason of ["out_of_scope", "no_data", "answered"])
    expect(
      eventLine(
        JSON.stringify({
          type: "done",
          known: false,
          grounded: true,
          needs_human: false,
          reason,
        }),
      ),
    ).toMatchObject({ reason });
  for (const reason of [undefined, "bogus", {}, null])
    expect(
      eventLine(JSON.stringify({ type: "done", known: false, reason })),
    ).not.toHaveProperty("reason");
});
it("renders markdown, bare and parenthesized sources as safe new-window links; preserves URL bytes", () => {
  const url = "https://example.com/2017-01-01?q=演示&x=1";
  const html = renderToStaticMarkup(
    <ChatAnswerText
      text={`来源：[官方来源](${url})；另见 https://example.org/report。 (https://example.net/test).`}
      displayText={(s) => s.replace("演示", "展示")}
    />,
  );
  expect(html.match(/target="_blank" rel="noreferrer"/g)).toHaveLength(3);
  expect(html).toContain(
    'href="https://example.com/2017-01-01?q=演示&amp;x=1"',
  );
  expect(html).toContain(">官方来源</a>");
  expect(html).toContain('href="https://example.net/test"');
  expect(html).toContain('href="https://example.org/report"');
});
it("never renders backend HTML, javascript/data URLs or credentialed links", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>",
    "https://user:password@example.com",
    "/local",
  ])
    expect(safeSourceUrl(url)).toBe(false);
  const html = renderToStaticMarkup(
    <ChatAnswerText
      text={
        "<img src=x onerror=alert(1)> [危险](javascript:alert(1)) https://user:pass@example.com"
      }
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html).toContain("&lt;img");
});

it("sources are deduplicated beneath the answer; unsafe strings cannot become links", () => {
  const text =
    "联网回答。[官网](https://example.com?q=1) https://example.com?q=1 https://user:pass@example.com";
  const { body, sources } = splitAnswerSources(text);
  expect(sources).toEqual([{ href: "https://example.com?q=1", label: "官网" }]);
  expect(body).toContain("联网回答。");
  expect(body).toContain("https://user:pass@example.com");
  const html = renderToStaticMarkup(<ChatReply text={text} />);
  expect(html.indexOf('aria-label="回答来源"')).toBeGreaterThan(
    html.indexOf("</div>"),
  );
  expect(body).toBe(text);
  expect(html.match(/<a /g)).toHaveLength(3);
});

it.each([
  [
    "您可以访问 https://example.com/report 或上述API链接查看",
    "https://example.com/report",
    "https://example.com/report",
  ],
  [
    "您可以访问（https://example.com/report）或上述API链接查看",
    "https://example.com/report",
    "https://example.com/report",
  ],
  [
    "您可以访问[官网](https://example.com/report)或上述API链接查看",
    "https://example.com/report",
    "官网",
  ],
  [
    "您可以访问[报告](https://example.com/report_(2026)?q=1)或上述API链接查看",
    "https://example.com/report_(2026)?q=1",
    "报告",
  ],
])(
  "keeps a clickable inline source in the sentence: %s",
  (text, href, label) => {
    for (const Component of [ChatAnswerText, ChatReply]) {
      const html = renderToStaticMarkup(<Component text={text} />);
      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(`>${label}</a>`);
      expect(html).toMatch(/访问\s*(?:（)?<a /);
      expect(html).toContain("或上述API链接查看");
      expect(html).not.toContain("访问 或");
      expect(html).not.toContain(`${href}）"`);
    }
  },
);
it("full-width brackets and adjacent punctuation stay outside href, unsafe/code/HTML remain inert, display mapping never rewrites href", () => {
  const url = "https://example.com/2017-01-01?q=演示&x=1";
  const html = renderToStaticMarkup(
    <ChatReply
      text={`您可以访问（${url}），或者[官网](${url})。`}
      displayText={(s) =>
        s.replaceAll("演示", "展示").replaceAll("2017-01-01", "2026-10-12")
      }
    />,
  );
  expect(
    html.match(/href="https:\/\/example.com\/2017-01-01\?q=演示&amp;x=1"/g),
  ).toHaveLength(3);
  expect(html).toContain("（<a ");
  expect(html).toContain("</a>），或者");
  const code = renderToStaticMarkup(
    <ChatReply
      text={
        "`https://example.com` [危险](javascript:alert(1)) [密码](https://user:pass@example.com) <img src=x onerror=alert(1)>"
      }
    />,
  );
  expect(code).not.toContain("<a ");
  expect(code).not.toContain("<img");
});

it("streamed markdown links remain visible before closing delimiters and settle into inline anchors", () => {
  for (const text of [
    "您可以访问[官网](https://example.com/re",
    "您可以访问（https://example.com/report）",
  ]) {
    const html = renderToStaticMarkup(<ChatReply text={text} pending />);
    expect(html).toContain("访问");
    expect(html).toContain("https://example.com/");
  }
  const html = renderToStaticMarkup(
    <ChatReply
      text="您可以访问[官网](https://example.com/report)或上述API链接查看"
      pending
    />,
  );
  expect(html).toContain(">官网</a>或上述API链接查看");
});
