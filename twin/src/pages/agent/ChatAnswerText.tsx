/** Safe inline sources remain in the sentence as well as a deduplicated source list. */
import {
  ChatMarkdown,
  safeSourceUrl,
  inlineLinkAt,
  markdownInline,
} from "./ChatMarkdown";
export { safeSourceUrl } from "./ChatMarkdown";
export function ChatAnswerText({
  text,
  displayText = (s) => s,
}: {
  text: string;
  displayText?: (text: string) => string;
}) {
  return <>{markdownInline(text, false, 0, displayText)}</>;
}
export function splitAnswerSources(text: string) {
  const sources: { href: string; label: string }[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end >= 0) {
        i = end + 1;
        continue;
      }
    }
    const link = inlineLinkAt(text, i);
    if (link) {
      if (
        safeSourceUrl(link.href) &&
        !sources.some((s) => s.href === link.href)
      )
        sources.push({ href: link.href, label: link.label });
      i += link.raw.length;
    } else i++;
  }
  return { body: text, sources };
}
export function ChatReply({
  text,
  pending = false,
  needsHuman = false,
  terminated = false,
  category,
  displayText = (s) => s,
}: {
  text: string;
  pending?: boolean;
  needsHuman?: boolean;
  terminated?: boolean;
  category?: string;
  displayText?: (text: string) => string;
}) {
  const { body, sources } = splitAnswerSources(text);
  const terminationLabel =
    category === "politics"
      ? "涉政"
      : category === "current_affairs"
        ? "时事"
        : undefined;
  return (
    <>
      {terminated && terminationLabel && (
        <small className="agent-answer-category">{terminationLabel}</small>
      )}
      <div className="agent-answer-text">
        <ChatMarkdown text={body} pending={pending} displayText={displayText} />
      </div>
      {needsHuman && !pending && (
        <small className="agent-answer-review">需值班人员复核</small>
      )}
      {sources.length > 0 && (
        <ul className="agent-answer-sources" aria-label="回答来源">
          {sources.map((s) => (
            <li key={s.href}>
              <a href={s.href} target="_blank" rel="noreferrer">
                {s.label === s.href ? s.label : displayText(s.label)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
