import { expect, it } from "vitest";
import { normalizeEol } from "./normalize-eol.mjs";

it("normalizes only CRLF, preserving isolated CR, BOM, whitespace and binary bytes", () => {
  const source = Buffer.from([
    239, 187, 191, 65, 13, 10, 32, 9, 13, 66, 255, 0, 13, 10, 13,
  ]);
  const before = Buffer.from(source);
  const expected = Buffer.from([
    239, 187, 191, 65, 10, 32, 9, 13, 66, 255, 0, 10, 13,
  ]);
  const result = normalizeEol(source);
  expect(result.equals(expected)).toBe(true);
  expect(source.equals(before)).toBe(true);
  expect(normalizeEol(result).equals(expected)).toBe(true);
  expect(normalizeEol("A\r\n B\r").equals(Buffer.from("A\n B\r"))).toBe(true);
  expect(normalizeEol(Buffer.alloc(0))).toHaveLength(0);
});

it("still rejects changes other than CRLF vs LF", () => {
  const baseline = normalizeEol("A\r\n B\n");
  expect(baseline.equals(normalizeEol("A\n B\n"))).toBe(true);
  for (const changed of [
    "A\nB\n",
    "a\n B\n",
    "A\n B",
    "A\r B\n",
    "\uFEFFA\n B\n",
  ])
    expect(baseline.equals(normalizeEol(changed))).toBe(false);
});
