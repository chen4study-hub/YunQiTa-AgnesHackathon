import { it, expect } from "vitest";
import { acceptedEncodings } from "../scripts/previewCompression";

it("prefers Brotli at equal quality, supports gzip and never compresses without consent", () => {
  expect(acceptedEncodings("gzip, deflate, br")).toEqual(["br", "gzip"]);
  expect(acceptedEncodings("gzip")).toEqual(["gzip"]);
  expect(acceptedEncodings(undefined)).toEqual([]);
  expect(acceptedEncodings("identity")).toEqual([]);
});
it("respects quality and explicit exclusions over wildcards", () => {
  expect(acceptedEncodings("gzip;q=1, br;q=0.5")).toEqual(["gzip", "br"]);
  expect(acceptedEncodings("br;q=0, gzip;q=0.8")).toEqual(["gzip"]);
  expect(acceptedEncodings("*;q=0.8, br;q=0")).toEqual(["gzip"]);
  expect(acceptedEncodings("BR; Q=1, gzip;q=0")).toEqual(["br"]);
  expect(acceptedEncodings("br;q=oops, gzip;q=2")).toEqual([]);
});
