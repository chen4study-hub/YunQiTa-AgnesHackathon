import type { ReactNode } from "react";

/** Keep each number/unit together with a real NBSP for copying and assistive text. */
export function quantityText(
  text: string,
  keyPrefix = "quantity",
): ReactNode[] {
  const pattern =
    /(?<![\w.])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[ \t\u00a0\u202f]+(?:元\/kWh|m³\/h|kWh|kW|°C|ppm|ms|元|%|s)(?![A-Za-z0-9³/])/gu;
  const nodes: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) nodes.push(text.slice(end, match.index));
    nodes.push(
      <span
        className="agent-answer-quantity"
        key={`${keyPrefix}-${match.index}`}
      >
        {match[0].replace(/[ \t\u00a0\u202f]+/u, "\u00a0")}
      </span>,
    );
    end = match.index + match[0].length;
  }
  if (end < text.length) nodes.push(text.slice(end));
  return nodes;
}
