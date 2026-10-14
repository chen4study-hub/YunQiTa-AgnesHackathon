import type { ReactNode } from "react";
import { quantityText } from "./ChatQuantity";
export function safeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
/** One scanner for inline rendering and the source list. Preserve href bytes. */
export function inlineLinkAt(
  text: string,
  index: number,
): { raw: string; href: string; label: string } | null {
  const tail = text.slice(index);
  if (tail[0] === "[") {
    const label = /^\[([^\]\n]+)\]\(/.exec(tail);
    if (label) {
      let end = label[0].length,
        level = 1;
      for (; end < tail.length; end++) {
        if (tail[end] === "(") level++;
        if (tail[end] === ")" && --level === 0) break;
      }
      if (level === 0) {
        const href = tail.slice(label[0].length, end);
        if (!/\s|[<>]/.test(href))
          return { raw: tail.slice(0, end + 1), href, label: label[1] };
      }
    }
  }
  const bare = /^https?:\/\/[^\s<>"'\[\]（）【】，。！？；、：]+/.exec(tail);
  if (!bare) return null;
  let href = bare[0].replace(/[.,;:!?]+$/, "");
  while (
    href.endsWith(")") &&
    (href.match(/\)/g)?.length ?? 0) > (href.match(/\(/g)?.length ?? 0)
  )
    href = href.slice(0, -1);
  return { raw: href, href, label: href };
}
/** Deliberately small Markdown grammar. HTML stays a React text node; no HTML parser. */
export function markdownInline(
  text: string,
  pending = false,
  depth = 0,
  displayText: (s: string) => string = (s) => s,
): ReactNode[] {
  if (depth > 8) return quantityText(displayText(text), `depth-${depth}`);
  const nodes: ReactNode[] = [];
  let plain = "",
    i = 0;
  const flush = () => {
    if (plain) {
      nodes.push(...quantityText(displayText(plain), `plain-${i}`));
      plain = "";
    }
  };
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      flush();
      if (end >= 0) {
        nodes.push(
          <code key={i}>
            {quantityText(displayText(text.slice(i + 1, end)))}
          </code>,
        );
        i = end + 1;
        continue;
      }
      if (pending) {
        nodes.push(
          <code key={i}>{quantityText(displayText(text.slice(i + 1)))}</code>,
        );
        break;
      }
    }
    const link = inlineLinkAt(text, i);
    if (link) {
      flush();
      nodes.push(
        safeSourceUrl(link.href) ? (
          <a key={i} href={link.href} target="_blank" rel="noreferrer">
            {link.label === link.href
              ? link.label
              : markdownInline(link.label, pending, depth + 1, displayText)}
          </a>
        ) : (
          displayText(link.raw)
        ),
      );
      i += link.raw.length;
      continue;
    }
    const marker = text.startsWith("**", i)
      ? "**"
      : text[i] === "*"
        ? "*"
        : null;
    if (marker) {
      const end = text.indexOf(marker, i + marker.length);
      flush();
      if (end >= 0) {
        const children = markdownInline(
          text.slice(i + marker.length, end),
          pending,
          depth + 1,
          displayText,
        );
        nodes.push(
          marker === "**" ? (
            <strong key={i}>{children}</strong>
          ) : (
            <em key={i}>{children}</em>
          ),
        );
        i = end + marker.length;
        continue;
      }
      if (pending) {
        const children = markdownInline(
          text.slice(i + marker.length),
          true,
          depth + 1,
          displayText,
        );
        nodes.push(
          marker === "**" ? (
            <strong key={i}>{children}</strong>
          ) : (
            <em key={i}>{children}</em>
          ),
        );
        break;
      }
    }
    plain += text[i++];
  }
  flush();
  return nodes;
}
export function ChatMarkdown({
  text,
  pending = false,
  displayText = (s) => s,
}: {
  text: string;
  pending?: boolean;
  displayText?: (s: string) => string;
}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"),
    blocks: ReactNode[] = [];
  let i = 0;
  const ordered = (s: string) => /^\s{0,3}(\d+)\.\s+(.*)$/.exec(s),
    unordered = (s: string) => /^\s{0,3}[-+*]\s+(.*)$/.exec(s);
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const first = ordered(lines[i]),
      bullet = unordered(lines[i]);
    if (first || bullet) {
      const key = i,
        items: ReactNode[] = [];
      while (i < lines.length) {
        const match = first ? ordered(lines[i]) : unordered(lines[i]);
        if (!match) break;
        items.push(
          <li key={i}>
            {markdownInline(match[first ? 2 : 1], pending, 0, displayText)}
          </li>,
        );
        i++;
      }
      blocks.push(
        first ? (
          <ol key={key} start={Number(first[1])}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        ),
      );
      continue;
    }
    const key = i,
      paragraph: ReactNode[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !ordered(lines[i]) &&
      !unordered(lines[i])
    ) {
      if (paragraph.length) paragraph.push(<br key={`br-${i}`} />);
      paragraph.push(...markdownInline(lines[i], pending, 0, displayText));
      i++;
    }
    blocks.push(<p key={key}>{paragraph}</p>);
  }
  return <>{blocks}</>;
}
