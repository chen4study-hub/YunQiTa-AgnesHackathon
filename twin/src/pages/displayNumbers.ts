import { formatNumber } from "../ui/numberFormat";

export type PageNumberKind =
  "number" | "integer" | "decimal" | "percent" | "milliseconds";
/** Presentation only: keep source numbers/payloads intact; tables share this policy. */
export function formatPageNumber(
  value: number,
  kind: PageNumberKind = "number",
  useGrouping = true,
): string {
  if (!Number.isFinite(value)) return "—";
  const digits =
    kind === "integer" || (kind === "milliseconds" && Math.abs(value) >= 10)
      ? 0
      : 1;
  const text = formatNumber(
    kind === "percent" ? value * 100 : value,
    digits,
    useGrouping,
  );
  if (kind === "percent") return `${text}%`;
  if (kind === "milliseconds") return `${text} ms`;
  // Physical/cost values keep the same one-decimal precision, including .0.
  // Counts and discrete IDs explicitly request integer instead.
  return text;
}
