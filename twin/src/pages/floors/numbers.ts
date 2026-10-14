import { formatNumber } from "../../ui/numberFormat";

/** Display only: source readings stay unrounded; requested decimals include .0. */
export function floorsNumber(value: number, digits = 0): string {
  return formatNumber(value, Math.max(0, Math.min(1, Math.trunc(digits))));
}
